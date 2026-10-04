import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createContextInvocationJournal } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { createOperationRuntime } from '@velaros-ai/kernel'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import {
  createCapabilityModule,
  createProjectCapabilityModule,
  createRuntime,
} from '../../../dist/act/runtime/index.js'
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

test('INV-4 all 14 generated module surfaces / 102 operations use the same strict registry and templates', async (t) => {
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
    'web',
    'sessions',
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
  assert.equal(modules.length, 14)
  assert.equal(
    modules.reduce((n, m) => n + Object.keys(m.operations).length, 0),
    102
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
      source: `import { output } from 'velaros'; import {read,edit} from 'velaros:project'; const [file]=(await read({files:[{path:'a.txt'}]})).files; if(file.text!=='one\\n') throw Error('unexpected text'); await edit({steps:[{action:'replace',path:'a.txt',oldText:'one',newText:'two'}]}); output('changed');`,
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
      source: `import {output} from 'velaros';import {read,edit} from 'velaros:files';const file=(await read({files:[{path:'a.txt'}]})).files[0];if('error' in file)throw Error(file.error.message);await edit({steps:[{action:'replace',path:'a.txt',oldText:file.text.trim(),newText:'three'}]});output('file changed');`,
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

test('INV-55 write failures marked as not applied are recorded without an effect; unmarked ones stay unknown', async (t) => {
  const f = await storageFixture(t)
  await writeFile(join(f.root, 'a.txt'), 'one\ntwo\nthree\n')
  const kernel = await createProjectKernel({ root: f.root })
  const project = {
    getRootPath: () => f.root,
    kernel: async () => kernel,
    queryCode: async () => ({}),
  }
  const runtime = createOperationRuntime({
    modules: [
      createCapabilityModule({
        surface: VelarProjectModule,
        implementation: projectFileOperations,
        instanceId: f.root,
        context: (call) => ({
          project,
          abortSignal: call.signal,
          sessionId: call.invocation.sessionId,
        }),
      }),
    ],
    journal: createContextInvocationJournal(f.storage),
  })
  f.cleanup.push(() => runtime.dispose())
  await runtime.start()
  const binding = runtime.bind('s', 'velaros:project')
  const call = (id, operation, input) =>
    runtime.invoke({ id, sessionId: 's', executionId: 'e', binding, operation, input })
  // 要换的原文在文件里没有：项目在写盘之前拒绝，标了没有写入，回执记成没有效果，不用等宿主核对
  const refused = await call('replace', 'edit', {
    steps: [{ action: 'replace', path: 'a.txt', oldText: 'four', newText: 'replaced' }],
  })
  assert.equal(refused.outcome, 'failed')
  assert.equal(refused.effect, 'none')
  assert.equal(refused.error.code, 'TARGET_NOT_FOUND')
  assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n')

  // 没有标记的写失败仍是效果未知
  const unmarked = createOperationRuntime({
    modules: [
      createCapabilityModule({
        surface: VelarProjectModule,
        implementation: Object.fromEntries(
          VelarProjectModule.methods.map((name) => [
            name,
            () => {
              throw new Error('disk went away mid-write')
            },
          ])
        ),
        instanceId: 'unmarked',
        context: () => ({}),
      }),
    ],
    journal: createContextInvocationJournal(f.storage),
  })
  f.cleanup.push(() => unmarked.dispose())
  await unmarked.start()
  const lost = await unmarked.invoke({
    id: 'unmarked-edit',
    sessionId: 's',
    executionId: 'e2',
    binding: unmarked.bind('s', 'velaros:project'),
    operation: 'edit',
    input: { steps: [{ action: 'write', path: 'b.txt', text: 'b\n' }] },
  })
  assert.equal(lost.outcome, 'failed')
  assert.equal(lost.effect, 'unknown')
})

test('INV-55 bound patches record blocked and unchanged results as none, and real changes as committed', async (t) => {
  const f = await storageFixture(t)
  await writeFile(join(f.root, 'a.txt'), 'one\n')
  const projectKernel = await createProjectKernel({ root: f.root })
  const project = {
    getRootPath: () => f.root,
    kernel: async () => projectKernel,
    queryCode: async () => ({}),
  }
  const runtime = createOperationRuntime({
    modules: [createProjectCapabilityModule({ instanceId: f.root, project })],
    journal: createContextInvocationJournal(f.storage),
  })
  f.cleanup.push(() => runtime.dispose())
  await runtime.start()
  const binding = runtime.bind('s', 'velaros:project')
  const call = (id, operation, input) =>
    runtime.invoke({
      id,
      sessionId: 's',
      executionId: 'e',
      mode: 'execute',
      binding,
      operation,
      input,
    })
  const refused = await call('missing-patch', 'patch', {
    edits: [{ target: 'target:00000000', text: 'bad' }],
  })
  assert.equal(refused.outcome, 'succeeded')
  assert.equal(refused.value.status, 'blocked')
  assert.equal(refused.effect, 'none')
  assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'one\n')

  const selected = await call('select', 'select', { targets: [{ path: 'a.txt', match: 'one' }] })
  assert.equal(selected.effect, 'none')
  const target = selected.value.targets[0].target
  const unchanged = await call('unchanged-patch', 'patch', { edits: [{ target, text: 'one' }] })
  assert.equal(unchanged.value.status, 'applied')
  assert.equal(unchanged.value.changed, false)
  assert.equal(unchanged.effect, 'none')

  const applied = await call('real-patch', 'patch', { edits: [{ target, text: 'two' }] })
  assert.equal(applied.value.status, 'applied')
  assert.equal(applied.effect, 'committed')
  assert.equal('diff' in applied.value, false)
  assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'two\n')
  const reverted = await call('undo-patch', 'undo', { changeRef: applied.value.changeRef })
  assert.equal(reverted.effect, 'committed')
  assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'one\n')
})

