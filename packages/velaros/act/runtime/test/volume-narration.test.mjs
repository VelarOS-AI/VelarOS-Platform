import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createContextInvocationJournal } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { modelRequestEncoder } from '@velaros-ai/kernel'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { ActiveContext } from '../../../dist/act/runtime/impl/ActiveContext.js'
import { ContextMaintenance } from '../../../dist/act/runtime/impl/ContextMaintenance.js'
import { ContextMemory } from '../../../dist/act/runtime/impl/ContextMemory.js'
import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { RecentContext } from '../../../dist/act/runtime/impl/RecentContext.js'
import { RuntimeTrace } from '../../../dist/act/runtime/impl/RuntimeTrace.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'
import {
  volumeNarrationFormat,
  volumeNarrationPatch,
} from '../../../dist/act/runtime/utils/volume-narration.js'
import { VelarContextMaterialsModule } from '../../../dist/act/system/contract/surface.js'
import { ContextMaintenanceState } from '../../../dist/act/system/impl/ContextMaintenanceState.js'

const signal = new AbortController().signal
async function fixture(
  t,
  respond,
  inputBody = 'Change the serializer; preserve the public API.',
  profile,
  observeDelta
) {
  const storage = localContextStorage({ path: ':memory:' })
  const runtime = await createRuntime({ storage, runner: nodeSubprocessCodeRunner, modules: [] })
  t.after(() => runtime.close())
  const session = await runtime.openSession('root')
  const input = await session.context.append({
    kind: 'user',
    body: inputBody,
  })
  await session.view.begin(input.ref)
  const result = await session.context.append({
    kind: 'audit',
    title: 'script:12345678:result',
    body: JSON.stringify({
      process: { exitCode: 1, stdout: 'Test failed: escaped separator', stderr: '' },
    }),
  })
  const response = await session.context.append({
    kind: 'assistant',
    body: 'The separator is still incorrect. Fix it and run tests again.',
  })
  const recent = new RecentContext('root', session.context, storage)
  const volume = await recent.seal(input.sequence, response.sequence, signal)
  const requests = []
  const usage = []
  const reservations = []
  let opened = 0
  let closed = 0
  let queued = 0
  const model = {
    id: 'offline-volume-narration',
    limits: { inputTokens: 32000, contextTokens: 48000, outputTokens: 8192 },
    estimate: async (request) => ({
      tokens: Math.ceil(
        (JSON.stringify(modelRequestEncoder.messages(request)).length +
          request.instructions.length +
          JSON.stringify(request.response).length) /
          3
      ),
      precision: 'estimate',
      basis: 'offline',
    }),
    async *stream(request, requestSignal) {
      requests.push(request)
      yield* respond(request, requestSignal)
    },
  }
  const maintenance = new ContextMaintenance({
    storage,
    options: profile ? { profile } : undefined,
    preview: () => undefined,
    model: () => model,
    tools: {
      async begin(_id, _parent, _kind, _timeout, activationSignal) {
        return {
          binding: { deadline: Date.now() + 600000 },
          signal: activationSignal,
          budget: {
            reserveModel: async (_, tokens) => reservations.push(tokens),
            releaseModel: async (_, tokens) => reservations.push(-tokens),
            recordUsage: async (input, output) => usage.push([input, output]),
          },
          close: async () => closed++,
        }
      },
      model: (_, driver) => ({
        id: driver.id,
        limits: driver.limits,
        estimate: (request) => driver.estimate(request),
        async *stream(request, signal) {
          queued++
          for await (const delta of driver.stream(request, signal)) {
            observeDelta?.(delta)
            yield delta
          }
        },
      }),
      deliver: async (_, id, kind, payload) => ({ sessionId: id, kind, payload }),
    },
    open: async () => {
      opened++
      throw new Error('Interactive fallback requested')
    },
    close: async () => {},
  })
  return {
    storage,
    session,
    recent,
    input,
    result,
    response,
    volume,
    maintenance,
    model,
    requests,
    usage,
    reservations,
    opened: () => opened,
    closed: () => closed,
    queued: () => queued,
  }
}

