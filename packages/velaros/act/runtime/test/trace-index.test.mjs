import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createContextRuntime } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'

import { RuntimeDiagnostics } from '../../../dist/act/runtime/impl/RuntimeDiagnostics.js'
import { RuntimeTrace } from '../../../dist/act/runtime/impl/RuntimeTrace.js'

import { done, marker } from './support/model-turn.mjs'
import {
  createTestRuntime as createRuntime,
  createTestStorage,
} from './support/runtime-fixture.mjs'

test('bounded request metadata leaves the body budget for execution output and call previews', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  t.after(() => storage.close())
  const context = createContextRuntime({ sessionId: 'output-budget', storage })
  const request = await context.append({
    kind: 'audit',
    title: 'model-request',
    body: JSON.stringify({
      runId: 'run',
      turn: 0,
      repair: 0,
      requestAudit: {
        schemaVersion: 3,
        model: 'test',
        modelTruncated: false,
        inputTokens: 1000,
        precision: 'exact',
        basis: 'test',
        basisTruncated: false,
        messageCount: 1,
        toolCount: 0,
        outputTokens: 4096,
        requestFingerprint: { id: '1234567890abcdef' },
      },
    }),
  })
  const response = await context.append({ kind: 'assistant', body: 'run', sources: [request.ref] })
  await context.append({
    kind: 'audit',
    title: 'model-response',
    body: JSON.stringify({ rawRef: response.ref, status: 'accepted', decoded: { submission: {} } }),
    sources: [request.ref],
  })
  const source = await context.append({
    kind: 'audit',
    title: 'program',
    body: JSON.stringify({ source: 'console.log("visible output")' }),
  })
  const result = await context.append({
    kind: 'audit',
    title: 'script:execution:result',
    body: JSON.stringify({
      checked: true,
      effect: 'none',
      result: {
        process: { exitCode: 0, stdout: 'visible output', stderr: '', logPath: '/logs/run.log' },
      },
    }),
  })
  await context.append({
    kind: 'audit',
    title: 'script:dispatch',
    body: JSON.stringify({ controlId: 'control' }),
    sources: [request.ref],
  })
  await context.append({
    kind: 'audit',
    title: 'script:control:control',
    body: JSON.stringify({
      receipt: {
        executions: [
          { executionId: 'execution', sourceRef: source.ref.id, resultRef: result.ref.id },
        ],
      },
    }),
  })
  const journal = {
    list: async () => [
      {
        prepared: {
          id: 'call',
          executionId: 'execution',
          binding: { moduleId: 'velaros:test' },
          operation: 'read',
          input: { query: 'value' },
        },
        receipt: { outcome: 'succeeded', effect: 'none', value: { result: 'visible call result' } },
      },
    ],
  }
  const trace = await new RuntimeTrace('output-budget', storage, journal).read(
    request.ref.id,
    32_768
  )
  assert.equal(trace.executions[0].status, 'succeeded')
  assert.match(trace.executions[0].processOutput, /visible output/)
  assert.equal(trace.executions[0].processOutputTruncated, false)
  assert.match(trace.invocations[0].summary.output, /visible call result/)
  assert.equal(trace.invocations[0].summary.outputTruncated, false)
  assert.equal(trace.request.truncated, false)
  const total =
    [trace.request, trace.response, trace.decision, ...trace.records, ...trace.invocations].reduce(
      (n, v) => n + (v?.body?.length ?? 0),
      0
    ) +
    trace.executions.reduce((n, v) => n + v.source.length + (v.processOutput?.length ?? 0), 0) +
    trace.invocations.reduce((n, v) => n + v.summary.input.length + v.summary.output.length, 0)
  assert(total <= 32_768, 'presentation priority still obeys the total page budget')
})

