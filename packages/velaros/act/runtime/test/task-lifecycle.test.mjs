import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'

import { done } from './support/model-turn.mjs'
import { createTestRuntime as createRuntime } from './support/runtime-fixture.mjs'

async function submit(session, input) {
  const events = []
  for await (const e of session.submit(input)) events.push(e)
  return events
}
const limits = { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 }
const estimate = async () => ({ tokens: 1000, precision: 'exact', basis: 'test' })
test('INV-26 continue keeps task identity and accounting; new archives the previous task and resets resident state', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  const frames = []
  const runtime = await createRuntime({
    storage,
    modules: [],
    context: { maintenance: false },
    model: {
      id: 'task',
      limits,
      estimate,
      async *stream(request) {
        frames.push(JSON.parse(request.materials[0].text))
        yield* done(request)
      },
    },
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('root')
  await session.observe({ source: "import {output} from 'velaros';output('old observation');" })
  assert.equal((await submit(session, 'First task')).at(-1).status, 'completed')
  const first = await session.view.inspect()
  await session.execute({
    source:
      "import {memory as workspace} from 'velaros:system';await workspace.update({key:'progress',baseRevision:0,body:'old note'});",
  })
  assert.equal(
    (await submit(session, { text: 'Continue', task: 'continue' })).at(-1).status,
    'completed'
  )
  const continued = await session.view.inspect()
  assert.equal(continued.id, first.id)
  assert(continued.usage.mainCalls > first.usage.mainCalls)
  assert.equal(frames[1].partitions.workspace.notes[0].text, 'old note')
  assert.equal(
    (await submit(session, { text: 'Different task', task: 'new' })).at(-1).status,
    'completed'
  )
  const next = await session.view.inspect()
  assert.notEqual(next.id, first.id)
  assert.equal(next.goals.length, 1)
  assert.equal(next.usage.mainCalls, 1)
  assert(next.revision > continued.revision)
  const frame = frames[2]
  assert.equal(frame.partitions.observation.sourceRef, null)
  assert.deepEqual(frame.partitions.workspace.notes, [])
  assert.deepEqual(frame.partitions.recent.results, [])
  assert((await storage.load('root')).records.some((r) => r.title === `task:archive:${first.id}`))
  assert.equal((await session.context.read(first.goals[0])).text, 'First task')
})

test('inputs of earlier runs stay in the task as context and are marked earlier', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  const frames = []
  const runtime = await createRuntime({
    storage,
    modules: [],
    context: { maintenance: false },
    model: {
      id: 'task',
      limits,
      estimate,
      async *stream(request) {
        frames.push(JSON.parse(request.materials[0].text))
        yield* done(request, 'answered')
      },
    },
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('root')
  await submit(session, 'first question')
  await submit(session, 'follow-up question')
  const goals = frames.at(-1).partitions.task.goals
  assert.deepEqual(
    goals.map((goal) => [goal.text, goal.earlier === true]),
    [
      ['first question', true],
      ['follow-up question', false],
    ]
  )
  assert.equal(frames[0].partitions.task.goals[0].earlier, undefined)
})

test('unknown effects do not stop the user from starting a new task', async (t) => {
  const runtime = await createRuntime({
    storage: localContextStorage({ path: ':memory:' }),
    modules: [
      {
        binding: {
          moduleId: 'test:unknown',
          instanceId: 'one',
          generation: 1,
          schemaRevision: '1',
        },
        summary: 'unknown',
        operations: {
          write: {
            summary: 'write',
            input: { type: 'null' },
            output: { type: 'null' },
            effects: 'write',
            run: () => {
              throw Error('lost reply')
            },
          },
        },
      },
    ],
    context: { maintenance: false },
    model: {
      id: 'task',
      limits,
      estimate,
      async *stream(request) {
        yield* done(request)
      },
    },
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('root')
  await submit(session, 'Initial')
  await session.execute({ source: "import {write} from 'test:unknown';await write();" })
  const task = await session.view.inspect()
  assert(task.mandatory.some((item) => item.effect === 'unknown'))
  const events = await submit(session, { task: 'new', text: 'Another task' })
  assert.equal(events.at(-1).status, 'completed')
  assert.notEqual((await session.view.inspect()).id, task.id)
})

test(
  'uncertain observation effects pause immediately and are never retried automatically',
  {
    skip:
      process.platform !== 'darwin' && process.platform !== 'linux'
        ? 'Dispatching an observation requires the default read-only process backend.'
        : false,
  },
  async (t) => {
    let dispatches = 0
    const frames = []
    const collect = () => {
      dispatches++
      throw Error('transport lost after dispatch')
    }
    const module = {
      binding: { moduleId: 'test:observe', instanceId: 'one', generation: 1, schemaRevision: '1' },
      summary: 'constrained command',
      operations: {
        read: {
          summary: 'collect',
          input: { type: 'null' },
          output: { type: 'null' },
          effects: 'write',
          allowedModes: ['observe', 'execute'],
          observe: collect,
          run: collect,
        },
      },
    }
    const runtime = await createRuntime({
      storage: localContextStorage({ path: ':memory:' }),
      modules: [module],
      context: { maintenance: false },
      model: {
        id: 'uncertain',
        limits,
        estimate,
        async *stream(request) {
          frames.push(JSON.parse(request.materials[0].text))
          yield* done(request)
        },
      },
    })
    t.after(() => runtime.close())
    const session = await runtime.openSession('root')
    await session.observe({ source: "import {read} from 'test:observe';await read();" })
    assert.equal((await submit(session, 'Inspect')).at(-1).status, 'completed')
    assert.equal(dispatches, 1)
    assert.equal(frames[0].partitions.observation.health.status, 'paused')
    await submit(session, 'Continue inspection')
    assert.equal(dispatches, 1)
    assert((await session.view.inspect()).mandatory.some((item) => item.effect === 'unknown'))
  }
)

test(
  'INV-27 repeated observer failures pause across restart; a substantive source update resumes collection',
  {
    skip:
      process.platform !== 'darwin' && process.platform !== 'linux'
        ? 'Observer RPC failure and recovery require the default read-only process backend.'
        : false,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'act-health-'))
    const path = join(root, 'state.sqlite')
    let reads = 0
    let fail = true
    const frames = []
    const options = () => ({
      storage: localContextStorage({ path }),
      context: { maintenance: false },
      modules: [
        {
          binding: { moduleId: 'test:read', instanceId: 'one', generation: 1, schemaRevision: '1' },
          summary: 'read',
          operations: {
            read: {
              summary: 'read',
              input: { type: 'null' },
              output: { type: 'integer' },
              effects: 'none',
              run: () => {
                reads++
                if (fail) throw Error('unavailable')
                return 7
              },
            },
          },
        },
      ],
      model: {
        id: 'health',
        limits,
        estimate,
        async *stream(request) {
          frames.push(JSON.parse(request.materials[0].text))
          yield* done(request)
        },
      },
    })
    let runtime = await createRuntime(options())
    let session = await runtime.openSession('root')
    t.after(async () => {
      await runtime.close()
      await rm(root, { recursive: true, force: true })
    })
    const source =
      "import {output} from 'velaros';import {read} from 'test:read';output(await read(),{key:'state'});"
    await session.observe({ source })
    for (let i = 0; i < 3; i++) await submit(session, 'Inspect')
    assert.equal(reads, 3)
    assert.equal(frames.at(-1).partitions.observation.health.status, 'paused')
    await runtime.close()
    runtime = await createRuntime(options())
    session = await runtime.openSession('root')
    await submit(session, 'Inspect again')
    assert.equal(reads, 3)
    assert.equal(frames.at(-1).partitions.observation.health.status, 'paused')
    fail = false
    await session.observe({ source: `${source}\n// repaired data source` })
    await submit(session, 'Inspect fixed source')
    assert.equal(reads, 4)
    assert.equal(frames.at(-1).partitions.observation.health.status, 'healthy')
  }
)

test('completed task snapshot keeps accepted turns and a fixed archive boundary', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  const runtime = await createRuntime({
    storage,

    context: { maintenance: false },
    model: {
      id: 'snapshot',
      limits,
      estimate,
      async *stream(request) {
        yield* done(request)
      },
    },
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('snapshot-root')
  assert.equal(await session.completedTask(), null)
  await submit(session, 'first task')
  const first = await session.completedTask()
  assert.ok(first)
  assert.equal(first.completedTurns, 1)
  assert.equal(first.sessionId, session.id)
  assert.equal(first.taskId, (await session.view.inspect()).id)
  assert.ok(first.through > first.after)
  assert.equal((await session.context.readInput(first.inputs[0])).text, 'first task')
  await submit(session, { text: 'second task', task: 'new' })
  const second = await session.completedTask()
  assert.notEqual(second.taskId, first.taskId)
  assert.equal(second.completedTurns, 1)
  assert.ok(second.after >= first.through)
  const records = await session.taskMaterials(first)
  assert.ok(records.length > 0)
  assert.ok(
    records.every((record) => record.sequence > first.after && record.sequence <= first.through)
  )
  assert.equal((await session.readTaskMaterial(first, first.inputs[0])).text, 'first task')
  await assert.rejects(session.readTaskMaterial(first, second.inputs[0]), { code: 'VALIDATION' })
  assert.equal(first.completedTurns, 1)
})

for (const [name, barrierMethod] of [
  ['completedTask', 'load'],
  ['taskMaterials', 'records'],
  ['readTaskMaterial', 'get'],
  ['trace', 'load'],
  ['runtime.trace', 'load'],
  ['runtime.traceBranches', 'selectSnapshot'],
])
  test(`host material reads drain before storage closes and reject new admission (${name})`, async (t) => {
    const storage = localContextStorage({ path: ':memory:' })
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    const order = []
    let armed = false
    let closed = false
    let reads = 0
    let closing
    for (const method of ['load', 'records', 'get', 'selectSnapshot']) {
      const read = storage[method].bind(storage)
      storage[method] = async (...args) => {
        reads++
        if (armed && method === barrierMethod) {
          armed = false
          closing = runtime.close({ timeoutMs: 20 })
          entered.resolve()
          await release.promise
          order.push('read-resumed')
        }
        assert.equal(closed, false, 'accepted reads retain the live storage owner')
        return read(...args)
      }
    }
    const close = storage.close.bind(storage)
    storage.close = async () => {
      order.push('storage-close')
      closed = true
      await close()
    }
    // eslint-disable-next-line prefer-const -- 初始化前登记清理；初始化拒绝时也必须关闭存储。
    let runtime
    t.after(async () => {
      release.resolve()
      await runtime?.close()
      if (!closed) await storage.close()
    })
    runtime = await createRuntime({
      storage,
      runner: { run: async () => assert.fail('host material reads must not execute programs') },
      context: { maintenance: false },
      model: {
        id: 'material-read-lifecycle',
        limits,
        estimate,
        async *stream(request) {
          yield* done(request)
        },
      },
    })
    const session = await runtime.openSession('material-read')
    await submit(session, 'completed source task')
    const task = await session.completedTask()
    assert.ok(task)
    const state = await storage.load(session.id)
    const turn = state.records.find((record) => record.title === 'model-request').ref.id
    await session.close()
    assert.equal(
      runtime.getSession(session.id),
      undefined,
      'history reads do not reactivate a session'
    )
    const lookups = {
      completedTask: () => session.completedTask(),
      taskMaterials: () => session.taskMaterials(task),
      readTaskMaterial: () => session.readTaskMaterial(task, task.inputs[0]),
      trace: () => session.trace(turn),
      'runtime.trace': () => runtime.trace(session.id, { limit: 1 }),
      'runtime.traceBranches': () => runtime.traceBranches(session.id),
    }
    armed = true
    const pending = lookups[name]()
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => assert.fail('the accepted read did not reach its storage barrier')),
      ])
      await assert.rejects(closing, {
        code: 'TIMEOUT',
        phase: 'sessions',
      })
      assert.equal(closed, false)
      const before = reads
      for (const lookup of Object.values(lookups)) await assert.rejects(lookup, { code: 'CLOSED' })
      assert.equal(reads, before, 'closed admission must not reach the storage port')
      release.resolve()
      const value = await pending
      if (name === 'completedTask') assert.equal(value.taskId, task.taskId)
      else if (name === 'taskMaterials')
        assert.ok(value.length && value.every((record) => record.sequence <= task.through))
      else if (name === 'readTaskMaterial') assert.equal(value.text, 'completed source task')
      else if (name === 'trace') assert.equal(value.turnId, turn)
      else if (name === 'runtime.trace') assert.equal(value.turns[0].turnId, turn)
      else assert.deepEqual(value, [])
      assert.equal(runtime.getSession(session.id), undefined)
    } finally {
      release.resolve()
      await Promise.allSettled([pending])
      await runtime.close()
    }
    assert.equal(closed, true)
    assert.deepEqual(order, ['read-resumed', 'storage-close'])
  })

