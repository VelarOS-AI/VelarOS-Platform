import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createContextInvocationJournal } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { createOperationRuntime } from '@velaros-ai/kernel'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { createProjectCapabilityModule, createRuntime } from '../../../dist/act/runtime/index.js'
import { createProjectKernel } from '../../../dist/project/index.js'

import { done, marker, turn } from './support/model-turn.mjs'

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

test('INV-24 changed observation blocks a world write; next normal observation repairs the decision', async (t) => {
  const world = { value: 1, revision: 1, writes: 0 }
  let calls = 0
  const f = await setup(t, world, async function* (request) {
    calls++
    const frame = JSON.parse(request.materials[0].text)
    assert.equal(frame.partitions.runtime.decision.reads.length, 1)
    if (calls === 1) {
      world.value = 2
      world.revision++
    }
    if (calls === 2) {
      assert.equal(world.writes, 0)
      assert.match(request.compiledPrompt, /STALE_OBSERVATION/)
    }
    if (calls <= 2) {
      yield turn(request, {
        execute: { source: "import {write} from 'test:world';await write(3);" },
      })
      yield { type: 'finish', reason: 'stop' }
    } else yield* done(request)
  })
  assert.equal(await submit(f.session), 'completed')
  assert.equal(world.writes, 1)
  assert.equal(world.value, 3)
})

test('same script advances a resource precondition using its own authoritative write receipts', async (t) => {
  const world = { value: 1, revision: 1, writes: 0 }
  let calls = 0
  const f = await setup(t, world, async function* (request) {
    if (++calls === 1) {
      yield turn(request, {
        execute: { source: "import {write} from 'test:world';await write(2);await write(3);" },
      })
      yield { type: 'finish', reason: 'stop' }
    } else yield* done(request)
  })
  assert.equal(await submit(f.session), 'completed')
  assert.equal(world.writes, 2)
  assert.equal(world.value, 3)
})