test('exhausted trace budgets use presence probes without changing trace facts or loading historical bodies', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  t.after(() => storage.close())
  const context = createContextRuntime({ sessionId: 'budget', storage })
  const request = await context.append({
    kind: 'audit',
    title: 'model-request',
    body: JSON.stringify({ runId: 'run', turn: 0, repair: 0 }),
  })
  const response = await context.append({
    kind: 'assistant',
    body: 'completed',
    sources: [request.ref],
  })
  const decision = await context.append({
    kind: 'audit',
    title: 'model-response',
    body: JSON.stringify({
      rawRef: response.ref,
      status: 'accepted',
      decoded: { done: true },
      usage: { inputTokens: 123, outputTokens: 45 },
    }),
    sources: [request.ref],
  })
  const history = []
  for (let index = 0; index < 120; index++)
    history.push(
      await context.append({
        kind: 'audit',
        title: 'script:lease-state',
        body: JSON.stringify({ jobs: [], index, output: 'x'.repeat(10_000) }),
      })
    )
  const snapshot = await storage.load('budget')
  const objectOf = (ref) => snapshot.records.find((record) => record.ref.id === ref.id).objectId
  const read = async (directPresence, query, missing) => {
    const gets = []
    const checks = []
    let chars = 0
    const metrics = []
    const get = async (id, objectId) => {
      gets.push(objectId)
      const body = objectId === missing ? null : await storage.get(id, objectId)
      chars += body?.length ?? 0
      return body
    }
    const port = {
      load: (id) => storage.load(id),
      get,
      has: async (id, objectId) => {
        checks.push(objectId)
        // Both backends satisfy the current required has contract. The read-through
        // control measures the body IO that a real existence query avoids.
        return (
          objectId !== missing &&
          (directPresence ? storage.has(id, objectId) : (await get(id, objectId)) !== null)
        )
      },
    }
    const measured = new RuntimeDiagnostics(port, (metric) => metrics.push(metric)).storage
    const startedAt = performance.now()
    const trace = await new RuntimeTrace('budget', measured, { list: async () => [] }).page(query)
    return { trace, gets, checks, chars, metrics, durationMs: performance.now() - startedAt }
  }
  for (const missing of [undefined, objectOf(history[7].ref), objectOf(decision.ref)]) {
    for (const maxChars of [1, 32_768]) {
      const readThrough = await read(false, { limit: 1, maxChars }, missing)
      const indexed = await read(true, { limit: 1, maxChars }, missing)
      assert.deepEqual(indexed.trace, readThrough.trace)
      if (missing !== objectOf(decision.ref)) {
        assert.equal(indexed.trace.turns[0].modelAccounting.usage.inputTokens, 123)
        assert.equal(indexed.trace.accounting.modelRequests.known, 1)
      }
      assert(indexed.gets.length < readThrough.gets.length / 10)
      assert(indexed.chars < readThrough.chars / 10)
      assert(indexed.metrics.some((metric) => metric.operation === 'has'))
      assert(!indexed.checks.includes(objectOf(request.ref)), 'cached request is not checked twice')
      assert(
        !indexed.checks.includes(objectOf(decision.ref)),
        'cached decision/missing fact is retained'
      )
      assert(
        indexed.gets.includes(objectOf(history.at(-1).ref)),
        'latest lease still determines execution state'
      )
      if (missing)
        assert(
          indexed.trace.turns[0].gaps.some((gap) =>
            gap.includes(missing === objectOf(decision.ref) ? decision.ref.id : history[7].ref.id)
          )
        )
      t.diagnostic(
        `budget=${maxChars}, missing=${Boolean(missing)}: get ${readThrough.gets.length}->${indexed.gets.length}, body chars ${readThrough.chars}->${indexed.chars}, elapsed ${readThrough.durationMs.toFixed(2)}->${indexed.durationMs.toFixed(2)}ms`
      )
    }
  }
  const readThroughFull = await read(false, { limit: 1, maxChars: 1, fullContent: true })
  const indexedFull = await read(true, { limit: 1, maxChars: 1, fullContent: true })
  assert.deepEqual(indexedFull.trace, readThroughFull.trace)
  assert.deepEqual(indexedFull.gets, readThroughFull.gets)
  assert.deepEqual(indexedFull.checks, [])
})

