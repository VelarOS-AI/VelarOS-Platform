import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'

import { createContextInvocationJournal } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { ScriptTurnDecoder } from '../../../dist/act/runtime/impl/ScriptTurnDecoder.js'
import { createProjectCapabilityModule, createRuntime } from '../../../dist/act/runtime/index.js'
import {
  createProjectKernel,
  createProjectObservationProvider,
} from '../../../dist/project/index.js'

import { done, marker, runtimeFrame, turn } from './support/model-turn.mjs'

const stop = { type: 'finish', reason: 'stop' }
const noop = "import {output} from 'velaros'; output('continue');"
const entries = [
  {
    path: 'facts.json',
    key: 'facts',
    purpose: 'Current task facts',
    format: 'json',
    pointer: '/active',
    view: 'full',
  },
]
const snapshot = (files = entries) => ({
  snapshot: { provider: 'project', plan: 'files', input: { files } },
})
const block = (request, fields) =>
  `${marker(request)} observe(${JSON.stringify(fields)})\n${marker(request)}\n`

async function collect(f, signal) {
  const events = []
  for await (const event of f.session.submit('Inspect current facts and continue the task', signal))
    events.push(event)
  return events
}

async function fixture(t, stream, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'scriptact-pure-snapshot-'))
  const workspace = join(root, 'project')
  await mkdir(workspace)
  await writeFile(
    join(workspace, 'facts.json'),
    JSON.stringify({ active: { items: [1, 2], enabled: true }, ignored: 7 })
  )
  await writeFile(join(workspace, 'note.txt'), 'Alpha\nBeta\nGamma\n')
  const f = {
    root,
    workspace,
    frames: [],
    requests: [],
    runs: [],
    calls: 0,
    reads: 0,
    readCompletions: 0,
    captureCalls: 0,
    beforeRead: async () => {},
    onRead: async () => {},
    onCapture: async () => {},
    stream,
    completed: false,
  }
  let kernel
  const runner = {
    async run(request, ...args) {
      const started = performance.now()
      const result = await nodeSubprocessCodeRunner.run(request, ...args)
      f.runs.push({
        source: request.source,
        derive: Boolean(request.input?.capture),
        durationMs: performance.now() - started,
      })
      return result
    },
  }
  const model = {
    id: 'real-project-pure-snapshot',
    limits: { contextTokens: 200000, inputTokens: 180000, outputTokens: 4000 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'mechanism-fixture' }),
    async *stream(request) {
      f.frames.push(runtimeFrame(request))
      f.requests.push(request)
      f.calls++
      yield* f.stream(request, f)
    },
  }
  if (options.custom) {
    const install = async () => {
      kernel = await createProjectKernel({ root: workspace, includeBuiltinPlugins: false })
      const read = kernel.read.bind(kernel)
      kernel.read = async (input) => {
        f.reads++
        await f.beforeRead(input, f.reads)
        const result = await read(input)
        f.readCompletions++
        await f.onRead(input, result, f.reads)
        return result
      }
    }
    await install()
    f.replaceKernel = install
  }
  const project = {
    getRootPath: () => workspace,
    kernel: async () => kernel,
    queryCode: async () => ({}),
  }
  const runtimeOptions = {
    workspace,
    storage: undefined,
    runner,
    model,
    agents: false,
    search: false,
    memory: false,
    ...(options.custom
      ? {
          project: false,
          modules: [createProjectCapabilityModule({ instanceId: workspace, project })],
        }
      : {}),
    context: {
      maintenance: false,
      ...(options.custom ? { snapshots: [createProjectObservationProvider()] } : {}),
    },
    async authorize(invocation) {
      if (
        invocation.binding.moduleId === 'velaros:project' &&
        invocation.operation === 'snapshot'
      ) {
        f.captureCalls++
        await f.onCapture(invocation)
      }
    },
  }
  const open = async () => {
    f.storage = localContextStorage({ path: join(root, 'state.sqlite') })
    f.runtime = await createRuntime({ ...runtimeOptions, storage: f.storage })
    f.session = await f.runtime.openSession('s')
  }
  await open()
  f.restart = async () => {
    await f.runtime.close()
    await open()
  }
  f.records = async () => {
    const records = []
    for (const record of (await f.storage.load('s'))?.records ?? [])
      records.push({ ...record, body: await f.storage.get('s', record.objectId) })
    return records
  }
  t.after(async () => {
    await f.runtime.close()
    await rm(root, { recursive: true, force: true })
  })
  return f
}