test('INV-56 bound Python editing, draft amendment, inspection and undo run through the actual workspace ScriptAct chain', async (t) => {
  const f = await storageFixture(t)
  const workspace = join(f.root, 'workspace')
  await mkdir(workspace)
  const original =
    'class Cache:\r\n    def load(self, key):\r\n        return "原文🙂"\r\n\r\n# 尾部保留\r\n'
  await writeFile(join(workspace, 'cache.py'), original)
  const runtime = await createRuntime({ storage: f.storage, workspace })
  f.cleanup.push(() => runtime.close())
  const session = await open(runtime)
  const receipt = await session.execute({
    source: `
    import { select, patch, inspect, undo } from 'velaros:project';
    const found = await select({ targets: [{ path: 'cache.py', symbol: 'Cache.load' }] });
    if (found.issues?.length || !found.targets[0]) throw Error('Selection failed');
    const target = found.targets[0].target;
    const blocked = await patch({ edits: [
      { target, text: '    def load(self, key):\\n        return "更新🙂"' },
      { target, text: 'overlap' }
    ] });
    if (blocked.status !== 'blocked') throw Error('Overlap must not write');
    const changed = await patch({ planRef: blocked.planRef, amendments: [{ index: 1, edit: null }] });
    if (changed.status !== 'applied') throw Error('Amendment must apply');
    const full = await inspect({ changeRef: changed.changeRef });
    const reverted = await undo({ changeRef: changed.changeRef });
    export default { target, blocked, changed, full, reverted };
  `,
  })
  ok(receipt)
  const result = receipt.result.value
  assert.match(result.target.ref, /^target:[a-f0-9]{8}$/)
  assert.equal(result.blocked.executionOutcome, 'not-applied')
  assert.equal('diff' in result.changed, false)
  assert.match(result.full.diff, /更新🙂/)
  assert.deepEqual(result.reverted.changedFiles, ['cache.py'])
  assert.equal(await readFile(join(workspace, 'cache.py'), 'utf8'), original)
  const state = await session.view.inspect()
  const patches = state.mandatory.filter((r) => r.operation === 'velaros:project.patch')
  assert.equal(patches.length, 2)
  assert.deepEqual(
    patches.map((r) => r.effect),
    ['none', 'committed']
  )
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
    methods: ['void', 'partial', 'bad', 'spoof'],
    declarations: '',
    template: '',
    revision: '1',
    operations: Object.fromEntries(
      ['void', 'partial', 'bad', 'spoof'].map((name) => [
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
      spoof: () => ({ status: 'blocked', executionOutcome: 'not-applied' }),
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
  const spoof = await call('spoof')
  assert.equal(spoof.effect, 'committed')
})

test('INV-56 a workspace project can also mount velaros:code and velaros:images on the runtime kernel', async (t) => {
  const f = await storageFixture(t)
  const workspace = join(f.root, 'workspace')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(
    join(workspace, 'src/a.ts'),
    'export function greet(name: string) {\n  return `hi ${name}`\n}\n'
  )
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+9sAAAAASUVORK5CYII='
  await writeFile(join(workspace, 'tiny.png'), Buffer.from(png, 'base64'))
  await writeFile(join(f.root, 'outside.png'), Buffer.from(png, 'base64'))
  const runtime = await createRuntime({
    storage: f.storage,
    runner: nodeSubprocessCodeRunner,
    workspace,
    project: { code: true, images: true },
  })
  f.cleanup.push(() => runtime.close())
  const s = await open(runtime)
  const receipt = await s.execute({
    source:
      "import {query,analyze} from 'velaros:code';import {view} from 'velaros:images';export const outline=await query({intent:'outline',path:'src/a.ts'});export const definition=await query({intent:'definition',target:{symbol:'greet'}});export const seen=await view({files:[{path:'tiny.png'},{path:'../outside.png'}]});let graph='none';try{await analyze({intent:'cycles'})}catch(error){graph=error.code};export {graph};",
  })
  ok(receipt)
  const { outline, definition, seen, graph } = receipt.result.value
  assert(JSON.stringify(outline).includes('greet'), JSON.stringify(outline))
  // 找到声明的那一路也过得了返回值的 schema：覆盖范围照声明的形状给
  assert.equal(definition.declaration.startLine, 1)
  assert.equal(definition.coverage.versioned, true)
  assert.equal(definition.coverage.revisions.length, 1)
  assert.equal(seen.files[0].width, 1)
  // 看图钳在项目里：出了项目的那一张看不了
  assert.equal(seen.files[1].error.code, 'PERMISSION')
  // 没有代码图谱后端：图谱类分析如实报不可用
  assert.equal(graph, 'UNAVAILABLE')

  // 不给这两项就不挂
  const plainStorage = localContextStorage({ path: join(f.root, 'plain.sqlite') })
  const plain = await createRuntime({
    storage: plainStorage,
    runner: nodeSubprocessCodeRunner,
    workspace,
  })
  f.cleanup.push(async () => {
    await plain.close()
    await plainStorage.close()
  })
  const listed = await (
    await open(plain)
  ).execute({
    source:
      "import {modules} from 'velaros:system';export const list=await modules.list({limit:64});",
  })
  ok(listed)
  const specifiers = listed.result.value.list.items.map((item) => item.specifier)
  assert(specifiers.includes('velaros:project'))
  assert(!specifiers.includes('velaros:code'))
  assert(!specifiers.includes('velaros:images'))
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
      const view = runtimeFrame(request)
      assert.equal(view.results.length, 1)
      assert.equal(view.results[0].remainingTurns, 'segment')
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
