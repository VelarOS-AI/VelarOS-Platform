import assert from 'node:assert/strict'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { createRuntime } from '../../../dist/act/runtime/index.js'

import { done, turn } from './support/model-turn.mjs'

function worldModule(world) {
  return {
    binding: { moduleId: 'test:world', instanceId: 'one', generation: 1, schemaRevision: '1' },
    summary: 'versioned state',
    operations: {
      read: {
        summary: 'read',
        input: { type: 'null' },
        output: { type: 'object' },
        effects: 'none',
        run: () => ({ value: world.value, version: String(world.revision) }),
      },
      write: {
        summary: 'write',
        input: { type: 'integer' },
        output: { type: 'object' },
        effects: 'write',
        run: (value) => {
          world.writes++
          world.value = value
          world.revision++
          return { value, version: String(world.revision) }
        },
      },
    },
  }
}
async function setup(t, world, stream) {
  const storage = localContextStorage({ path: ':memory:' })
  const model = {
    id: 'basis-test',
    limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
    stream,
  }
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    model,
    modules: [worldModule(world)],
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('root')
  await session.observe({
    source:
      "import {output} from 'velaros';import {read} from 'test:world';output(await read(),{key:'state'});",
  })
  return { session, storage }
}
async function submit(session) {
  let state
  for await (const e of session.submit('Observe and act')) if (e.type === 'state') state = e.status
  return state
}

test('INV-24 a world change after the model read it does not block a write', async (t) => {
  const world = { value: 1, revision: 1, writes: 0 }
  let calls = 0
  const f = await setup(t, world, async function* (request) {
    calls++
    if (calls === 1) {
      world.value = 2
      world.revision++
      yield turn(request, {
        execute: { source: "import {write} from 'test:world';await write(3);" },
      })
      yield { type: 'finish', reason: 'stop' }
    } else {
      assert.equal(world.writes, 1)
      yield* done(request)
    }
  })
  assert.equal(await submit(f.session), 'completed')
  assert.equal(world.writes, 1)
  assert.equal(world.value, 3)
})

test('INV-24 completion no longer re-checks what the model read: a change after the read does not bounce done', async (t) => {
  const world = { value: 1, revision: 1, writes: 0 }
  let calls = 0
  const f = await setup(t, world, async function* (request) {
    calls++
    // 模型读完之后世界变了：收尾照样接受，要不要重看由模型自己判断（ADR 0025）
    world.value = 2
    world.revision++
    assert.doesNotMatch(request.compiledPrompt, /STALE_OBSERVATION|OBSERVATION_UNVERIFIABLE/)
    yield* done(request)
  })
  assert.equal(await submit(f.session), 'completed')
  assert.equal(calls, 1)
  assert.equal(world.writes, 0)
})

test('INV-24 the frame carries only the gaps completion waits for, not the versions the model read', async (t) => {
  const world = { value: 1, revision: 1, writes: 0 }
  const f = await setup(t, world, async function* (request) {
    const decision = JSON.parse(request.materials[0].text).partitions.runtime.decision
    assert.deepEqual(Object.keys(decision).sort(), ['frameId', 'missing'])
    assert.deepEqual(decision.missing, [])
    yield* done(request)
  })
  assert.equal(await submit(f.session), 'completed')
})

test('INV-25 missing required observation lets writes through, but completion waits until the full value is delivered', async (t) => {
  const world = { value: 1, revision: 1, writes: 0 }
  let calls = 0
  const f = await setup(t, world, async function* (request) {
    calls++
    const decision = JSON.parse(request.materials[0].text).partitions.runtime.decision
    if (calls === 1) {
      assert.equal(decision.missing[0].key, 'state')
      yield turn(request, {
        execute: { source: "import {write} from 'test:world';await write(2);" },
      })
    } else if (calls === 2) {
      assert.equal(world.writes, 1)
      yield* done(request)
      return
    } else if (calls === 3) {
      assert.match(request.compiledPrompt, /CONTEXT_REQUIRED/)
      yield turn(request, {
        observe: {
          source:
            "import {output} from 'velaros';import {read} from 'test:world';output(await read(),{key:'state',required:true});",
        },
      })
    } else {
      assert.deepEqual(decision.missing, [])
      yield* done(request)
      return
    }
    yield { type: 'finish', reason: 'stop' }
  })
  await f.session.observe({
    source:
      "import {output} from 'velaros';import {read} from 'test:world';output(await read(),{key:'state',required:true,view:{mode:'reference'}});",
  })
  assert.equal(await submit(f.session), 'completed')
  assert.equal(world.writes, 1)
})

test('required leased results let writes through; completion waits until they are released', async (t) => {
  const world = { value: 1, revision: 1, writes: 0 }
  let calls = 0
  const f = await setup(t, world, async function* (request) {
    const basis = JSON.parse(request.materials[0].text).partitions.runtime.decision
    if (++calls === 1) {
      assert(basis.missing.some((item) => item.key === 'lease'))
      yield turn(request, {
        execute: { source: "import {write} from 'test:world';await write(2);" },
      })
    } else if (calls === 2) {
      assert.equal(world.writes, 1)
      yield* done(request)
      return
    } else if (calls === 3) {
      assert.match(request.compiledPrompt, /CONTEXT_REQUIRED/)
      yield turn(request, {
        execute: {
          source: `import {memory as results} from 'velaros:system';await results.release({ref:${JSON.stringify(result.resultRef)}});`,
        },
      })
    } else {
      assert.deepEqual(basis.missing, [])
      yield* done(request)
      return
    }
    yield { type: 'finish', reason: 'stop' }
  })
  await f.session.context.append({ kind: 'user', body: 'Inspect required leased data' })
  const result = await f.session.execute(
    {
      source:
        "import {output} from 'velaros';output('needed',{key:'lease',required:true,view:{mode:'reference'}});",
    },
    'task'
  )
  assert.equal(await submit(f.session), 'completed')
  assert.equal(world.writes, 1)
})