async function* complete() {
  yield {
    type: 'text',
    text: JSON.stringify({
      summary: 'The separator test failed; the fix is still pending.',
      unresolved: ['Correct the separator and run tests'],
      negativeAttempts: ['The current escaping failed the separator test'],
    }),
  }
  yield { type: 'usage', inputTokens: 1200, outputTokens: 80 }
  yield { type: 'finish', reason: 'stop' }
}

test('INV-53 automatic narration publishes a complete sealed volume in one bounded call without opening an interactive agent', async (t) => {
  const f = await fixture(t, complete)
  assert.equal(
    await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 12000 }, signal),
    true,
    JSON.stringify(await f.maintenance.status('root', signal))
  )
  assert.equal(f.opened(), 0)
  assert.equal(f.requests.length, 1)
  assert.equal(f.queued(), 1)
  assert.equal(f.closed(), 1)
  assert.deepEqual(f.usage, [[1200, 80]])
  assert.equal(f.reservations.length, 3)
  assert.equal(f.reservations[0], -f.reservations[2], 'unused finalization reserve is returned')
  assert(f.reservations[1] > 0, 'the dispatched call remains charged to the parent budget')
  assert.equal(f.requests[0].response.type, 'json')
  assert.equal(f.requests[0].mode, 'maintenance')
  assert.match(JSON.stringify(f.requests[0].materials), /Test failed: escaped separator/)
  assert.match(JSON.stringify(f.requests[0].materials), /preserve the public API/)
  const narrative = (await f.recent.volumes(signal)).at(-1).narrative
  assert.equal(narrative.summary, 'The separator test failed; the fix is still pending.')
  assert.deepEqual(
    new Set(narrative.evidence.map((r) => r.id)),
    new Set([f.input.ref.id, f.result.ref.id, f.response.ref.id])
  )
  assert.equal((await f.storage.load('root')).inputSummaries?.length ?? 0, 0)
  const trace = await new RuntimeTrace(
    f.requests[0].cacheKey,
    f.storage,
    createContextInvocationJournal(f.storage)
  ).page()
  assert.equal(trace.turns.length, 1)
  assert.equal(trace.turns[0].modelAccounting.outcome, 'accepted')
  assert.deepEqual(trace.accounting.modelRequests, { known: 1, unknown: 0, inflight: 0 })
  assert.equal(trace.turns[0].modelAccounting.usage.inputTokens, 1200)
})

test('automatic narration falls back before dispatch when the complete evidence does not fit', async (t) => {
  const f = await fixture(t, complete)
  f.model.limits.inputTokens = 1
  assert.equal(
    await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 12000 }, signal),
    false
  )
  assert.equal(f.requests.length, 0)
  assert.equal(f.opened(), 1)
  assert.equal((await f.recent.volumes(signal)).at(-1).narrative, undefined)
})

test('automatic narration joins full pages and never presents later work as part of the sealed volume', async (t) => {
  const f = await fixture(t, complete)
  const body = 'Known original result\n'.repeat(1900)
  const record = await f.session.context.append({ kind: 'assistant', body })
  await f.recent.seal(f.response.sequence, record.sequence, signal)
  await f.session.context.append({
    kind: 'assistant',
    body: 'LATER_WORK_MUST_REMAIN_OUTSIDE_THIS_VOLUME',
  })
  assert.equal(
    await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 12000 }, signal),
    true
  )
  const material = JSON.parse(f.requests[0].materials[0].text)
  assert.equal(material.records.find((item) => item.ref.id === record.ref.id).text, body)
  assert.doesNotMatch(f.requests[0].materials[0].text, /LATER_WORK_MUST_REMAIN_OUTSIDE/)
})

test('oversized raw material takes the interactive path without a paid partial summary', async (t) => {
  const f = await fixture(t, complete)
  const record = await f.session.context.append({ kind: 'assistant', body: 'large'.repeat(15000) })
  await f.recent.seal(f.response.sequence, record.sequence, signal)
  assert.equal(
    await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 12000 }, signal),
    false
  )
  assert.equal(f.requests.length, 0)
  assert.equal(f.opened(), 1)
})

