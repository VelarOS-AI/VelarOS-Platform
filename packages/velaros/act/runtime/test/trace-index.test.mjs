import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createContextRuntime } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'

import { RuntimeTrace } from '../../../dist/act/runtime/impl/RuntimeTrace.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'

import { done, marker } from './support/model-turn.mjs'

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
  const requests = []
  for (let turn = 0; turn < 3; turn++) {
    const request = await context.append({
      kind: 'audit',
      title: 'model-request',
      body: JSON.stringify({
        runId: 'run',
        turn,
        repair: 0,
        request: {
          materials: [
            {
              origin: 'runtime-view',
              text: JSON.stringify({
                partitions: {
                  task: { goals: [] },
                  observation: { sourceRef: source.ref.id, resultRef: result.ref.id },
                  recent: { results: [] },
                },
              }),
            },
          ],
        },
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
    dataDir,
    agents: false,
    search: false,
    memory: false,
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
    dataDir,
    agents: false,
    search: false,
    memory: false,
    context: { maintenance: false },
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
      registration: { status: 'updated', failure: null, source: watch, sourceTruncated: false },
      run: null,
    })
    // 没过检查的观察登记不上，原因与没过检查的执行同一套；这一回合的帧仍由原来的观察喂
    assert.equal(second.observation.registration.status, 'rejected')
    assert.equal(second.observation.registration.failure.code, 'OBSERVATION_CHECK')
    assert.equal(second.observation.registration.failure.line, 2)
    assert.match(second.observation.registration.failure.message, /Expression expected/)
    assert.equal(second.observation.registration.source, typo)
    for (const trace of [second, last]) {
      assert.equal(trace.observation.run.status, 'succeeded')
      assert(
        Number.isFinite(trace.observation.run.durationMs) && trace.observation.run.durationMs >= 0
      )
      assert.equal(trace.observation.run.source, watch)
      assert.equal(trace.observation.run.failure, null)
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