const steady = (rounds) =>
  async function* (request, f) {
    if (f.calls < rounds) {
      yield turn(request, { execute: { source: noop } })
      yield stop
    } else yield* done(request)
  }

test('INV-80 default workspace model entry captures real Project values every round and reuses only pure derivation', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield {
        type: 'text',
        text: block(
          request,
          snapshot([
            ...entries,
            { path: 'note.txt', range: [2, 2], key: 'note', purpose: 'Current note', view: 'full' },
          ])
        ),
      }
      yield stop
    } else yield* steady(7)(request, f)
  })
  const events = await collect(f)
  assert.equal(events.at(-1).status, 'completed')
  assert.equal(f.captureCalls, 6)
  assert.equal(f.runs.filter((item) => item.derive).length, 1)
  const observed = f.frames.slice(1).map((frame) => frame.observation.freshness)
  assert.deepEqual(
    observed.map((item) => item.status),
    ['collected', 'reused', 'reused', 'reused', 'reused', 'reused']
  )
  assert.equal(new Set(observed.map((item) => item.executionId)).size, 1)
  assert.equal(new Set(observed.map((item) => item.resultRef)).size, 1)
  assert.equal(new Set(observed.map((item) => item.observedAt)).size, 1)
  assert.equal(new Set(observed.map((item) => item.snapshot.captureExecutionId)).size, 6)
  assert.ok(
    observed.every((item) => item.snapshot.readRequests === 4 && item.snapshot.materialBytes > 0)
  )
  assert.ok(f.frames[1].observation.text.includes('Beta'))
  const traces = (await f.runtime.trace('s', { fullContent: true, limit: 8 })).turns.slice(1)
  for (const trace of traces) {
    const capture = trace.invocations.filter(
      (item) => item.summary.moduleId === 'velaros:project' && item.summary.operation === 'snapshot'
    )
    assert.equal(capture.length, 1)
    assert.equal(trace.invocations.length, 1, 'reused derivation adds no current Kernel invocation')
    assert.equal(
      capture[0].executionId,
      trace.observation.run.collection.snapshot.captureExecutionId
    )
  }
  const before = f.captureCalls
  f.stream = steady(f.calls + 1)
  await collect(f)
  assert.equal(f.captureCalls, before, 'logical task completion retires snapshot plan')
})

test('INV-80 authorization reset retires the plan and a newly accepted stage captures again', async (t) => {
  const f = await fixture(
    t,
    async function* (request, f) {
      if (f.calls === 1) {
        await f.session.context.append({
          kind: 'audit',
          title: 'search:history-reset',
          body: 'Authorize a new stage from this point',
        })
        yield turn(request, { execute: { source: noop } })
        yield stop
      } else if (f.calls === 2) {
        yield { type: 'text', text: block(request, snapshot()) }
        yield stop
      } else yield* done(request)
    },
    { custom: true }
  )
  await f.session.observe(snapshot())
  await collect(f)
  assert.equal(f.reads, 4)
  assert.equal(f.captureCalls, 2)
  assert.equal(f.runs.filter((item) => item.derive).length, 2)
  assert.equal(f.frames[1].observation.sourceRef, null)
  assert.notEqual(f.frames[0].observation.sourceRef, f.frames[2].observation.sourceRef)
})

