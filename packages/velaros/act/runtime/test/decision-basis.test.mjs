import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createContextInvocationJournal } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { createOperationRuntime } from '@velaros-ai/kernel'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { createRuntime } from '../../../dist/act/runtime/index.js'

import { done, turn } from './support/model-turn.mjs'

const signal = new AbortController().signal
function worldModule(world, versioned = true) {
  const reads = {
    capture: (_input, value) => [{ resourceId: 'state', version: value.version }],
    validate: (stamp) => stamp.version === String(world.revision),
  }
  return {
    binding: { moduleId: 'test:world', instanceId: 'one', generation: 1, schemaRevision: '1' },
    summary: 'versioned state',
    operations: {
      read: {
        summary: 'read',
        input: { type: 'null' },
        output: { type: 'object' },
        effects: 'none',
        ...(versioned ? { reads } : {}),
        run: () => ({ value: world.value, version: String(world.revision) }),
      },
      write: {
        summary: 'write',
        input: { type: 'integer' },
        output: { type: 'object' },
        effects: 'write',
        ...(versioned ? { reads } : {}),
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
async function setup(t, world, stream, versioned = true) {
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
    modules: [worldModule(world, versioned)],
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

test('Kernel validates archived read stamps, authorization, and current resource version without replay', async (t) => {
  const world = { value: 1, revision: 1, writes: 0 }
  let allowed = true
  const storage = localContextStorage({ path: ':memory:' })
  const journal = createContextInvocationJournal(storage)
  const kernel = createOperationRuntime({
    journal,
    modules: [worldModule(world)],
    beforeReadValidation: async () => {
      if (!allowed) throw Object.assign(Error('revoked'), { code: 'CAPABILITY_DENIED' })
    },
  })
  t.after(async () => {
    await kernel.dispose()
    await storage.close()
  })
  await kernel.start()
  const binding = kernel.bind('session', 'test:world')
  const receipt = await kernel.invoke({
    id: 'read1',
    sessionId: 'session',
    executionId: 'observe1',
    binding,
    operation: 'read',
    input: null,
  })
  assert.equal((await kernel.validateReads('session', receipt.reads, signal)).status, 'valid')
  await assert.rejects(
    kernel.validateReads('session', [{ ...receipt.reads[0], version: 'forged' }], signal),
    { code: 'READ_STAMP_INVALID' }
  )
  await assert.rejects(kernel.validateReads('other', receipt.reads, signal), {
    code: 'READ_STAMP_INVALID',
  })
  world.revision++
  assert.equal((await kernel.validateReads('session', receipt.reads, signal)).status, 'stale')
  allowed = false
  await assert.rejects(kernel.validateReads('session', receipt.reads, signal), {
    code: 'CAPABILITY_DENIED',
  })
  assert.equal(world.writes, 0)
})

test('resource validation survives storage reload and treats a new module generation as stale', async (t) => {
  const world = { value: 1, revision: 1, writes: 0 }
  const storage = localContextStorage({ path: ':memory:' })
  const journal = createContextInvocationJournal(storage)
  const first = createOperationRuntime({ journal, modules: [worldModule(world)] })
  await first.start()
  const receipt = await first.invoke({
    id: 'generation-read',
    sessionId: 's',
    executionId: 'e',
    binding: first.bind('s', 'test:world'),
    operation: 'read',
    input: null,
  })
  await first.dispose()
  const module = worldModule(world)
  module.binding.generation = 2
  const second = createOperationRuntime({ journal, modules: [module] })
  await second.start()
  second.bind('s', 'test:world')
  t.after(async () => {
    await second.dispose()
    await storage.close()
  })
  assert.equal(
    (await second.validateReads('s', receipt.reads, signal)).reads[0].reason,
    'module-generation'
  )
})

test('cancelled resource validation rejects without accepting a late validator result', async (t) => {
  const world = { value: 1, revision: 1, writes: 0 }
  const module = worldModule(world)
  let finish
  module.operations.read.reads.validate = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const storage = localContextStorage({ path: ':memory:' })
  const kernel = createOperationRuntime({
    journal: createContextInvocationJournal(storage),
    modules: [module],
  })
  await kernel.start()
  t.after(async () => {
    await kernel.dispose()
    await storage.close()
  })
  const receipt = await kernel.invoke({
    id: 'cancellable',
    sessionId: 's',
    executionId: 'e',
    binding: kernel.bind('s', 'test:world'),
    operation: 'read',
    input: null,
  })
  const controller = new AbortController()
  const validation = kernel.validateReads('s', receipt.reads, controller.signal)
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await assert.rejects(validation, { name: 'AbortError' })
  finish(true)
  assert.equal(world.writes, 0)
})