for (const kind of [
  'truncated',
  'unfinished',
  'tool-call',
  'extra-fields',
  'malformed',
  'late-content',
  'duplicate-output',
])
  test(`automatic narration rejects ${kind} responses without publishing partial metadata`, async (t) => {
    const value = { summary: 'Unaccepted response', unresolved: [], negativeAttempts: [] }
    const f = await fixture(t, async function* () {
      if (kind === 'extra-fields') value.inputs = []
      yield { type: 'text', text: kind === 'malformed' ? '{' : JSON.stringify(value) }
      yield { type: 'usage', inputTokens: 1200, outputTokens: 80 }
      if (kind === 'tool-call')
        yield {
          type: 'tool-call',
          value: { id: 'bad', name: 'shell', input: { code: 'unexpected' } },
        }
      if (kind === 'duplicate-output') {
        yield { type: 'output', value }
        yield { type: 'output', value }
      }
      if (kind !== 'unfinished')
        yield { type: 'finish', reason: kind === 'truncated' ? 'length' : 'stop' }
      if (kind === 'late-content') yield { type: 'text', text: 'unexpected tail' }
    })
    assert.equal(
      await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 12000 }, signal),
      false
    )
    assert.equal(f.requests.length, 1)
    assert.equal(f.opened(), 0)
    assert.equal(f.closed(), 1)
    assert.deepEqual(f.usage, [[1200, 80]])
    assert.equal((await f.recent.volumes(signal)).at(-1).narrative, undefined)
    assert(
      !(await f.storage.load('root')).records.some(
        (record) => record.title === 'context:projection-policy'
      )
    )
    const trace = await new RuntimeTrace(
      f.requests[0].cacheKey,
      f.storage,
      createContextInvocationJournal(f.storage)
    ).page()
    assert.equal(trace.turns[0].modelAccounting.outcome, 'rejected')
    assert.equal(trace.turns[0].modelAccounting.usage.inputTokens, 1200)
  })

test('missing narration usage remains unknown in the shared trace even after successful publication', async (t) => {
  const f = await fixture(t, async function* () {
    yield {
      type: 'output',
      value: { summary: 'An unpriced summary.', unresolved: [], negativeAttempts: [] },
    }
    yield { type: 'finish', reason: 'stop' }
  })
  assert.equal(
    await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 12000 }, signal),
    true
  )
  const trace = await new RuntimeTrace(
    f.requests[0].cacheKey,
    f.storage,
    createContextInvocationJournal(f.storage)
  ).page()
  assert.equal(trace.turns[0].modelAccounting.outcome, 'accepted')
  assert.deepEqual(trace.accounting.modelRequests, { known: 0, unknown: 1, inflight: 0 })
  assert.equal(trace.turns[0].modelAccounting.usage.inputTokens, null)
})

test('a new parent input during narration invalidates publication even after a complete response', async (t) => {
  const f = await fixture(t, async function* () {
    await f.session.context.append({
      kind: 'user',
      body: 'Keep the current serializer unchanged; only report the issue.',
    })
    yield* complete()
  })
  await assert.rejects(
    f.maintenance.maintain('root', { reason: 'narrate', targetChars: 12000 }, signal),
    { code: 'STALE_VIEW' }
  )
  assert.equal((await f.recent.volumes(signal)).at(-1).narrative, undefined)
  assert.equal(f.closed(), 1)
})