test('INV-80 content changes and ABA with a changed captured revision force fresh pure derivation', async (t) => {
  const f = await fixture(
    t,
    async function* (request, f) {
      if (f.calls === 1) {
        await writeFile(join(f.workspace, 'facts.json'), '{"active":{"items":[9]}}')
        await writeFile(
          join(f.workspace, 'facts.json'),
          '{"active":{"items":[1,2],"enabled":true},"ignored":7}'
        )
      }
      if (f.calls === 2)
        await writeFile(
          join(f.workspace, 'facts.json'),
          '{"active":{"items":[3],"enabled":false},"ignored":7}'
        )
      yield* steady(3)(request, f)
    },
    { custom: true }
  )
  await f.session.observe(snapshot())
  await collect(f)
  assert.equal(f.reads, 6)
  assert.equal(
    f.runs.filter((item) => item.derive).length,
    3,
    JSON.stringify(f.frames.map((frame) => frame.observation))
  )
  assert.deepEqual(
    f.frames.map((frame) => frame.observation.freshness.status),
    ['collected', 'collected', 'collected']
  )
  assert.notEqual(f.frames[0].observation.resultRef, f.frames[1].observation.resultRef)
  assert.notEqual(f.frames[1].observation.resultRef, f.frames[2].observation.resultRef)
})

test('INV-80 a truncated real capture drops the old baseline and keeps all returned material cost', async (t) => {
  const f = await fixture(
    t,
    async function* (request, f) {
      if (f.calls === 1)
        await writeFile(
          join(f.workspace, 'facts.json'),
          JSON.stringify({ active: { items: [1, 2], enabled: true }, padding: 'x'.repeat(500001) })
        )
      if (f.calls === 2)
        await writeFile(
          join(f.workspace, 'facts.json'),
          JSON.stringify({ active: { items: [1, 2], enabled: true }, ignored: 7 })
        )
      yield* steady(3)(request, f)
    },
    { custom: true }
  )
  await f.session.observe(snapshot())
  await collect(f)
  assert.equal(f.reads, 5)
  assert.equal(f.runs.filter((item) => item.derive).length, 2)
  assert.equal(f.frames[1].observation.freshness.reason, 'snapshot-capture-failed')
  assert.equal(f.frames[1].observation.freshness.snapshot.readRequests, 1)
  assert.equal(f.frames[1].observation.freshness.snapshot.materialBytes, 500000)
  assert.equal(f.frames[2].observation.freshness.status, 'collected')
})

test('INV-80 pre/post external mutation produces failed capture with authoritative real costs; next round recaptures', async (t) => {
  const f = await fixture(t, steady(3), { custom: true })
  await f.session.observe(snapshot())
  f.onRead = async (_input, _result, reads) => {
    if (reads === 3) await writeFile(join(f.workspace, 'facts.json'), '{"active":{"items":[4]}}')
  }
  await collect(f)
  assert.equal(f.reads, 6)
  assert.equal(f.runs.filter((item) => item.derive).length, 2)
  assert.equal(f.frames[1].observation.freshness.reason, 'snapshot-capture-failed')
  assert.equal(f.frames[1].observation.freshness.snapshot.readRequests, 2)
  assert.equal(f.frames[1].observation.freshness.snapshot.derived, false)
  const records = await f.records()
  const archived = records.find((record) => record.body.includes('PROJECT_SNAPSHOT_COST'))
  assert.ok(archived)
  const diagnostic = JSON.parse(archived.body).diagnostic
  assert.equal(diagnostic.code, 'PROJECT_SNAPSHOT_COST')
  assert.equal(JSON.parse(diagnostic.message).readRequests, 2)
  assert.ok(JSON.parse(diagnostic.message).materialBytes > 0)
})