test('host material reads keep closed session history bound to the live Runtime authority', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  let modelCalls = 0
  const runtime = await createRuntime({
    storage,
    runner: { run: async () => assert.fail('history reads must not execute programs') },
    context: { maintenance: false },
    model: {
      id: 'closed-session-history',
      limits,
      estimate,
      async *stream(request) {
        modelCalls++
        yield* done(request)
      },
    },
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('closed-history')
  await submit(session, 'first fixed task')
  const first = await session.completedTask()
  const turn = (await storage.load(session.id)).records.find(
    (record) => record.title === 'model-request'
  ).ref.id
  await submit(session, { text: 'second current task', task: 'new' })
  const current = await session.completedTask()
  await session.close()
  const calls = modelCalls
  assert.equal(runtime.getSession(session.id), undefined)
  assert.equal((await session.completedTask()).taskId, current.taskId)
  const materials = await session.taskMaterials(first)
  assert.ok(materials.length && materials.every((record) => record.sequence <= first.through))
  assert.equal((await session.readTaskMaterial(first, first.inputs[0])).text, 'first fixed task')
  await assert.rejects(session.readTaskMaterial(first, current.inputs[0]), { code: 'VALIDATION' })
  await assert.rejects(
    session.readTaskMaterial(first, { ...first.inputs[0], sessionId: 'foreign' }),
    { code: 'VALIDATION' }
  )
  assert.equal((await session.trace(turn)).turnId, turn)
  assert.equal((await runtime.trace(session.id, { limit: 1 })).turns[0].turnId, turn)
  assert.deepEqual(await runtime.traceBranches(session.id), [])
  await assert.rejects(session.execute({ source: 'export default 1;' }), { code: 'CLOSED' })
  const original = await storage.load(session.id)
  const record = original.records.find((item) => item.title === 'runtime:binding')
  const binding = JSON.parse(await storage.get(session.id, record.objectId))
  const replaceBinding = async (document) => {
    const state = await storage.load(session.id)
    const body = JSON.stringify(document)
    const objectId = await storage.put(session.id, body)
    assert.ok(
      await storage.compareAndSwap(session.id, state.version, {
        ...state,
        version: state.version + 1,
        records: state.records.map((item) =>
          item.ref.id === record.ref.id ? { ...item, objectId, chars: body.length } : item
        ),
      })
    )
  }
  const lookups = [
    () => session.completedTask(),
    () => session.taskMaterials(first),
    () => session.readTaskMaterial(first, first.inputs[0]),
    () => session.trace(turn),
    () => runtime.trace(session.id),
    () => runtime.traceBranches(session.id),
  ]
  for (const field of ['executionIdentity', 'authorizationScope']) {
    await replaceBinding({ ...binding, [field]: `${binding[field]}:changed` })
    for (const lookup of lookups) await assert.rejects(lookup, { code: 'CONFLICT' })
    await replaceBinding(binding)
    assert.equal((await session.completedTask()).taskId, current.taskId)
  }
  assert.deepEqual((await runtime.trace('missing')).turns, [])
  assert.deepEqual(await runtime.traceBranches('missing'), [])
  assert.equal(await storage.load('missing'), null)
  assert.equal(modelCalls, calls)
  assert.equal(runtime.getSession(session.id), undefined, 'history reads never reopen execution')
})

test('host material reads reject admission from a synchronous model cancellation callback', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  const entered = Promise.withResolvers()
  const selectSnapshot = storage.selectSnapshot.bind(storage)
  let authorityReads = 0
  storage.selectSnapshot = (sessionId, selections) => {
    if (selections.some((item) => item.title === 'runtime:binding')) authorityReads++
    return selectSnapshot(sessionId, selections)
  }
  // eslint-disable-next-line prefer-const -- 模型取消回调先声明，再绑定实际打开的会话句柄。
  let session
  let attempted
  const runtime = await createRuntime({
    storage,
    runner: { run: async () => assert.fail('cancellation must not execute programs') },
    context: { maintenance: false },
    model: {
      id: 'close-admission-reentrancy',
      limits,
      estimate,
      async *stream(request, signal) {
        const stopped = Promise.withResolvers()
        const cancel = () => {
          attempted = session.completedTask().then(
            (value) => ({ value }),
            (error) => ({ error })
          )
          stopped.resolve()
        }
        signal.addEventListener('abort', cancel, { once: true })
        try {
          entered.resolve()
          await stopped.promise
          signal.throwIfAborted()
          yield* done(request)
        } finally {
          signal.removeEventListener('abort', cancel)
        }
      },
    },
  })
  t.after(() => runtime.close())
  session = await runtime.openSession('close-admission')
  const running = submit(session, 'wait for Runtime close')
  const settled = Promise.allSettled([running])
  try {
    await entered.promise
    const before = authorityReads
    await runtime.close()
    assert.ok(attempted, 'the real model cancellation listener must run')
    assert.equal((await attempted).error?.code, 'CLOSED')
    assert.equal(authorityReads, before, 'reentrant history admission must not read storage')
  } finally {
    await runtime.close()
    await settled
  }
})

