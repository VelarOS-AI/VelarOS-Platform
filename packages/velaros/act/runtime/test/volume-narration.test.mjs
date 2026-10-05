import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createContextInvocationJournal } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { modelRequestEncoder } from '@velaros-ai/kernel'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { ContextMaintenance } from '../../../dist/act/runtime/impl/ContextMaintenance.js'
import { RecentContext } from '../../../dist/act/runtime/impl/RecentContext.js'
import { RuntimeTrace } from '../../../dist/act/runtime/impl/RuntimeTrace.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'
import {
  volumeNarrationFormat,
  volumeNarrationPatch,
} from '../../../dist/act/runtime/utils/volume-narration.js'
import { VelarContextMaterialsModule } from '../../../dist/act/system/contract/surface.js'

const signal = new AbortController().signal
async function fixture(t, respond) {
  const storage = localContextStorage({ path: ':memory:' })
  const runtime = await createRuntime({ storage, runner: nodeSubprocessCodeRunner, modules: [] })
  t.after(() => runtime.close())
  const session = await runtime.openSession('root')
  const input = await session.context.append({
    kind: 'user',
    body: 'Change the serializer; preserve the public API.',
  })
  await session.view.begin(input.ref)
  const result = await session.context.append({
    kind: 'tool',
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
          yield* driver.stream(request, signal)
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

test('narration projects the generated contract and retains existing unresolved facts', () => {
  const response = volumeNarrationFormat(VelarContextMaterialsModule.operations.submit.input)
  assert.deepEqual(Object.keys(response.schema.properties), [
    'summary',
    'unresolved',
    'negativeAttempts',
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
  assert.deepEqual(result.volume.unresolved, [
    'Still investigate the data loss',
    'Run integration tests',
  ])
  assert.deepEqual(Object.keys(result), ['baseRevision', 'summary', 'unresolved', 'volume'])
})
