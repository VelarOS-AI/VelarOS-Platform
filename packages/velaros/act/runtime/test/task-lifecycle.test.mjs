import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { createRuntime } from '../../../dist/act/runtime/index.js'

import { done } from './support/model-turn.mjs'

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
    runner: nodeSubprocessCodeRunner,
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
    runner: nodeSubprocessCodeRunner,
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
    runner: nodeSubprocessCodeRunner,
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

test('uncertain observation effects pause immediately and are never retried automatically', async (t) => {
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
    runner: nodeSubprocessCodeRunner,
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
})

test('INV-27 repeated observer failures pause across restart; a substantive source update resumes collection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'act-health-'))
  const path = join(root, 'state.sqlite')
  let reads = 0
  let fail = true
  const frames = []
  const options = () => ({
    storage: localContextStorage({ path }),
    runner: nodeSubprocessCodeRunner,
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
})

test('completed task snapshot keeps accepted turns and a fixed archive boundary', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    agents: false,
    search: false,
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