test('memory consolidation reads materials over multiple rounds and stages knowledge without writing', async () => {
  const { createMemoryConsolidation } = await import('../../../dist/act/runtime/index.js')
  let calls = 0
  let reads = 0
  const result = await createMemoryConsolidation().run({
    task: {
      sessionId: 'source',
      taskId: 'task',
      after: 0,
      through: 10,
      completedTurns: 16,
      inputs: [{ sessionId: 'source', id: 'input' }],
    },
    source: {
      taskMaterials: async () => [],
      readTaskMaterial: async () => {
        reads++
        return { text: '根因是缓存键缺少工作区', offset: 0, totalChars: 13 }
      },
    },
    memory: {
      list: async () => [],
      save: async () => {
        throw Error('must not write')
      },
      remove: async () => {
        throw Error('must not remove')
      },
    },
    signal: new AbortController().signal,
    model: {
      id: 'memory-test',
      nativeTools: true,
      limits,
      estimate,
      async *stream(request) {
        calls++
        if (calls === 1)
          yield {
            type: 'tool-call',
            value: {
              id: 'read-1',
              name: 'read',
              input: { ref: { sessionId: 'source', id: 'input' } },
            },
          }
        else {
          assert.match(JSON.stringify(request), /缓存键/)
          yield {
            type: 'tool-call',
            value: {
              id: 'save-1',
              name: 'save',
              input: {
                id: 'cache-scope',
                type: 'work',
                title: '缓存隔离',
                description: '缓存键需要工作区',
                content: '缓存键必须包含工作区，避免跨项目复用。',
              },
            },
          }
          yield {
            type: 'tool-call',
            value: {
              id: 'done-1',
              name: 'submit',
              input: { baseRevision: 'task', summary: '已整理缓存隔离经验', unresolved: [] },
            },
          }
        }
        yield { type: 'finish', reason: 'stop' }
      },
    },
  })
  assert.equal(calls, 2)
  assert.equal(reads, 1)
  assert.equal(result.memories.length, 1)
  assert.equal(result.memories[0].expectedRevision, null)
})