test('trace pages use one metadata snapshot and query only associated execution journals', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  t.after(() => storage.close())
  const context = createContextRuntime({ sessionId: 's', storage })
  const executionId = crypto.randomUUID()
  const source = await context.append({ kind: 'audit', title: 'source', body: 'source' })
  const result = await context.append({
    kind: 'audit',
    title: `script:${executionId}:result`,
    body: '{}',
    sources: [source.ref],
  })
  const frame = await context.append({
    kind: 'audit',
    title: 'context:frame:selected',
    body: JSON.stringify({
      frameId: 'selected',
      entries: [],
      observation: { sourceRef: source.ref.id, resultRef: result.ref.id },
    }),
  })
  const requests = []
  for (let turn = 0; turn < 3; turn++) {
    const request = await context.append({
      kind: 'audit',
      title: 'model-request',
      body: JSON.stringify({
        runId: 'run',
        turn,
        repair: 0,
        frameRef: frame.ref,
      }),
    })
    requests.push(request)
    const response = await context.append({
      kind: 'assistant',
      body: 'done',
      sources: [request.ref],
    })
    await context.append({
      kind: 'audit',
      title: 'model-response',
      body: JSON.stringify({ rawRef: response.ref, status: 'accepted', decoded: { done: true } }),
      sources: [request.ref],
    })
  }
  let loads = 0
  const lookups = []
  const port = {
    load: async (id) => {
      loads++
      return storage.load(id)
    },
    get: (...args) => storage.get(...args),
  }
  const journal = {
    list: async (sessionId, id) => {
      assert.equal(sessionId, 's')
      assert.equal(id, executionId)
      lookups.push(id)
      return []
    },
  }
  const page = await new RuntimeTrace('s', port, journal).page({ limit: 3 })
  assert.equal(loads, 1)
  assert.equal(page.turns.length, 3)
  assert.equal(lookups.length, 3)
  assert(page.turns.every((turn) => turn.snapshotVersion === page.snapshotVersion))
  assert(page.turns.every((turn) => turn.records.some((record) => record.ref.id === source.ref.id)))
  assert(page.turns.every((turn) => Object.values(turn.timing).every((value) => value === null)))
  assert.equal(page.nextAfter, null)
  assert.equal(page.turns[0].nextTurnId, requests[1].ref.id)
})

test('execution summaries follow the declarations of their own turn and say why a script failed', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'trace-executions-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const ok = "// 读一个常量\nimport {output} from 'velaros'\noutput(1)"
  const boom = "import {output} from 'velaros'\nthrow new Error('boom')"
  const typo = "import {output} from 'velaros'\noutput(1 +)"
  let calls = 0
  const execute = (request, ...sources) => ({
    type: 'text',
    text: sources
      .map((source) => `${marker(request)} execute\n${source}\n${marker(request)}`)
      .join('\n'),
  })
  const runtime = await createRuntime({
    storage: await createTestStorage(dataDir),

    context: { maintenance: false },
    model: {
      id: 'trace-executions',
      limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
      async *stream(request) {
        calls++
        if (calls === 1) yield execute(request, ok, boom)
        else if (calls === 2) yield execute(request, typo)
        else return yield* done(request)
        yield { type: 'finish', reason: 'stop' }
      },
    },
  })
  try {
    const session = await runtime.openSession('s')
    const turns = []
    for await (const event of session.submit('run the scripts'))
      if (event.type === 'turn') turns.push(event.turnId)
    const [first, second, last] = await Promise.all(turns.map((id) => session.trace(id)))
    assert.deepEqual(
      first.executions.map((item) => [item.position, item.status, item.source]),
      [
        [0, 'succeeded', ok],
        [1, 'failed', boom],
      ]
    )
    assert.equal(first.executions[0].failure, null)
    assert(
      first.executions.every((item) => Number.isFinite(item.durationMs) && item.durationMs >= 0)
    )
    assert.equal(first.executions[1].failure.code, 'PROGRAM_ERROR')
    assert.match(first.executions[1].failure.message, /boom/)
    assert.equal(second.executions.length, 1)
    assert.equal(second.executions[0].status, 'failed')
    assert.equal(second.executions[0].failure.code, 'SCRIPT_CHECK')
    assert.equal(second.executions[0].failure.line, 2)
    assert.match(second.executions[0].failure.message, /Expression expected/)
    // 前两回合的结果仍在租约里、会出现在这一帧，但不是这一回合派发的
    assert.deepEqual(last.executions, [])
  } finally {
    await runtime.close()
  }
})

