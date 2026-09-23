import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createContextInvocationJournal } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { createOperationRuntime } from '@velaros-ai/kernel'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { createCapabilityModule, createRuntime } from '../../../dist/act/runtime/index.js'
import { fileOperations, VelarFilesModule } from '../../../dist/files/index.js'
import { createLocalFilePort } from '../../../dist/files/local.js'
import {
  createProjectContextSource,
  createProjectKernel,
  projectFileOperations,
  VelarProjectModule,
} from '../../../dist/project/index.js'

import { modelText } from './support/model-turn.mjs'
import { runtimeFrame } from './support/model-turn.mjs'
import { done, turn } from './support/model-turn.mjs'

async function storageFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'platform-integration-'))
  const path = join(root, 'state.sqlite')
  const storage = localContextStorage({ path })
  const cleanup = []
  t.after(async () => {
    const failures = []
    for (const close of cleanup.reverse())
      try {
        await close()
      } catch (error) {
        failures.push(error)
      }
    try {
      await storage.close()
    } catch (error) {
      if (error.code !== 'ERR_INVALID_STATE') failures.push(error)
    }
    await rm(root, { recursive: true, force: true })
    if (failures.length) throw new AggregateError(failures, 'fixture cleanup failed')
  })
  return { root, path, storage, cleanup }
}
function ok(result) {
  assert.equal(result.checked, true, JSON.stringify(result))
  assert.equal(result.result.failed, undefined, JSON.stringify(result))
}
async function open(runtime) {
  const s = await runtime.openSession('s')
  await s.context.append({ kind: 'user', body: 'Inspect, edit and verify the actual project.' })
  return s
}

test('INV-4 all 12 generated module surfaces / 94 operations use the same strict registry and templates', async (t) => {
  const f = await storageFixture(t)
  const modules = []
  for (const unit of [
    'files',
    'images',
    'shell',
    'sandbox',
    'project',
    'computer',
    'memory',
    'office',
    'browser',
  ]) {
    const exports = await import(`../../../dist/${unit}/contracts.js`)
    for (const surface of Object.values(exports).filter(
      (value) => value?.specifier && value.operations
    )) {
      modules.push(
        createCapabilityModule({
          surface,
          implementation: Object.fromEntries(surface.methods.map((name) => [name, () => null])),
          instanceId: unit,
          context: () => ({}),
        })
      )
    }
  }
  assert.equal(modules.length, 12)
  assert.equal(
    modules.reduce((n, m) => n + Object.keys(m.operations).length, 0),
    94
  )
  const kernel = createOperationRuntime({
    modules,
    journal: createContextInvocationJournal(f.storage),
  })
  f.cleanup.push(() => kernel.dispose())
  await kernel.start()
  for (const module of modules) {
    const description = kernel.describe(module.binding.moduleId)
    assert.equal(description.declarations, module.surface.declarations)
    assert.equal(description.template, module.surface.template)
    assert.match(description.binding.schemaRevision, /^[a-f0-9]{64}$/)
  }
  let dispatched = 0
  const module = createCapabilityModule({
    surface: VelarProjectModule,
    implementation: Object.fromEntries(
      VelarProjectModule.methods.map((name) => [
        name,
        () => {
          dispatched++
          return null
        },
      ])
    ),
    instanceId: 'p',
    context: () => ({}),
  })
  const other = createOperationRuntime({
    modules: [module],
    journal: createContextInvocationJournal(f.storage),
  })
  f.cleanup.push(() => other.dispose())
  await other.start()
  await assert.rejects(
    other.invoke({
      id: 'malformed',
      sessionId: 's',
      executionId: 'e',
      binding: other.bind('s', 'velaros:project'),
      operation: 'read',
      input: { files: [{ path: 'a.txt', range: [1, 'bad'] }] },
    }),
    { code: 'INPUT_SCHEMA', effect: 'none' }
  )
  assert.equal(dispatched, 0)
})