test('execution-only sessions advance historical read versions using visible authoritative receipts', async (t) => {
  const world = { value: 1, revision: 1, writes: 0 }
  let calls = 0
  const storage = localContextStorage({ path: ':memory:' })
  const model = {
    id: 'execution-basis',
    limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
    async *stream(request) {
      if (++calls === 1) {
        yield turn(request, {
          execute: {
            source:
              "import {output} from 'velaros';import {read,write} from 'test:world';const before=await read();const after=await write(2);output({before,after});",
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else {
        const basis = JSON.parse(request.materials[0].text).partitions.runtime.decision
        assert.equal(basis.reads.length, 1)
        assert.equal(basis.reads[0].version, '2')
        assert(basis.superseded.some((stamp) => stamp.version === '1'))
        yield* done(request)
      }
    },
  }
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    model,
    modules: [worldModule(world)],
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('root')
  assert.equal(await submit(session), 'completed')
  assert.equal(calls, 2)
  assert.equal(world.writes, 1)
})

test('a refreshed execution supersedes old visible history and still detects a later external race', async (t) => {
  const world = { value: 1, revision: 1, writes: 0 }
  let calls = 0
  const storage = localContextStorage({ path: ':memory:' })
  const model = {
    id: 'refresh-basis',
    limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
    async *stream(request) {
      calls++
      if (calls === 2) {
        world.value = 2
        world.revision = 2
      }
      if (calls === 3) {
        const basis = JSON.parse(request.materials[0].text).partitions.runtime.decision
        assert.equal(basis.reads.length, 1)
        assert.equal(basis.reads[0].version, '2')
        assert(basis.superseded.some((stamp) => stamp.version === '1'))
        world.value = 3
        world.revision = 3
        yield* done(request)
        return
      }
      if (calls === 4) assert.match(request.compiledPrompt, /STALE_OBSERVATION/)
      if (calls < 5) {
        yield turn(request, {
          execute: {
            source:
              "import {output} from 'velaros';import {read} from 'test:world';output(await read());",
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else {
        assert.equal(
          JSON.parse(request.materials[0].text).partitions.runtime.decision.reads[0].version,
          '3'
        )
        yield* done(request)
      }
    },
  }
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    model,
    modules: [worldModule(world)],
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('root')
  assert.equal(await submit(session), 'completed')
  assert.equal(calls, 5)
  assert.equal(world.writes, 0)
})

test('unversioned capabilities remain available and are explicitly reported as unverified', async (t) => {
  const world = { value: 1, revision: 1, writes: 0 }
  const f = await setup(
    t,
    world,
    async function* (request) {
      const basis = JSON.parse(request.materials[0].text).partitions.runtime.decision
      assert.equal(basis.reads.length, 0)
      assert.equal(basis.unverified[0].moduleId, 'test:world')
      yield* done(request)
    },
    false
  )
  assert.equal(await submit(f.session), 'completed')
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

test('a reference-only observation is archived but is not a delivered decision basis', async (t) => {
  const world = { value: 1, revision: 1, writes: 0 }
  const f = await setup(t, world, async function* (request) {
    const frame = JSON.parse(request.materials[0].text)
    assert.equal(frame.partitions.observation.blocks[0].representation, 'reference')
    assert.equal(frame.partitions.runtime.decision.reads.length, 0)
    assert.equal(frame.partitions.runtime.decision.sources.length, 0)
    yield* done(request)
  })
  await f.session.observe({
    source:
      "import {output} from 'velaros';import {read} from 'test:world';output(await read(),{key:'state',view:{mode:'reference'}});",
  })
  assert.equal(await submit(f.session), 'completed')
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

test('a reopened runtime keeps read authorization for modules the session still has', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'basis-reopen-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'project')
  await mkdir(workspace)
  const notes = []
  const noteModule = {
    binding: { moduleId: 'test:note', instanceId: 'one', generation: 1, schemaRevision: '1' },
    summary: 'notes',
    operations: {
      add: {
        summary: 'add a note',
        input: { type: 'string' },
        output: { type: 'integer' },
        effects: 'write',
        run: (text, call) => {
          notes.push(text)
          call.recordEffect('committed')
          return notes.length
        },
      },
    },
  }
  // Desktop 每轮新建运行时：同一数据目录重开，项目模块在这一轮还没被脚本导入
  const open = (stream) =>
    createRuntime({
      workspace,
      dataDir: join(root, 'data'),
      runner: nodeSubprocessCodeRunner,
      agents: false,
      search: false,
      memory: false,
      context: { maintenance: false },
      modules: [noteModule],
      model: {
        id: 'reopen',
        limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
        estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
        stream,
      },
    })
  const block = (request, source) => `${marker(request)} execute\n${source}\n${marker(request)}`
  let calls = 0
  const first = await open(async function* (request) {
    if (++calls > 1) return yield* done(request)
    yield {
      type: 'text',
      text: block(
        request,
        "import {output} from 'velaros';import {edit} from 'velaros:project';output(await edit({steps:[{action:'create',path:'plan.md',text:'# Plan\\n'}]}));"
      ),
    }
    yield { type: 'finish', reason: 'stop' }
  })
  for await (const event of (await first.openSession('root')).submit('create the plan'))
    assert.notEqual(event.type, 'error')
  await first.close()
  calls = 0
  let reads = 0
  const second = await open(async function* (request) {
    if (++calls > 1) return yield* done(request)
    reads = JSON.parse(request.materials[0].text).partitions.runtime.decision.reads.length
    yield {
      type: 'text',
      text: block(request, "import {add} from 'test:note';await add('after reopen');"),
    }
    yield { type: 'finish', reason: 'stop' }
  })
  t.after(() => second.close())
  const events = []
  for await (const event of (await second.openSession('root')).submit('add a note'))
    events.push(event)
  assert(reads > 0, '重开后的第一帧应当带着上一轮项目写入的读取依据')
  assert.deepEqual(
    notes,
    ['after reopen'],
    JSON.stringify(events.filter((e) => e.type === 'error'))
  )
  assert.equal(events.at(-1).status, 'completed')
})

test('real project versions detect external file changes and own edits advance the decision basis', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'act-version-'))
  await writeFile(join(root, 'a.txt'), 'one\n')
  const projectKernel = await createProjectKernel({ root })
  const project = {
    getRootPath: () => root,
    kernel: async () => projectKernel,
    queryCode: async () => ({}),
  }
  const storage = localContextStorage({ path: ':memory:' })
  let calls = 0
  const module = createProjectCapabilityModule({ instanceId: root, project })
  const model = {
    id: 'files',
    limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
    async *stream(request) {
      calls++
      const frame = JSON.parse(request.materials[0].text)
      const reads = frame.partitions.runtime.decision.reads
      assert.equal(reads.length, 1)
      assert.equal(reads[0].resourceId, 'file:a.txt')
      if (calls === 1) {
        await writeFile(join(root, 'a.txt'), 'external\n')
        yield turn(request, {
          execute: {
            source:
              "import {edit} from 'velaros:project';await edit({steps:[{action:'create',path:'out.txt',text:'premature'}]});",
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else if (calls === 2) {
        assert.match(request.compiledPrompt, /STALE_OBSERVATION/)
        await assert.rejects(readFile(join(root, 'out.txt')), { code: 'ENOENT' })
        yield turn(request, {
          execute: {
            source:
              "import {read,edit} from 'velaros:project';let a=(await read({files:[{path:'a.txt'}]})).files[0];if(!a.fileRef)throw Error('missing');let e=await edit({steps:[{action:'overwrite',fileRef:a.fileRef,text:'two\\n'}]});if(!e.files[0].fileRef)throw Error('missing');await edit({steps:[{action:'overwrite',fileRef:e.files[0].fileRef,text:'three\\n'}]});",
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else yield* done(request)
    },
  }
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    model,
    modules: [module],
  })
  t.after(async () => {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  })
  const session = await runtime.openSession('s')
  await session.observe({
    source:
      "import {output} from 'velaros';import {read} from 'velaros:project';output(await read({files:[{path:'a.txt'}]}),{key:'file'});",
  })
  assert.equal(await submit(session), 'completed')
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'three\n')
})

test('project query versions ignore generated handles but detect changes to the actual query result', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'act-query-'))
  await writeFile(join(root, 'a.txt'), 'needle\n')
  const projectKernel = await createProjectKernel({ root })
  const project = {
    getRootPath: () => root,
    kernel: async () => projectKernel,
    queryCode: async () => ({}),
  }
  const storage = localContextStorage({ path: ':memory:' })
  const kernel = createOperationRuntime({
    journal: createContextInvocationJournal(storage),
    modules: [createProjectCapabilityModule({ instanceId: root, project })],
  })
  await kernel.start()
  t.after(async () => {
    await kernel.dispose()
    await storage.close()
    await rm(root, { recursive: true, force: true })
  })
  const binding = kernel.bind('s', 'velaros:project')
  const search = await kernel.invoke({
    id: 'search',
    sessionId: 's',
    executionId: 'e',
    binding,
    operation: 'search',
    input: { query: 'needle' },
  })
  assert.equal(search.outcome, 'succeeded')
  assert.equal(search.reads.length, 1)
  assert.equal((await kernel.validateReads('s', search.reads, signal)).status, 'valid')
  const list = await kernel.invoke({
    id: 'list',
    sessionId: 's',
    executionId: 'e',
    binding,
    operation: 'list',
    input: {},
  })
  assert.equal((await kernel.validateReads('s', list.reads, signal)).status, 'valid')
  await writeFile(join(root, 'b.txt'), 'needle\n')
  assert.equal((await kernel.validateReads('s', search.reads, signal)).status, 'stale')
  assert.equal((await kernel.validateReads('s', list.reads, signal)).status, 'stale')
})

test('INV-25 missing required observation permits source repair but blocks writes until the full value is delivered', async (t) => {
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
      assert.equal(world.writes, 0)
      assert.match(request.compiledPrompt, /CONTEXT_REQUIRED/)
      yield turn(request, {
        observe: {
          source:
            "import {output} from 'velaros';import {read} from 'test:world';output(await read(),{key:'state',required:true});",
        },
      })
    } else if (calls === 3) {
      assert.deepEqual(decision.missing, [])
      yield turn(request, {
        execute: { source: "import {write} from 'test:world';await write(2);" },
      })
    } else {
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

test('completion rejects stale observations and refreshes before accepting done', async (t) => {
  const world = { value: 1, revision: 1, writes: 0 }
  let calls = 0
  const f = await setup(t, world, async function* (request) {
    if (++calls === 1) {
      world.value = 2
      world.revision++
    } else assert.match(request.compiledPrompt, /STALE_OBSERVATION/)
    yield* done(request)
  })
  assert.equal(await submit(f.session), 'completed')
  assert.equal(calls, 2)
  assert.equal(world.writes, 0)
})

test('required leased results also block writes until released explicitly', async (t) => {
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
      assert.equal(world.writes, 0)
      yield turn(request, {
        execute: {
          source: `import {memory as results} from 'velaros:system';await results.release({ref:${JSON.stringify(result.resultRef)}});`,
        },
      })
    } else if (calls === 3) {
      assert.deepEqual(basis.missing, [])
      yield turn(request, {
        execute: { source: "import {write} from 'test:world';await write(2);" },
      })
    } else {
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

test('cancelled resource validation releases the write gate without accepting a late validator result', async (t) => {
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
