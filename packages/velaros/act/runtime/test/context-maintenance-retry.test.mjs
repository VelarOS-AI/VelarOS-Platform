import assert from 'node:assert/strict'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { ContextMaintenance } from '../../../dist/act/runtime/impl/ContextMaintenance.js'
import { ModelToolRuntime } from '../../../dist/act/runtime/impl/ModelToolRuntime.js'
import { RecentContext } from '../../../dist/act/runtime/impl/RecentContext.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'

const signal = new AbortController().signal
const narrative = {
  summary: 'The sealed work has already been narrated.',
  evidence: [],
  unresolved: [],
  negativeAttempts: [],
}

async function fixture(t) {
  const storage = localContextStorage({ path: ':memory:' })
  const runtime = await createRuntime({ storage, runner: nodeSubprocessCodeRunner, modules: [] })
  t.after(() => runtime.close())
  const session = await runtime.openSession('root')
  const input = await session.context.append({ kind: 'user', body: 'Continue the investigation' })
  await session.view.begin(input.ref)
  const recent = new RecentContext('root', session.context, storage)
  let starts = 0
  const dependencies = {
    storage,
    preview: () => undefined,
    model: () => ({ id: 'unused-offline-model' }),
    tools: {
      async begin() {
        starts++
        throw new Error('Offline test stops at the model-resource boundary')
      },
    },
  }
  const maintenance = new ContextMaintenance(dependencies)
  async function volume(from = 0) {
    const record = await session.context.append({ kind: 'assistant', body: 'Recorded local work' })
    return recent.seal(from, record.sequence, signal)
  }
  return { storage, session, recent, maintenance, dependencies, volume, starts: () => starts }
}

test('INV-73 a persisted volume narrative prevents queued automatic narration before model allocation', async (t) => {
  const f = await fixture(t)
  const ref = await f.volume()
  await f.recent.narrate(ref, narrative, signal)
  await f.maintenance.request('root', { focus: 'Refresh the current notes' }, signal)
  assert.equal(
    await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 8000 }, signal),
    false
  )
  assert.equal(f.starts(), 0)
  assert.equal((await f.maintenance.status('root', signal)).pending, true)
  const restarted = new ContextMaintenance(f.dependencies)
  assert.equal(
    await restarted.maintain('root', { reason: 'narrate', targetChars: 8000 }, signal),
    false
  )
  assert.equal(
    f.starts(),
    0,
    'the guard uses persisted authorized history, not a process-local flag'
  )
})

test('INV-73 an absent narrative and a failed earlier maintenance still permit automatic narration', async (t) => {
  const f = await fixture(t)
  await f.volume()
  await f.session.context.append({
    kind: 'audit',
    title: 'context-maintenance:outcome',
    body: JSON.stringify({ reason: 'narrate', status: 'failed', error: 'Model was unavailable' }),
  })
  await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 8000 }, signal)
  assert.equal(f.starts(), 1)
})

test('INV-73 another volume narrative cannot suppress the latest unnarrated volume', async (t) => {
  const f = await fixture(t)
  const first = await f.volume()
  await f.recent.narrate(first, narrative, signal)
  const latest = (await f.recent.volumes(signal)).at(-1)
  const second = await f.volume(latest.volume.through)
  assert.notEqual(first.id, second.id)
  await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 8000 }, signal)
  assert.equal(f.starts(), 1)
})

test('INV-73 existing narration does not suppress pressure maintenance', async (t) => {
  const f = await fixture(t)
  await f.recent.narrate(await f.volume(), narrative, signal)
  await f.maintenance.maintain('root', { reason: 'pressure', targetChars: 8000 }, signal)
  assert.equal(f.starts(), 1)
})

test('INV-73 existing narration does not consume or suppress an explicit maintenance request', async (t) => {
  const f = await fixture(t)
  await f.recent.narrate(await f.volume(), narrative, signal)
  await f.maintenance.request('root', { focus: 'Review new evidence' }, signal)
  await f.maintenance.maintain('root', { reason: 'boundary', targetChars: 8000 }, signal)
  assert.equal(f.starts(), 1)
})