test('observation summaries say what a turn registered and which run fed its request', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'trace-observation-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const watch = "// 数一数\nimport {output} from 'velaros'\noutput(1)"
  const typo = "import {output} from 'velaros'\noutput(1 +)"
  let calls = 0
  const observe = (request, source) => ({
    type: 'text',
    text: `${marker(request)} observe\n${source}\n${marker(request)}`,
  })
  const runtime = await createRuntime({
    storage: await createTestStorage(dataDir),

    context: { maintenance: false },
    protocol: { allowed: ['execute', 'observe', 'done'] },
    model: {
      id: 'trace-observation',
      limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
      async *stream(request) {
        calls++
        if (calls === 1) yield observe(request, watch)
        else if (calls === 2) yield observe(request, typo)
        else return yield* done(request)
        yield { type: 'finish', reason: 'stop' }
      },
    },
  })
  try {
    const session = await runtime.openSession('s')
    const turns = []
    for await (const event of session.submit('keep watching'))
      if (event.type === 'turn') turns.push(event.turnId)
    const [first, second, last] = await Promise.all(turns.map((id) => session.trace(id)))
    assert.deepEqual(first.observation, {
      registration: {
        status: 'updated',
        failure: null,
        source: watch,
        sourceTruncated: false,
      },
      run: null,
    })
    // 没过检查的观察登记不上，原因与没过检查的执行同一套；这一回合的帧仍由原来的观察喂
    assert.equal(second.observation.registration.status, 'rejected')
    assert.equal(second.observation.registration.failure.code, 'OBSERVATION_CHECK')
    assert.equal(second.observation.registration.failure.line, 2)
    assert.match(second.observation.registration.failure.message, /Expression expected/)
    assert.equal(second.observation.registration.source, typo)
    for (const trace of [second, last]) {
      // Windows 的默认宿主无法约束只读进程；追踪应如实保留拒绝，不能把它当成成功。
      assert.equal(
        trace.observation.run.status,
        process.platform === 'win32' ? 'failed' : 'succeeded'
      )
      assert(
        Number.isFinite(trace.observation.run.durationMs) && trace.observation.run.durationMs >= 0
      )
      assert.equal(trace.observation.run.source, watch)
      if (process.platform === 'win32')
        assert.equal(trace.observation.run.failure.code, 'SHELL_CONFINEMENT_UNAVAILABLE')
      else assert.equal(trace.observation.run.failure, null)
      assert(
        trace.executions.every((item) => item.executionId !== trace.observation.run.executionId)
      )
    }
    assert.notEqual(second.observation.run.executionId, last.observation.run.executionId)
    assert.equal(last.observation.registration, null)
  } finally {
    await runtime.close()
  }
})