test('INV-80 a reset during authorized capture does not republish captured values in the new stage', async (t) => {
  const f = await fixture(t, steady(1), { custom: true })
  await f.session.observe(snapshot())
  f.onRead = async (_input, _result, count) => {
    if (count === 2)
      await f.session.context.append({
        kind: 'audit',
        title: 'search:history-reset',
        body: 'Authorize a new stage during capture',
      })
  }
  await collect(f)
  assert.equal(f.reads, 2)
  assert.equal(f.runs.filter((item) => item.derive).length, 0)
  const archived = (await f.records())
    .filter((record) => record.title.endsWith(':result'))
    .map((record) => {
      try {
        return JSON.parse(record.body)
      } catch {
        return null
      }
    })
    .find((value) => value?.kind === 'snapshot-capture')
  assert.equal(archived.result.failed.code, 'CONFLICT')
  assert.equal(archived.capture, undefined)
  assert.equal(f.frames[0].observation.sourceRef, null)
})

test('INV-80 provider incarnation replacement and process restart force actual capture and fresh derivation', async (t) => {
  const f = await fixture(
    t,
    async function* (request, f) {
      if (f.calls === 1) await f.replaceKernel()
      yield* steady(2)(request, f)
    },
    { custom: true }
  )
  await f.session.observe(snapshot())
  await collect(f)
  assert.equal(f.runs.filter((item) => item.derive).length, 2)
  assert.equal(f.reads, 4)
  f.stream = () => ({
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      throw new AppError('UNAVAILABLE', 'fixture stops with task active')
    },
  })
  await f.session.observe(snapshot())
  await collect(f)
  const previous = f.frames.at(-1).observation.freshness.executionId
  await f.restart()
  f.stream = async function* (request) {
    yield* done(request)
  }
  await collect(f)
  assert.equal(f.frames.at(-1).observation.freshness.status, 'collected')
  assert.notEqual(f.frames.at(-1).observation.freshness.executionId, previous)
})

test('INV-80 missing result attachment provenance forces fresh derivation after real capture', async (t) => {
  const f = await fixture(
    t,
    async function* (request, f) {
      if (f.calls === 1) {
        const ref = f.frames[0].observation.resultRef
        const state = await f.storage.load('s')
        const record = state.records.find((item) => item.ref.id === ref)
        const result = JSON.parse(await f.storage.get('s', record.objectId))
        result.attachments = [{ sessionId: 's', id: 'missing-image-object' }]
        const objectId = await f.storage.put('s', JSON.stringify(result))
        assert.equal(
          await f.storage.compareAndSwap('s', state.version, {
            ...state,
            version: state.version + 1,
            records: state.records.map((item) => (item === record ? { ...item, objectId } : item)),
          }),
          true
        )
      }
      yield* steady(2)(request, f)
    },
    { custom: true }
  )
  await f.session.observe(snapshot())
  await collect(f)
  assert.equal(f.reads, 4)
  assert.equal(f.runs.filter((item) => item.derive).length, 2)
  assert.equal(f.frames[1].observation.freshness.reason, 'attachment-or-result-unavailable')
})

test('INV-80 failed pure derivations never reuse and paused observation is not revived by refresh', async (t) => {
  const f = await fixture(
    t,
    async function* (request, f) {
      if (f.calls === 3) {
        yield {
          type: 'text',
          text: block(request, { sourceRef: f.frames.at(-1).observation.sourceRef, refresh: true }),
        }
        yield stop
      } else yield* steady(4)(request, f)
    },
    { custom: true }
  )
  await writeFile(join(f.workspace, 'facts.json'), '{invalid json}')
  await f.session.observe(snapshot())
  await collect(f)
  assert.equal(f.reads, 6)
  assert.equal(f.runs.filter((item) => item.derive).length, 3)
  assert.deepEqual(
    f.frames.map((frame) => frame.observation.freshness.status),
    ['collected', 'collected', 'collected', 'paused']
  )
})

test('INV-80 accepted refresh forces pure derivation; clear retires the plan without later IO', async (t) => {
  const f = await fixture(
    t,
    async function* (request, f) {
      if (f.calls === 1) {
        yield {
          type: 'text',
          text: block(request, { sourceRef: f.frames.at(-1).observation.sourceRef, refresh: true }),
        }
        yield stop
      } else if (f.calls === 2) {
        yield { type: 'text', text: block(request, { clear: true }) }
        yield stop
      } else yield* done(request)
    },
    { custom: true }
  )
  await f.session.observe(snapshot())
  await collect(f)
  assert.equal(f.reads, 4)
  assert.equal(f.runs.filter((item) => item.derive).length, 2)
  assert.equal(f.frames[1].observation.freshness.reason, 'refresh-requested')
  assert.equal(f.frames[2].observation.sourceRef, null)
})