test('INV-73 authorization reset excludes old narratives while a new authorized volume can be narrated', async (t) => {
  const f = await fixture(t)
  await f.recent.narrate(await f.volume(), narrative, signal)
  await f.session.view.end('completed')
  const input = await f.session.context.append({ kind: 'user', body: 'Begin a separate task' })
  await f.session.view.begin(input.ref, signal, 'new')
  assert.equal((await f.recent.volumes(signal)).length, 0)
  await f.volume()
  await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 8000 }, signal)
  assert.equal(f.starts(), 1)
})

async function dataFixture(t, stream, options = {}) {
  const f = await fixture(t)
  const tools = new ModelToolRuntime({
    storage: f.storage,
    view: () => f.session.view,
    deadline: () => undefined,
  })
  tools.root('root')
  const model = {
    id: 'data-maintenance',
    nativeTools: true,
    limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 8192 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
    stream,
  }
  const maintenance = new ContextMaintenance({
    ...f.dependencies,
    tools,
    model: () => model,
    options: { execution: 'data' },
    open: async () => {
      assert.fail('data maintenance must never open a script session or Node process')
    },
    close: async () => {
      assert.fail('no script session exists')
    },
    ...options,
  })
  const outcome = async () => {
    const record = (await f.storage.load('root')).records.findLast(
      (item) => item.title === 'context-maintenance:outcome'
    )
    return JSON.parse(await f.storage.get('root', record.objectId))
  }
  await maintenance.request(
    'root',
    { focus: 'Keep verified progress without launching code' },
    signal
  )
  return { ...f, maintenance, outcome }
}
const complete = { type: 'finish', reason: 'stop' }
const tool = (name, input, id = name) => ({ type: 'tool-call', value: { id, name, input } })
const facts = (request) => JSON.parse(request.materials[0].text)
const candidate = (baseRevision) => ({
  baseRevision,
  summary: 'Preserved the actual user request.',
  unresolved: ['Continue the investigation'],
})

test('native data maintenance recompiles its reserved delivery turn when ordinary work reaches the token budget', async (t) => {
  let dispatched = 0
  const model = {
    id: 'bounded-maintenance',
    nativeTools: true,
    limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 2000 },
    estimate: async (request) => ({
      tokens: request.instructions.includes('最后交付轮') ? 3000 : 10000,
      precision: 'exact',
      basis: 'test',
    }),
    async *stream(request) {
      dispatched++
      assert.match(request.instructions, /最后交付轮/)
      yield tool('submit', candidate(facts(request).snapshot.baseRevision))
      yield complete
    },
  }
  const f = await dataFixture(t, async function* () {}, {
    model: () => model,
    options: {
      execution: 'data',
      profile: { modelTokens: 20000, finalizationTokens: 10000, outputTokens: 2000 },
    },
  })
  assert.equal(
    await f.maintenance.maintain('root', { reason: 'boundary', targetChars: 8000 }, signal),
    true,
    JSON.stringify(await f.outcome())
  )
  assert.equal(dispatched, 1)
  const outcome = await f.outcome()
  assert.equal(outcome.usage.calls, 1)
  assert.equal(outcome.usage.finalUsed, true)
  assert.equal(outcome.usage.reason, 'token-budget')
})

test('native data maintenance rejects an oversized request before dispatch without publishing', async (t) => {
  const f = await dataFixture(t, async function* () {}, {
    model: () => ({
      id: 'small-window',
      nativeTools: true,
      limits: { contextTokens: 10000, inputTokens: 9000, outputTokens: 2000 },
      estimate: async () => ({ tokens: 20000, precision: 'exact', basis: 'test' }),
      stream() {
        assert.fail('oversized data request must not dispatch')
      },
    }),
  })
  assert.equal(
    await f.maintenance.maintain('root', { reason: 'boundary', targetChars: 8000 }, signal),
    false
  )
  assert.equal((await f.outcome()).report, null)
  assert.match((await f.outcome()).error, /窗口/)
})