test('INV-1 real Project and Files operations run through QuickJS, shared receipts and v2 materialization', async (t) => {
  const f = await storageFixture(t)
  await writeFile(join(f.root, 'a.txt'), 'one\n')
  const kernel = await createProjectKernel({ root: f.root })
  const source = createProjectContextSource({ id: 'project', kernel })
  const project = {
    getRootPath: () => f.root,
    kernel: async () => kernel,
    queryCode: async () => ({}),
  }
  const files = createLocalFilePort({ resolvePath: (path) => join(f.root, path) })
  let activated = 0
  let disposed = 0
  const module = createCapabilityModule({
    surface: VelarProjectModule,
    implementation: projectFileOperations,
    instanceId: f.root,
    context: (call) => ({
      project,
      abortSignal: call.signal,
      sessionId: call.invocation.sessionId,
    }),
    activate: () => {
      activated++
    },
    dispose: () => {
      disposed++
    },
  })
  const runtime = await createRuntime({
    storage: f.storage,
    runner: nodeSubprocessCodeRunner,
    context: { sources: [source] },
    modules: [
      module,
      createCapabilityModule({
        surface: VelarFilesModule,
        implementation: fileOperations,
        instanceId: f.root,
        context: (call) => ({ files, abortSignal: call.signal }),
      }),
    ],
  })
  f.cleanup.push(() => runtime.close())
  const s = await open(runtime)
  ok(
    await s.execute({
      source: `import { output } from 'velaros'; import {read,edit} from 'velaros:project'; const [file]=(await read({files:[{path:'a.txt'}]})).files; if(!file.fileRef) throw Error('missing file'); await edit({steps:[{action:'edit',fileRef:file.fileRef,edits:[{op:'replace',range:1,text:'two'}]}]}); output('changed');`,
    })
  )
  assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'two\n')
  let state = await s.view.inspect()
  assert(
    state.mandatory.some((r) => r.operation === 'velaros:project.edit' && r.effect === 'committed')
  )
  assert.equal(state.view.progress.step, 1)
  ok(
    await s.execute({
      source: `import {output} from 'velaros';import {read,edit} from 'velaros:files';const file=(await read({files:[{path:'a.txt'}]})).files[0];if('error' in file)throw Error(file.error.message);await edit({files:[{path:'a.txt',version:file.version,edits:[{range:1,text:'three'}]}]});output('file changed');`,
    })
  )
  assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'three\n')
  state = await s.view.inspect()
  assert(
    state.mandatory.some((r) => r.operation === 'velaros:files.edit' && r.effect === 'committed')
  )
  await runtime.close()
  assert.equal(activated, 1)
  assert.equal(disposed, 1)
})

test('project evidence accepts the shared source candidate range through one hundred', async (t) => {
  const f = await storageFixture(t)
  await writeFile(
    join(f.root, 'candidates.txt'),
    Array.from({ length: 70 }, (_, i) => `candidate ${i}`).join('\n')
  )
  const kernel = await createProjectKernel({ root: f.root })
  const source = createProjectContextSource({ id: 'project', kernel })
  const scope = { sessionId: 's', taskId: 'task' }
  const signal = new AbortController().signal
  const hits = await source.search(scope, 'candidate', 64, signal)
  assert.equal(hits.length, 64)
  assert(hits.every((hit) => hit.target.resourceId === 'candidates.txt'))
  assert.equal((await source.search(scope, 'candidate', 100, signal)).length, 70)
  for (const limit of [0, 101, NaN])
    await assert.rejects(source.search(scope, 'candidate', limit, signal), /1–100/)
})

test('INV-5 default runtime enables shared views, auto-saves scripts and reuses immutable source after restart', async (t) => {
  const f = await storageFixture(t)
  const options = { storage: f.storage, runner: nodeSubprocessCodeRunner, modules: [] }
  const runtime = await createRuntime(options)
  f.cleanup.push(() => runtime.close())
  const s = await open(runtime)
  ok(await s.execute({ source: `import {output} from 'velaros';output('first');` }))
  const sourceRef = (await s.view.inspect()).lastStep.source.id
  const note = await s.context.append({ kind: 'note', body: 'not executable' })
  await assert.rejects(s.execute({ sourceRef: note.ref.id }), /脚本版本/)
  await runtime.close()
  const restarted = await createRuntime({
    ...options,
    storage: localContextStorage({ path: f.path }),
  })
  f.cleanup.push(() => restarted.close())
  const resumed = await restarted.openSession('s')
  ok(await resumed.execute({ sourceRef }))
  const state = await resumed.view.inspect()
  assert.equal(state.step, 2)
  assert.equal(state.lastStep.source.id, sourceRef)
  assert.equal(state.view.progress.script.changed, false)
  const other = await restarted.openSession('other')
  await other.context.append({ kind: 'user', body: 'Another task' })
  await assert.rejects(other.execute({ sourceRef }))
})

test('repeated execution uses immutable source refs and records each real execution separately', async (t) => {
  const f = await storageFixture(t)
  const runtime = await createRuntime({
    storage: f.storage,
    runner: nodeSubprocessCodeRunner,
    modules: [],
  })
  f.cleanup.push(() => runtime.close())
  const s = await open(runtime)
  const first = await s.execute({ source: `import {output} from 'velaros';output('stable');` })
  const second = await s.execute({ sourceRef: first.sourceRef })
  ok(first)
  ok(second)
  assert.equal(second.sourceRef, first.sourceRef)
  assert.notEqual(second.executionId, first.executionId)
  assert.notEqual(second.resultRef, first.resultRef)
  assert.equal((await s.view.inspect()).view.progress.repeatedSteps, 1)
  ok(await s.execute({ sourceRef: first.sourceRef }))
  ok(await s.execute({ sourceRef: first.sourceRef }))
  assert.equal((await s.view.inspect()).view.progress.stalled, true)
})