test('cancelling a stalled summary estimate returns promptly and a late estimate cannot dispatch', async (t) => {
  const f = await fixture(t, complete)
  const entered = Promise.withResolvers()
  const late = Promise.withResolvers()
  f.model.estimate = () => {
    entered.resolve()
    return late.promise
  }
  const controller = new AbortController()
  const pending = f.maintenance.maintain(
    'root',
    { reason: 'narrate', targetChars: 12000 },
    controller.signal
  )
  await entered.promise
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  late.resolve({ tokens: 1, precision: 'exact', basis: 'late' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.requests.length, 0)
  assert.equal(f.closed(), 1)
  assert.equal((await f.recent.volumes(signal)).at(-1).narrative, undefined)
})

test('narration projects the generated contracts and keeps per-volume findings separate from current state', () => {
  const response = volumeNarrationFormat(VelarContextMaterialsModule.operations.submit.input)
  assert.deepEqual(Object.keys(response.schema.properties), [
    'summary',
    'unresolved',
    'negativeAttempts',
    'active',
  ])
  assert.deepEqual(response.schema.required, ['summary', 'unresolved', 'negativeAttempts'])
  assert.deepEqual(response.schema.properties.unresolved, {
    type: 'array',
    items: { type: 'string' },
  })
  const result = volumeNarrationPatch(
    { baseRevision: 'v1', ledgers: { unresolved: ['Still investigate the data loss'] } },
    {
      summary: 'Validated a parser fix.',
      unresolved: ['Run integration tests'],
      negativeAttempts: [],
    },
    []
  )
  assert.deepEqual(result.volume.unresolved, ['Run integration tests'])
  assert.deepEqual(Object.keys(result), ['baseRevision', 'summary', 'unresolved', 'volume'])
  const active = response.schema.properties.active
  assert.deepEqual(Object.keys(active.properties), ['changes'])
  assert.deepEqual(active.required, ['changes'])
  assert.deepEqual(Object.keys(active.properties.changes.items.properties), ['id', 'evidence'])
  assert.deepEqual(
    Object.keys(active.properties.changes.items.properties.evidence.items.properties),
    ['ref', 'quote']
  )
})

async function nextVolume(f, unresolved, body = 'PASS Ω: serializer round-trip', kind = 'audit') {
  await f.recent.narrate(
    f.volume,
    {
      summary: 'Earlier work still needed verification.',
      unresolved,
      negativeAttempts: [],
      evidence: [f.result.ref],
    },
    signal
  )
  const result = await f.session.context.append({
    kind,
    title: 'script:abcdef12:result',
    body,
  })
  await f.recent.seal(f.response.sequence, result.sequence, signal)
  return result
}

test('automatic narration resolves a witnessed question atomically and preserves other questions and user constraints', async (t) => {
  const f = await fixture(t, async function* (request) {
    const material = JSON.parse(request.materials[0].text)
    const question = material.active.items.find((item) => item.text === 'Verify the serializer')
    const result = material.records.find(
      (record) => record.text === 'PASS Ω: serializer round-trip'
    )
    yield {
      type: 'output',
      value: {
        summary: 'The round-trip execution passed. Integration verification remains open.',
        unresolved: ['Verify streaming cancellation'],
        negativeAttempts: [],
        active: {
          changes: [
            {
              id: question.id,
              evidence: [{ ref: result.ref, quote: 'PASS Ω: serializer round-trip' }],
            },
          ],
        },
      },
    }
    yield { type: 'finish', reason: 'stop' }
  })
  await f.session.context.summarizeInput({
    ref: f.input.ref,
    baseRevision: 0,
    summary: 'Change the serializer.',
    constraints: ['Preserve the public API'],
    unresolved: [],
  })
  const result = await nextVolume(f, ['Verify the serializer', 'Run integration tests'])
  const old = (await f.recent.volumes(signal))[0].narrative
  assert.equal(
    await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 12000 }, signal),
    true
  )
  const current = await new ActiveContext('root', f.session.context, f.storage).read(signal)
  assert.deepEqual(
    new Set(current.items.map((item) => item.text)),
    new Set(['Preserve the public API', 'Run integration tests', 'Verify streaming cancellation'])
  )
  assert.equal(current.status, 'reviewed')
  const memory = new ContextMemory(
    'root',
    f.session.context,
    f.storage,
    f.session.view,
    new ProgramContext('root', f.session.context, f.storage),
    f.recent
  )
  const frame = await memory.project(
    {
      id: 'frame',
      scope: { sessionId: 'root', revision: 0 },
      goals: [await f.session.context.projectInput(f.input.ref, 6000)],
      capsule: {},
      mandatory: [],
      evidence: [],
      gaps: [],
      readSet: [],
      progress: { step: 0, repeatedSteps: 0, stalled: false, evidence: [] },
    },
    undefined,
    [],
    signal,
    24000
  )
  assert.deepEqual(JSON.parse(frame.body).partitions.task.active.items, current.items)
  assert.equal(f.requests.length, 1)
  assert.equal(f.opened(), 0)
  const volumes = await f.recent.volumes(signal)
  assert.deepEqual(volumes[0].narrative, old)
  assert.deepEqual(volumes.at(-1).narrative.unresolved, ['Verify streaming cancellation'])
  const state = await f.storage.load('root')
  const transition = state.records.findLast(
    (record) => record.title === 'context:active-transition'
  )
  const details = JSON.parse(await f.storage.get('root', transition.objectId))
  assert.equal(details.transitions[0].status, 'resolved')
  assert.deepEqual(details.transitions[0].evidence, [
    { ref: result.ref, offset: 0, quote: 'PASS Ω: serializer round-trip' },
  ])
  assert.equal(
    (await f.session.context.readInput(f.input.ref, { limit: 1000 })).text,
    'Change the serializer; preserve the public API.'
  )
})