test('INV-80 revoked authorization and project escape fail through real Kernel without cached output reuse', async (t) => {
  const f = await fixture(
    t,
    async function* (request, f) {
      if (f.calls === 1)
        f.onCapture = async () => {
          throw new AppError('PERMISSION', 'permission revoked')
        }
      yield* steady(2)(request, f)
    },
    { custom: true }
  )
  await f.session.observe(snapshot())
  await collect(f)
  assert.equal(f.reads, 2)
  assert.equal(f.frames[1].observation.freshness.reason, 'snapshot-capture-failed')
  assert.equal(f.frames[1].observation.freshness.snapshot.readRequests, undefined)
  const secret = join(f.root, 'protected.txt')
  await writeFile(secret, 'PROTECTED')
  await symlink(secret, join(f.workspace, 'outside.txt'))
  f.onCapture = async () => {}
  f.stream = async function* (request) {
    yield* done(request)
  }
  await f.session.observe(
    snapshot([{ path: 'outside.txt', key: 'outside', purpose: 'Escape must be rejected' }])
  )
  const before = f.reads
  await collect(f)
  assert.equal(f.reads, before)
  assert.equal(f.frames.at(-1).observation.freshness.reason, 'snapshot-capture-failed')
  assert.equal(await readFile(secret, 'utf8'), 'PROTECTED')
})