test('native data maintenance reads authorized materials, rejects foreign refs, and publishes without Node', async (t) => {
  let calls = 0
  let revision
  const f = await dataFixture(t, async function* (request) {
    assert.deepEqual(
      request.response.tools.map((item) => item.name),
      ['list', 'read', 'submit']
    )
    const current = facts(request)
    if (++calls === 1) {
      revision = current.snapshot.baseRevision
      yield {
        type: 'continuation',
        value: {
          model: 'data-maintenance',
          format: 'fixture-v1',
          data: 'opaque-maintenance-state',
          tokens: 40,
        },
      }
      yield tool('read', { ref: current.snapshot.goals[0], limit: 1000 }, 'authorized')
      yield tool('read', { ref: { sessionId: 'foreign', id: '12345678' } }, 'foreign')
    } else {
      const results = request.history.at(-1).toolExchange.results
      assert.equal(request.history.at(-1).continuation.data, 'opaque-maintenance-state')
      assert.match(results[0].output.text, /Continue the investigation/)
      assert.equal(results[1].output.error.code, 'SCOPE_MISMATCH')
      yield tool('submit', candidate(revision))
    }
    yield complete
  })
  assert.equal(
    await f.maintenance.maintain('root', { reason: 'boundary', targetChars: 8000 }, signal),
    true,
    JSON.stringify(await f.outcome())
  )
  assert.equal(calls, 2)
  const outcome = await f.outcome()
  assert.equal(outcome.status, 'applied')
  assert.equal(outcome.usage.calls, 2)
  assert(outcome.report.id)
})

test('native data maintenance can summarize a read only after its body reaches the next response', async (t) => {
  let calls = 0
  let patch
  const f = await dataFixture(
    t,
    async function* (request) {
      if (++calls === 1) {
        const snapshot = facts(request).snapshot
        assert.equal(facts(request).material, undefined)
        patch = {
          ...candidate(snapshot.baseRevision),
          inputs: [
            {
              ref: snapshot.goals[0],
              baseRevision: 0,
              summary: 'Continue the investigation',
              constraints: [],
              unresolved: ['Investigate'],
            },
          ],
        }
        yield tool('read', { ref: snapshot.goals[0], limit: 1000 })
        yield tool('submit', patch)
      } else {
        const results = request.history.at(-1).toolExchange.results
        assert.match(results[0].output.text, /Continue the investigation/)
        assert(
          results[1].output.error,
          'the unreceived body cannot support the same-response patch'
        )
        yield tool('submit', patch)
      }
      yield complete
    },
    { options: { execution: 'data', profile: { projectionChars: 1 } } }
  )
  assert.equal(
    await f.maintenance.maintain('root', { reason: 'boundary', targetChars: 8000 }, signal),
    true,
    JSON.stringify(await f.outcome())
  )
  assert.equal(calls, 2)
  const state = await f.storage.load('root')
  assert.equal(state.inputSummaries.length, 1)
  assert.equal(state.inputSummaries[0].revision, 1)
})

test('native data maintenance refuses a patch when parent task state changes during the response', async (t) => {
  const f = await dataFixture(t, async function* (request) {
    const old = facts(request).snapshot.baseRevision
    await f.session.context.append({ kind: 'user', body: 'Keep this new constraint.' })
    yield tool('submit', candidate(old))
    yield complete
  })
  await assert.rejects(
    f.maintenance.maintain('root', { reason: 'boundary', targetChars: 8000 }, signal),
    { code: 'STALE_VIEW' }
  )
  assert.equal((await f.outcome()).report, null)
})