test('normalization keeps committed effects visible, respects explicit partial effects and supports void results', async (t) => {
  const f = await storageFixture(t)
  const surface = {
    specifier: 'test:normalize',
    namespace: 'normalize',
    methods: ['void', 'partial', 'bad'],
    declarations: '',
    template: '',
    revision: '1',
    operations: Object.fromEntries(
      ['void', 'partial', 'bad'].map((name) => [
        name,
        { summary: name, input: { type: 'null' }, output: {}, effects: 'write', hasInput: false },
      ])
    ),
  }
  const module = createCapabilityModule({
    surface,
    instanceId: 'n',
    implementation: {
      void: () => undefined,
      partial: (ctx) => {
        ctx.recordEffect('partial')
        return { optional: undefined, value: 2 }
      },
      bad: () => new Date(),
    },
    context: (call) => call,
  })
  const kernel = createOperationRuntime({
    modules: [module],
    journal: createContextInvocationJournal(f.storage),
  })
  f.cleanup.push(() => kernel.dispose())
  await kernel.start()
  const call = (name) =>
    kernel.invoke({
      id: name,
      sessionId: 's',
      executionId: 'e',
      binding: kernel.bind('s', surface.specifier),
      operation: name,
      input: null,
    })
  const empty = await call('void')
  assert.equal(empty.value, null)
  assert.equal(empty.effect, 'committed')
  const partial = await call('partial')
  assert.deepEqual(partial.value, { value: 2 })
  assert.equal(partial.effect, 'partial')
  const bad = await call('bad')
  assert.equal(bad.outcome, 'failed')
  assert.equal(bad.effect, 'committed')
})

test('INV-7 real image capability persists attachments and sends them as images in the next model request', async (t) => {
  const { imageOperations, VelarImagesModule } = await import('../../../dist/images/index.js')
  const f = await storageFixture(t)
  const data =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+9sAAAAASUVORK5CYII='
  await writeFile(join(f.root, 'tiny.png'), Buffer.from(data, 'base64'))
  const module = createCapabilityModule({
    surface: VelarImagesModule,
    implementation: imageOperations,
    instanceId: f.root,
    context: (call) => ({
      abortSignal: call.signal,
      images: { locate: async () => ({ target: join(f.root, 'tiny.png'), shown: 'tiny.png' }) },
      attachImage: (image) => call.attach({ type: 'image-data', ...image }),
    }),
  })
  let calls = 0
  const model = {
    id: 'image-driver',
    limits: { contextTokens: 100000, inputTokens: 95000, outputTokens: 4000 },
    estimate: async () => ({ tokens: 1000, precision: 'estimate', basis: 'test' }),
    async *stream(request) {
      if (++calls === 1) {
        yield turn(request, {
          execute: {
            source: `import {view} from 'velaros:images';await view({files:[{path:'tiny.png'}]});`,
          },
        })
        yield { type: 'finish', reason: 'stop' }
        return
      }
      assert.equal(request.images.length, 1)
      assert.equal(request.images[0].data, data)
      const view = runtimeFrame(request.materials.at(-1).text)
      assert.equal(view.results.length, 1)
      assert.equal(view.results[0].remainingTurns, 2)
      assert(!modelText(request).includes(data))
      yield* done(request)
    },
  }
  const runtime = await createRuntime({
    storage: f.storage,
    runner: nodeSubprocessCodeRunner,
    modules: [module],
    model,
  })
  f.cleanup.push(() => runtime.close())
  const s = await runtime.openSession('s')
  const events = []
  for await (const e of s.submit('Inspect this image')) events.push(e)
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
  assert.equal(calls, 2)
  const state = await s.view.inspect()
  const content = await s.context.read(state.lastStep.attachments[0])
  assert.equal(JSON.parse(content.text).data, data)
})

test('QuickJS data codecs preserve UTF-8 and binary roundtrips without host objects', async (t) => {
  const f = await storageFixture(t)
  const runtime = await createRuntime({
    storage: f.storage,
    runner: nodeSubprocessCodeRunner,
    modules: [],
  })
  f.cleanup.push(() => runtime.close())
  const s = await open(runtime)
  const expected = Buffer.from('测试😀\ud800').toString('base64')
  ok(
    await s.execute({
      source: `import {output} from 'velaros';const bytes=new TextEncoder().encode('测试😀\\ud800');const encoded=btoa(String.fromCharCode(...bytes));if(encoded!==${JSON.stringify(expected)})throw Error('UTF-8 mismatch');if(btoa(atob(encoded))!==encoded)throw Error('roundtrip');const target=new Uint8Array(3);const n=new TextEncoder().encodeInto('😀x',target);if(n.read!==0||n.written!==0)throw Error('split character');let rejected=false;try{btoa('中')}catch{rejected=true}if(!rejected)throw Error('invalid binary accepted');if(atob(' Y Q ==\\n')!=='a')throw Error('whitespace');output(encoded);`,
    })
  )
})