test('automatic narration preserves omitted current questions without copying the entire backlog into each volume', async (t) => {
  const f = await fixture(t, async function* () {
    yield {
      type: 'output',
      value: {
        summary: 'Checked one current stage.',
        unresolved: ['Check the next stage'],
        negativeAttempts: [],
      },
    }
    yield { type: 'finish', reason: 'stop' }
  })
  const prior = Array.from({ length: 32 }, (_, i) => `Pending check ${i}`)
  await nextVolume(f, prior)
  assert.equal(
    await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 12000 }, signal),
    true
  )
  const current = await new ActiveContext('root', f.session.context, f.storage).read(signal)
  assert.deepEqual(
    current.items.map((item) => item.text),
    [...prior, 'Check the next stage']
  )
  assert.deepEqual((await f.recent.volumes(signal)).at(-1).narrative.unresolved, [
    'Check the next stage',
  ])
})

test('direct narration acknowledges every fully sent input page before applying a resolution', async (t) => {
  const body = '用户需求 Ω😀\n'.repeat(4300)
  const f = await fixture(
    t,
    async function* (request) {
      const material = JSON.parse(request.materials[0].text)
      const question = material.active.items.find((item) => item.kind === 'question')
      const result = material.records.find((record) => record.text === 'prefix 😀\nPASS Ω\nsuffix')
      yield {
        type: 'output',
        value: {
          summary: 'The requested check passed.',
          unresolved: [],
          negativeAttempts: [],
          active: {
            changes: [{ id: question.id, evidence: [{ ref: result.ref, quote: 'PASS Ω' }] }],
          },
        },
      }
      yield { type: 'finish', reason: 'stop' }
    },
    body
  )
  f.model.limits.inputTokens = 96000
  f.model.limits.contextTokens = 108000
  await nextVolume(f, ['Verify Unicode output'], 'prefix 😀\nPASS Ω\nsuffix')
  assert.equal(
    await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 12000 }, signal),
    true
  )
  assert.equal(f.opened(), 0)
  assert.equal(
    (await new ActiveContext('root', f.session.context, f.storage).read(signal)).items.length,
    0
  )
  const state = await f.storage.load('root')
  const record = state.records.findLast((item) => item.title === 'context:active-transition')
  const transition = JSON.parse(await f.storage.get('root', record.objectId))
  assert.equal(transition.transitions[0].evidence[0].offset, 'prefix 😀\n'.length)
})