test('observation infrastructure failure has one structured result in the frame, archive and trace', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'trace-observation-rejection-'))
  const storage = localContextStorage({ path: join(dataDir, 'context.sqlite') })
  let runtime = null
  t.after(async () => {
    if (runtime) await runtime.close()
    else await storage.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const watch = "import {output} from 'velaros'; output('observation');"
  const failure = new Error('observation host cleanup failed: INFRASTRUCTURE_REJECTION_M12')
  const frames = []
  let runs = 0
  runtime = await createRuntime({
    storage,

    runner: {
      environment: 'node',
      cwd: dataDir,
      async run(request) {
        assert.equal(request.mode, 'observe')
        runs++
        throw failure
      },
    },
    context: {
      maintenance: false,
      observation: {
        scope: async () => 'observation-failure-scope',
        reuse: {
          coversNativeIO: true,
          probe: async () => ({ kind: 'versioned', providerId: 'fixture', token: 'unchanged' }),
        },
      },
    },
    protocol: { allowed: ['execute', 'observe', 'done'] },
    model: {
      id: 'trace-observation-rejection',
      limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
      async *stream(request) {
        const frame = JSON.parse(
          request.materials.findLast((item) => item.origin === 'runtime-view').text
        )
        frames.push(frame.partitions.observation)
        assert(frames.length <= 3, 'observer failure must not create an unbounded model loop')
        if (frames.length <= 2) {
          yield { type: 'text', text: `${marker(request)} observe\n${watch}\n${marker(request)}` }
          yield { type: 'finish', reason: 'stop' }
        } else yield* done(request, 'The observer host failed.')
      },
    },
  })
  const session = await runtime.openSession('s')
  const turns = []
  const events = []
  for await (const event of session.submit('Register the observer and report its real failure.')) {
    events.push(event)
    if (event.type === 'turn') turns.push(event.turnId)
  }
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
  assert.equal(frames.length, 3)
  assert.equal(runs, 2, 'failed collection cannot establish a reusable healthy baseline')
  assert.notEqual(frames[1].resultRef, frames[2].resultRef)
  for (const [index, frame] of frames.entries()) {
    if (index === 0) continue
    assert.equal(frame.freshness.status, 'collected')
    assert.equal(frame.freshness.reason, 'collection-incomplete')
    assert.notEqual(frame.health.status, 'healthy')
    assert(frame.text.includes(failure.message))
    const trace = await session.trace(turns[index])
    const run = trace.observation.run
    assert.equal(run.status, 'failed')
    assert.deepEqual(run.failure, { code: 'PROGRAM_ERROR', message: String(failure), line: null })
    assert.equal(run.source, watch)
    assert.equal(run.collection.resultRef, frame.resultRef)
    assert.equal(run.executionId, frame.freshness.executionId)
    assert.deepEqual(trace.executions, [])
    assert.deepEqual(
      trace.invocations,
      [],
      'no Kernel failure may hide a misclassified script result'
    )
    const selected = await storage.selectSnapshot('s', [
      { title: `script:${run.executionId}:result`, latest: true },
    ])
    assert.equal(selected.records.length, 1)
    const record = selected.records[0]
    const persisted = JSON.parse(await storage.get('s', record.objectId))
    assert.equal(persisted.executionId, run.executionId)
    assert.equal(persisted.mode, 'observe')
    assert.equal(persisted.checked, true)
    assert.deepEqual(persisted.result.failed, { code: 'PROGRAM_ERROR', message: String(failure) })
    assert.equal('error' in persisted, false)
    assert.equal(record.sources[0].id, frame.sourceRef)
    assert.equal(run.durationMs, persisted.timing.durationMs)
    assert(Number.isFinite(run.durationMs) && run.durationMs >= 0)
  }
})