test('INV-80 cancellation returns promptly with unknown cost, then late physical IO settles in the authoritative journal and trace', async (t) => {
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  t.after(() => gate.resolve())
  const f = await fixture(t, steady(3), { custom: true })
  const expectedMaterialBytes = (await readFile(join(f.workspace, 'facts.json'))).byteLength
  await f.session.observe(snapshot())
  const controller = new AbortController()
  f.beforeRead = async (_input, count) => {
    if (count === 3) {
      entered.resolve()
      await gate.promise
    }
  }
  const timers = new TimerScope({ name: 'snapshot-cancellation-proof' })
  try {
    const pending = collect(f, controller.signal)
    await timers.withTimeout(2000, () => entered.promise)
    const started = performance.now()
    controller.abort(new AppError('CANCELLED', 'stop current capture'))
    const events = await timers.withTimeout(1000, () => pending)
    assert.notEqual(events.at(-1).status, 'completed')
    assert.ok(performance.now() - started < 1000)
    assert.equal(f.calls, 1, 'the next model request was never sent')
    assert.equal(f.reads, 3)
    assert.equal(f.readCompletions, 2, 'the cancelled physical read has not completed')
    assert.equal(
      f.runs.filter((item) => item.derive).length,
      1,
      'cancelled capture does not derive or reuse'
    )
    const records = await f.records()
    const failed = records
      .filter((record) => record.title.endsWith(':result'))
      .map((record) => JSON.parse(record.body))
      .find((value) => value.kind === 'snapshot-capture' && value.result.failed)
    assert.ok(failed)
    assert.equal(failed.capture, undefined)
    assert.equal(failed.diagnostic, undefined)
    const decisions = records
      .filter((record) => record.title === 'script:lease-state')
      .map((record) => JSON.parse(record.body).observationCollection)
      .filter((value) => value?.snapshot?.captureExecutionId === failed.executionId)
    assert.ok(decisions.length > 0)
    assert.ok(
      decisions.every(
        (value) =>
          value.snapshot.readRequests === undefined &&
          value.snapshot.materialBytes === undefined &&
          !value.snapshot.derived &&
          !value.snapshot.reused
      )
    )
    const journal = createContextInvocationJournal(f.storage)
    const invocationId = `${failed.executionId}:1`
    const before = await journal.read('s', invocationId)
    assert.equal(before.phase, 'prepared')
    assert.equal(before.receipt, undefined)
    const beforeTrace = await f.runtime.trace('s', { fullContent: true, limit: 8 })
    const beforeActivity = beforeTrace.sessionActivity.entries.find(
      (item) => item.executionId === failed.executionId
    )
    assert.equal(beforeActivity.kind, 'snapshot-capture')
    assert.equal(beforeActivity.invocations.length, 1)
    assert.ok(beforeActivity.invocations[0].body.includes('prepared'))
    assert.ok(
      beforeTrace.turns.every((turn) =>
        turn.invocations.every((item) => item.executionId !== failed.executionId)
      ),
      'an unsent capture is an independent session activity'
    )
    gate.resolve()
    const settled = await timers.withTimeout(2000, async (signal) => {
      for (;;) {
        signal.throwIfAborted()
        const current = await journal.read('s', invocationId)
        if (current?.phase === 'settled') return current
        await timers.sleep(5, { signal })
      }
    })
    assert.equal(settled.receipt.outcome, 'cancelled')
    assert.equal(f.readCompletions, 3, 'the late journal follows the actual physical read')
    assert.equal(settled.receipt.diagnostic.code, 'PROJECT_SNAPSHOT_COST')
    assert.equal(JSON.parse(settled.receipt.diagnostic.message).readRequests, 1)
    assert.equal(
      JSON.parse(settled.receipt.diagnostic.message).materialBytes,
      expectedMaterialBytes
    )
    const trace = await f.runtime.trace('s', { fullContent: true, limit: 8 })
    const activity = trace.sessionActivity.entries.find(
      (item) => item.executionId === failed.executionId
    )
    const captured = activity?.invocations.find((item) => item.id === invocationId)
    assert.ok(captured, JSON.stringify({ failed, settled, activity }))
    assert.ok(
      trace.turns.every((turn) =>
        turn.invocations.every((item) => item.executionId !== failed.executionId)
      ),
      'late settlement does not create a model request'
    )
    assert.equal(captured.summary.status, 'cancelled')
    assert.ok(captured.body.includes('PROJECT_SNAPSHOT_COST'))
    assert.equal(
      JSON.parse(JSON.parse(captured.body).receipt.diagnostic.message).materialBytes,
      expectedMaterialBytes
    )
    assert.equal(
      JSON.parse(activity.records.find((record) => record.title.endsWith(':result')).body)
        .diagnostic,
      undefined,
      'host failure and current journal receipt remain separate facts'
    )
    const original = (await f.records()).find(
      (record) => record.title === `script:${failed.executionId}:result`
    )
    assert.equal(
      JSON.parse(original.body).diagnostic,
      undefined,
      'original unknown-cost decision is immutable'
    )
  } finally {
    gate.resolve()
    timers.dispose()
  }
})

test('INV-80 snapshot protocol only accepts empty, exclusive literal plan blocks', () => {
  const decoder = new ScriptTurnDecoder('@@sfixed')
  decoder.push(`@@sfixed observe(${JSON.stringify(snapshot())})\n@@sfixed\n`)
  assert.deepEqual(decoder.finish().submission.observe, snapshot())
  for (const fields of [
    { ...snapshot(), sourceRef: 'bad' },
    { ...snapshot(), input: {} },
    { ...snapshot(), edits: [] },
  ]) {
    const invalid = new ScriptTurnDecoder('@@sfixed')
    invalid.push(`@@sfixed observe(${JSON.stringify(fields)})\n@@sfixed\n`)
    assert.throws(() => invalid.finish(), { code: 'SCRIPT_PROTOCOL' })
  }
  const nonempty = new ScriptTurnDecoder('@@sfixed')
  nonempty.push(`@@sfixed observe(${JSON.stringify(snapshot())})\noutput('unexpected')\n@@sfixed\n`)
  assert.throws(() => nonempty.finish(), { code: 'SCRIPT_PROTOCOL' })
})