for (const fault of [
  'constraint',
  'foreign-reference',
  'invented-quote',
  'ambiguous-quote',
  'assistant-evidence',
  'repeated-id',
  'extra-field',
  'resolved-and-open',
  'prior-volume',
  'later-volume',
])
  test(`automatic resolution rejects ${fault} without partially publishing the narrative or current state`, async (t) => {
    const f = await fixture(t, async function* (request) {
      const material = JSON.parse(request.materials[0].text)
      const question = material.active.items.find(
        (item) => item.kind === (fault === 'constraint' ? 'constraint' : 'question')
      )
      const result = material.records.find(
        (record) => record.text === 'PASS Ω: serializer round-trip'
      )
      const change = { id: question.id, evidence: [{ ref: result.ref, quote: 'PASS Ω' }] }
      if (fault === 'prior-volume')
        change.evidence = [{ ref: f.result.ref, quote: 'Test failed: escaped separator' }]
      if (fault === 'later-volume') change.evidence[0].ref = later.ref
      if (fault === 'foreign-reference')
        change.evidence[0].ref = { ...result.ref, sessionId: 'foreign' }
      if (fault === 'invented-quote') change.evidence[0].quote = 'INVENTED_VALIDATION_RESULT'
      if (fault === 'ambiguous-quote') change.evidence[0].quote = 'r'
      if (fault === 'assistant-evidence') assert.equal(result.kind, 'assistant')
      const active = { changes: fault === 'repeated-id' ? [change, change] : [change] }
      if (fault === 'extra-field') active.baseRevision = material.active.revision
      yield {
        type: 'output',
        value: {
          summary: 'THIS_NARRATIVE_MUST_NOT_PUBLISH',
          unresolved: fault === 'resolved-and-open' ? ['Verify the serializer'] : [],
          negativeAttempts: [],
          active,
        },
      }
      yield { type: 'finish', reason: 'stop' }
    })
    await f.session.context.summarizeInput({
      ref: f.input.ref,
      baseRevision: 0,
      summary: 'Change the serializer.',
      constraints: ['Preserve the public API'],
      unresolved: [],
    })
    const result = await nextVolume(
      f,
      ['Verify the serializer'],
      'PASS Ω: serializer round-trip',
      fault === 'assistant-evidence' ? 'assistant' : 'audit'
    )
    const later =
      fault === 'later-volume'
        ? await f.session.context.append({
            kind: 'audit',
            title: 'script:1234abcd:result',
            body: 'PASS Ω: later work',
          })
        : undefined
    assert.equal(
      await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 12000 }, signal),
      false
    )
    const current = await new ActiveContext('root', f.session.context, f.storage).read(signal)
    assert.deepEqual(
      new Set(current.items.map((item) => item.text)),
      new Set(['Preserve the public API', 'Verify the serializer'])
    )
    assert.equal((await f.recent.volumes(signal)).at(-1).narrative, undefined)
    assert.equal(
      (await f.session.context.read(result.ref, { limit: 1000 })).text,
      'PASS Ω: serializer round-trip'
    )
    assert.equal(f.requests.length, 1)
  })

for (const fault of ['partial-result', 'partial-input', 'missing-input'])
  test(`automatic resolution requires complete delivered records: ${fault}`, async (t) => {
    const f = await fixture(t, complete)
    const result = await nextVolume(f, ['Verify the serializer'])
    const snapshot = await new ContextMaintenanceState('root', f.storage).snapshot(24000, signal)
    const input = await f.session.context.read(f.input.ref, {
      limit: fault === 'partial-input' ? 4 : 1000,
    })
    const output = await f.session.context.read(result.ref, {
      limit: fault === 'partial-result' ? 4 : 1000,
    })
    const value = {
      summary: 'The serializer check passed.',
      unresolved: [],
      negativeAttempts: [],
      active: {
        changes: [
          {
            id: snapshot.active.items[0].id,
            evidence: [{ ref: result.ref, quote: 'PASS' }],
          },
        ],
      },
    }
    assert.throws(
      () =>
        volumeNarrationPatch(
          snapshot,
          value,
          [result.ref],
          [...(fault === 'missing-input' ? [] : [input]), output]
        ),
      { code: fault === 'partial-result' ? 'PERMISSION' : 'CONTEXT_INPUT_UNSEEN' }
    )
  })