test('full-content pages retain bodies beyond the normal budget and keep pagination', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  t.after(() => storage.close())
  const context = createContextRuntime({ sessionId: 'full', storage })
  const response = `${'r'.repeat(500_001)}RESPONSE_END`
  const requests = []
  for (let turn = 0; turn < 2; turn++) {
    const request = await context.append({
      kind: 'audit',
      title: 'model-request',
      body: JSON.stringify({
        runId: 'run',
        turn,
        repair: 0,
        requestAudit: {
          schemaVersion: 3,
          model: 'model',
          modelTruncated: false,
          inputTokens: 1000,
          precision: 'exact',
          basis: 'test',
          basisTruncated: false,
          messageCount: 1,
          toolCount: 0,
          outputTokens: 4096,
          requestFingerprint: { id: '1234567890abcdef' },
        },
      }),
    })
    requests.push(request)
    await context.append({ kind: 'assistant', body: response, sources: [request.ref] })
  }
  const trace = new RuntimeTrace('full', storage, { list: async () => [] })
  const bounded = await trace.page({ limit: 1, maxChars: 500 })
  assert.equal(bounded.turns[0].response.truncated, true)
  const first = await trace.page({ limit: 1, fullContent: true, maxChars: 500 })
  assert.equal(first.turns.length, 1)
  assert.deepEqual(first.turns[0].requestSummary, bounded.turns[0].requestSummary)
  assert.equal(first.turns[0].response.body, response)
  assert.equal(first.turns[0].response.truncated, false)
  assert.equal(first.nextAfter, requests[0].sequence)
  const second = await trace.page({ limit: 1, fullContent: true, after: first.nextAfter })
  assert.equal(second.turns[0].turnId, requests[1].ref.id)
  assert.equal(second.nextAfter, null)
})

for (const invalidAt of [0, 1, 'observe']) {
  test(`a rejected batch settles every declaration at its original position (${invalidAt})`, async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'trace-rejected-batch-'))
    t.after(() => rm(dataDir, { recursive: true, force: true }))
    const ok = "// 只有修复重试才应运行\nimport {output} from 'velaros'\noutput(73)"
    const typo = "import {output} from 'velaros'\noutput(1 +)"
    const sources = [0, 1].map((i) => (i === invalidAt ? typo : `${ok}\n// position ${i}`))
    let calls = 0
    const runtime = await createRuntime({
      storage: await createTestStorage(dataDir),

      context: { maintenance: false },
      protocol: { allowed: ['execute', 'observe', 'done'] },
      model: {
        id: 'trace-rejected-batch',
        limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
        estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
        async *stream(request) {
          calls++
          if (calls > 2) return yield* done(request)
          const tag = marker(request)
          const blocks =
            calls === 1
              ? [
                  ...(invalidAt === 'observe' ? [`${tag} observe\n${typo}\n${tag}`] : []),
                  ...sources.map((source) => `${tag} execute\n${source}\n${tag}`),
                ]
              : [`${tag} execute\n${ok}\n${tag}`]
          yield { type: 'text', text: blocks.join('\n') }
          yield { type: 'finish', reason: 'stop' }
        },
      },
    })
    try {
      const session = await runtime.openSession('s')
      const turns = []
      for await (const event of session.submit('检查失败后修复并重试'))
        if (event.type === 'turn') turns.push(event.turnId)
      const [rejected, repaired, completed] = await Promise.all(
        turns.map((id) => session.trace(id))
      )
      assert.deepEqual(
        rejected.executions.map((item) => [item.position, item.status, item.source]),
        sources.map((source, i) => [i, i === invalidAt ? 'failed' : 'cancelled', source])
      )
      for (const item of rejected.executions) {
        assert.equal(item.failure.code, item.position === invalidAt ? 'SCRIPT_CHECK' : 'CANCELLED')
        assert.equal(item.durationMs, null, 'rejected peers did not start a process')
      }
      assert.equal(new Set(rejected.executions.map((item) => item.executionId)).size, 2)
      assert.deepEqual(
        repaired.executions.map((item) => [item.status, item.source]),
        [['succeeded', ok]]
      )
      assert.deepEqual(completed.executions, [])
    } finally {
      await runtime.close()
    }
  })
}
