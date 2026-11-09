import assert from 'node:assert/strict'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'

import { done, modelText, turn } from './support/model-turn.mjs'
import { createTestRuntime as createRuntime } from './support/runtime-fixture.mjs'

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
const observationSource =
  "import {output} from 'velaros';import {read} from 'test:world';output(await read(),{key:'state'});"

async function setup(t, world, stream, observe = true) {
  const storage = localContextStorage({ path: ':memory:' })
  const model = {
    id: 'basis-test',
    limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
    stream,
  }
  const runtime = await createRuntime({
    storage,
    model,
    modules: [worldModule(world)],
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('root')
  if (observe) await session.observe({ source: observationSource })
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
  const f = await setup(
    t,
    world,
    async function* (request) {
      calls++
      if (!support.available && calls === 1) {
        assert.equal(JSON.parse(request.dynamic.text).current.availability.available, false)
        yield turn(request, { execute: { source: observationSource } })
        yield { type: 'finish', reason: 'stop' }
        return
      }
      const delivered = support.available
        ? JSON.parse(request.dynamic.text).current.text
        : modelText(request)
      assert.match(delivered, /"value"\s*:\s*1/)
      assert.match(delivered, /"version"\s*:\s*"1"/)
      // 模型已收到实际读取结果后世界才变化；普通读与真实观察均不因旧版本阻止收尾。
      world.value = 2
      world.revision++
      assert.doesNotMatch(request.protocol, /STALE_OBSERVATION|OBSERVATION_UNVERIFIABLE/)
      yield* done(request)
    },
    false
  )
  const support = f.session.executionRunner.observationSupport()
  if (support.available) await f.session.observe({ source: observationSource })
  else
    await assert.rejects(f.session.observe({ source: observationSource }), { code: 'UNAVAILABLE' })
  assert.equal(await submit(f.session), 'completed')
  assert.equal(calls, support.available ? 1 : 2)
  assert.equal(world.value, 2)
  assert.equal(world.writes, 0)
  if (!support.available) {
    const records = await f.storage.selectSnapshot('root', [
      { titlePrefix: 'script:', titleSuffix: ':result' },
    ])
    const results = await Promise.all(
      records.records.map(async (record) =>
        JSON.parse(await f.storage.get('root', record.objectId))
      )
    )
    assert.equal(results.filter((result) => result.mode === 'observe').length, 0)
  }
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

test(
  'INV-25 missing required observation lets writes through, but completion waits until the full value is delivered',
  {
    skip:
      process.platform !== 'darwin' && process.platform !== 'linux'
        ? 'Successful observation delivery requires the default read-only process backend.'
        : false,
  },
  async (t) => {
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
        assert.match(request.protocol, /CONTEXT_REQUIRED/)
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
  }
)

test('required leased results let writes through; completion waits until they are released', async (t) => {
  const world = { value: 1, revision: 1, writes: 0 }
  let calls = 0
  const f = await setup(
    t,
    world,
    async function* (request) {
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
        assert.match(request.protocol, /CONTEXT_REQUIRED/)
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
    },
    false
  )
  await f.session.context.append({ kind: 'user', body: 'Inspect required leased data' })
  const result = await f.session.execute(
    {
      source:
        "import {output} from 'velaros';output('needed',{key:'lease',required:true,view:{mode:'reference'}});",
    },
    'task'
  )
  assert(result.checked && !result.result.failed, JSON.stringify(result))
  assert.equal(await submit(f.session), 'completed')
  assert.equal(calls, 4)
  assert.equal(world.writes, 1)
})