for (const change of ['user-input', 'authorization-reset', 'active-revision'])
  test(`a concurrent ${change} invalidates automatic closure and narrative publication together`, async (t) => {
    const f = await fixture(t, async function* (request) {
      const material = JSON.parse(request.materials[0].text)
      const question = material.active.items.find((item) => item.kind === 'question')
      const result = material.records.find(
        (record) => record.text === 'PASS Ω: serializer round-trip'
      )
      if (change === 'user-input')
        await f.session.context.append({
          kind: 'user',
          body: 'The validation requirements have changed.',
        })
      else if (change === 'authorization-reset')
        await f.session.context.append({ kind: 'audit', title: 'search:history-reset', body: '{}' })
      else
        await new ActiveContext('root', f.session.context, f.storage).apply(
          {
            baseRevision: material.active.revision,
            reviewedInput: f.input.ref,
            changes: [],
          },
          [f.input.ref],
          signal
        )
      yield {
        type: 'output',
        value: {
          summary: 'STALE_NARRATIVE_MUST_NOT_PUBLISH',
          unresolved: [],
          negativeAttempts: [],
          active: {
            changes: [{ id: question.id, evidence: [{ ref: result.ref, quote: 'PASS Ω' }] }],
          },
        },
      }
      yield { type: 'finish', reason: 'stop' }
    })
    await nextVolume(f, ['Verify the serializer'])
    await assert.rejects(
      f.maintenance.maintain('root', { reason: 'narrate', targetChars: 12000 }, signal),
      {
        code: 'STALE_VIEW',
      }
    )
    const state = await f.storage.load('root')
    for (const record of state.records.filter(
      (item) => item.title === 'context:active-transition'
    )) {
      const transition = JSON.parse(await f.storage.get('root', record.objectId))
      assert.equal(
        transition.transitions.length,
        0,
        'the concurrent review cannot silently close any question'
      )
    }
    assert.equal(
      state.records.filter((item) => item.title === 'context:volume-narrative').length,
      1
    )
    assert.equal(f.closed(), 1)
  })

test('automatic narration retries a classified transient response with separate accounting and no partial publication', async (t) => {
  let calls = 0
  const f = await fixture(t, async function* () {
    if (++calls === 1) {
      yield { type: 'text', text: '{"summary":"unaccepted partial' }
      yield { type: 'usage', inputTokens: 1100, outputTokens: 10 }
      yield { type: 'error', code: 'provider', message: 'Temporary disconnect', retryAfterMs: 0 }
    } else yield* complete()
  })
  assert.equal(
    await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 12000 }, signal),
    true
  )
  assert.equal(f.requests.length, 2)
  assert.deepEqual(f.requests[0], f.requests[1], 'retry keeps the same fixed evidence and format')
  assert.deepEqual(f.usage, [
    [1100, 10],
    [1200, 80],
  ])
  assert.equal(f.reservations.filter((value) => value > 0).length, 3)
  assert.equal(f.closed(), 1)
  assert.equal(f.opened(), 0)
  const narrative = (await f.recent.volumes(signal)).at(-1).narrative
  assert.equal(narrative.summary, 'The separator test failed; the fix is still pending.')
  const trace = await new RuntimeTrace(
    f.requests[0].cacheKey,
    f.storage,
    createContextInvocationJournal(f.storage)
  ).page()
  assert.deepEqual(
    trace.turns.map((turn) => turn.modelAccounting.outcome),
    ['rejected', 'accepted']
  )
  assert.deepEqual(trace.accounting.modelRequests, { known: 2, unknown: 0, inflight: 0 })
  const state = await f.storage.load(f.requests[0].cacheKey)
  const retries = state.records.filter((record) => record.title === 'model-retry')
  assert.equal(retries.length, 1)
  const retry = JSON.parse(await f.storage.get(f.requests[0].cacheKey, retries[0].objectId))
  assert.equal(retry.executed, false)
  assert.equal(retry.attempt, 1)
})

test('transient narration retries stop at a fixed limit and keep every missing usage unknown', async (t) => {
  const f = await fixture(t, async function* () {
    yield { type: 'error', code: 'provider', message: 'Unavailable', retryAfterMs: 0 }
  })
  assert.equal(
    await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 12000 }, signal),
    false
  )
  assert.equal(f.requests.length, 3)
  assert.equal((await f.recent.volumes(signal)).at(-1).narrative, undefined)
  assert.deepEqual(f.usage, [])
  const trace = await new RuntimeTrace(
    f.requests[0].cacheKey,
    f.storage,
    createContextInvocationJournal(f.storage)
  ).page()
  assert.deepEqual(trace.accounting.modelRequests, { known: 0, unknown: 3, inflight: 0 })
  assert(trace.turns.every((turn) => turn.modelAccounting.outcome === 'rejected'))
})