for (const scenario of ['unknown-code', 'truncated', 'duplicate-id']) {
  test(`native data maintenance never publishes an invalid response: ${scenario}`, async (t) => {
    const f = await dataFixture(t, async function* (request) {
      if (scenario === 'unknown-code') yield tool('exec', { code: 'process.exit(0)' })
      else {
        yield tool('submit', candidate(facts(request).snapshot.baseRevision))
        if (scenario === 'duplicate-id')
          yield tool('read', { ref: facts(request).snapshot.goals[0] }, 'submit')
      }
      yield { type: 'finish', reason: scenario === 'truncated' ? 'length' : 'stop' }
    })
    assert.equal(
      await f.maintenance.maintain('root', { reason: 'boundary', targetChars: 8000 }, signal),
      false
    )
    const outcome = await f.outcome()
    assert.equal(outcome.status, 'failed')
    assert.equal(outcome.report, null)
    assert(
      !(await f.storage.load('root')).records.some(
        (item) => item.title === 'context-maintenance:applied'
      )
    )
  })
}

test('native data maintenance rejects the whole malformed batch before a valid submit and can repair it', async (t) => {
  let calls = 0
  let revision
  const f = await dataFixture(t, async function* (request) {
    if (++calls === 1) {
      revision = facts(request).snapshot.baseRevision
      yield tool('read', { ref: facts(request).snapshot.goals[0], unexpected: true })
      yield tool('submit', candidate(revision))
    } else {
      assert.equal(request.history.at(-1).toolExchange.results.length, 2)
      for (const result of request.history.at(-1).toolExchange.results)
        assert.equal(result.output.error.code, 'MODEL_RESPONSE_SCHEMA')
      assert.equal(
        request.history.at(-1).toolExchange.results[0].output.error.code,
        'MODEL_RESPONSE_SCHEMA'
      )
      yield tool('submit', candidate(revision))
    }
    yield complete
  })
  assert.equal(
    await f.maintenance.maintain('root', { reason: 'boundary', targetChars: 8000 }, signal),
    true,
    JSON.stringify(await f.outcome())
  )
  assert.equal(calls, 2)
  assert.equal(
    (await f.storage.load('root')).records.filter(
      (item) => item.title === 'context-maintenance:applied'
    ).length,
    1
  )
})

test('cancelling native data maintenance prevents a late submit from publishing', async (t) => {
  const entered = Promise.withResolvers()
  const controller = new AbortController()
  const f = await dataFixture(t, async function* (request) {
    entered.resolve()
    await new Promise((resolve) =>
      controller.signal.addEventListener('abort', resolve, { once: true })
    )
    yield tool('submit', candidate(facts(request).snapshot.baseRevision))
    yield complete
  })
  const pending = f.maintenance.maintain(
    'root',
    { reason: 'boundary', targetChars: 8000 },
    controller.signal
  )
  await Promise.race([
    entered.promise,
    pending.then(() => assert.fail('maintenance ended before model dispatch')),
  ])
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal((await f.outcome()).report, null)
  assert(
    !(await f.storage.load('root')).records.some(
      (item) => item.title === 'context-maintenance:applied'
    )
  )
})

test('a completed script maintenance without a patch does not report a recovered protocol error as its cause', async (t) => {
  const f = await dataFixture(t, async function* () {}, {
    options: { execution: 'script' },
    open: async () => ({
      async *submit() {
        yield { type: 'error', message: 'Missing control decision, repairing' }
        yield {
          type: 'accepted',
          text: 'The host rejected every attempt with SHELL_CONFINEMENT_UNAVAILABLE.',
        }
        yield { type: 'state', status: 'completed' }
      },
    }),
    close: async () => {},
  })
  assert.equal(
    await f.maintenance.maintain('root', { reason: 'boundary', targetChars: 8000 }, signal),
    false
  )
  const outcome = await f.outcome()
  assert.match(outcome.error, /未提交有效补丁/)
  assert.match(outcome.error, /工具报告.*SHELL_CONFINEMENT_UNAVAILABLE/)
  assert.doesNotMatch(outcome.error, /Missing control decision/)
})