for (const error of [
  { code: 'provider', message: 'Authentication rejected' },
  { code: 'provider', message: 'Invalid delay', retryAfterMs: -1 },
  { code: 'provider', message: 'Invalid delay', retryAfterMs: Infinity },
  { code: 'context-limit', message: 'Input exceeds context', retryAfterMs: 0 },
])
  test(`automatic narration does not retry ${error.code}: ${String(error.retryAfterMs)}`, async (t) => {
    const f = await fixture(t, async function* () {
      yield { type: 'error', ...error }
    })
    assert.equal(
      await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 12000 }, signal),
      false
    )
    assert.equal(f.requests.length, 1)
    assert.equal((await f.recent.volumes(signal)).at(-1).narrative, undefined)
  })

test('cancellation during narration backoff prevents the next model request', async (t) => {
  const cancel = new AbortController()
  const f = await fixture(t, async function* () {
    setTimeout(() => cancel.abort(), 20)
    yield { type: 'error', code: 'provider', message: 'Temporary disconnect', retryAfterMs: 5000 }
  })
  await assert.rejects(
    f.maintenance.maintain('root', { reason: 'narrate', targetChars: 12000 }, cancel.signal),
    { name: 'AbortError' }
  )
  assert.equal(f.requests.length, 1)
  assert(cancel.signal.aborted)
  assert.equal(f.closed(), 1)
  assert.equal((await f.recent.volumes(signal)).at(-1).narrative, undefined)
})

test('narration retries still obey the activation call limit', async (t) => {
  const f = await fixture(
    t,
    async function* () {
      yield { type: 'error', code: 'provider', message: 'Temporary disconnect', retryAfterMs: 0 }
    },
    undefined,
    { modelCalls: 2 }
  )
  assert.equal(
    await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 12000 }, signal),
    false
  )
  assert.equal(f.requests.length, 2)
  assert.equal(f.closed(), 1)
  assert.equal((await f.recent.volumes(signal)).at(-1).narrative, undefined)
})

test('a new parent input between retry attempts still rejects the entire narrative publication', async (t) => {
  let calls = 0
  const f = await fixture(t, async function* () {
    if (++calls === 1) {
      yield { type: 'error', code: 'provider', message: 'Temporary disconnect', retryAfterMs: 0 }
    } else {
      await f.session.context.append({
        kind: 'user',
        body: 'Use the revised requirements instead.',
      })
      yield* complete()
    }
  })
  await assert.rejects(
    f.maintenance.maintain('root', { reason: 'narrate', targetChars: 12000 }, signal),
    { code: 'STALE_VIEW' }
  )
  assert.equal(f.requests.length, 2)
  assert.equal((await f.recent.volumes(signal)).at(-1).narrative, undefined)
  assert.equal(f.closed(), 1)
})

test('narration preserves final usage delivered during cancellation without retrying or publishing', async (t) => {
  const cancel = new AbortController()
  const f = await fixture(
    t,
    async function* () {
      yield { type: 'text', text: '{"summary":"partial' }
      yield { type: 'usage', inputTokens: 900, outputTokens: 7 }
    },
    undefined,
    undefined,
    (delta) => {
      if (delta.type === 'usage') cancel.abort()
    }
  )
  await assert.rejects(
    f.maintenance.maintain('root', { reason: 'narrate', targetChars: 12000 }, cancel.signal),
    { name: 'AbortError' }
  )
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.usage, [[900, 7]])
  assert.equal((await f.recent.volumes(signal)).at(-1).narrative, undefined)
  const trace = await new RuntimeTrace(
    f.requests[0].cacheKey,
    f.storage,
    createContextInvocationJournal(f.storage)
  ).page()
  assert.deepEqual(trace.accounting.modelRequests, { known: 1, unknown: 0, inflight: 0 })
  assert.equal(trace.turns[0].modelAccounting.outcome, 'rejected')
})
