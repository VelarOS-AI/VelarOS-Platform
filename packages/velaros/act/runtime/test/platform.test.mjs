import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createContextInvocationJournal } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { createOperationRuntime } from '@velaros-ai/kernel'
import { createProviderRequestCompiler } from '@velaros-ai/model'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import {
  createCapabilityModule,
  createNodeExecutionEnvironment,
  createProjectCapabilityModule,
  createRuntime,
} from '../../../dist/act/runtime/index.js'
import { createLocalShellHost } from '../../../dist/execution/local.js'
import {
  createProjectContextSource,
  createProjectKernel,
  projectFileOperations,
  VelarProjectModule,
} from '../../../dist/project/index.js'

import { done, marker, modelText, runtimeFrame, turn } from './support/model-turn.mjs'

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
    'images',
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

test('INV-1 real project transaction operations run through Node, shared receipts and v2 materialization', async (t) => {
  const f = await storageFixture(t)
  await writeFile(join(f.root, 'a.txt'), 'one\n')
  const kernel = await createProjectKernel({ root: f.root })
  const source = createProjectContextSource({ id: 'project', kernel })
  const project = {
    getRootPath: () => f.root,
    kernel: async () => kernel,
    queryCode: async () => ({}),
  }
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
    modules: [module],
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
      source: `import {output} from 'velaros';import {read,edit} from 'velaros:project';const file=(await read({files:[{path:'a.txt'}]})).files[0];if('error' in file)throw Error(file.error.message);await edit({steps:[{action:'replace',path:'a.txt',oldText:file.text.trim(),newText:'three'}]});output('file changed');`,
    })
  )
  assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'three\n')
  state = await s.view.inspect()
  assert(
    state.mandatory.some((r) => r.operation === 'velaros:project.edit' && r.effect === 'committed')
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

for (const scenario of [
  { name: 'three executions', batches: [10, 10, 6], delivered: 20 },
  { name: 'one execution', batches: [10, 10, 6], delivered: 20, singleExecution: true },
  {
    name: 'persistent observation and new views',
    batches: [10, 10, 6],
    delivered: 20,
    observation: true,
  },
  { name: 'aggregate byte capacity', batches: [3, 3], delivered: 5, bytes: 3 * 1024 * 1024 },
  {
    name: 'cancel during image audit',
    batches: [3, 3],
    delivered: 5,
    bytes: 3 * 1024 * 1024,
    cancelAudit: true,
  },
])
  test(
    `image delivery defers overflow and recovers via release and bounded view (${scenario.name})`,
    {
      skip:
        scenario.observation && process.platform === 'win32'
          ? 'Windows does not provide the required read-only Node observation sandbox'
          : false,
    },
    async (t) => {
      const { imageOperations, VelarImagesModule } = await import('../../../dist/images/index.js')
      const f = await storageFixture(t)
      const pixel =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+9sAAAAASUVORK5CYII='
      const original = Buffer.from(pixel, 'base64')
      const data = scenario.bytes
        ? Buffer.concat([original, Buffer.alloc(scenario.bytes - original.length)])
        : original
      await writeFile(join(f.root, 'tiny.png'), data)
      const module = createCapabilityModule({
        surface: VelarImagesModule,
        implementation: imageOperations,
        instanceId: f.root,
        context: (call) => ({
          abortSignal: call.signal,
          images: { locate: async (path) => ({ target: join(f.root, 'tiny.png'), shown: path }) },
          attachImage: (image) => call.attach({ type: 'image-data', ...image }),
        }),
      })
      const count = scenario.batches.reduce((total, size) => total + size, 0)
      const files = Array.from({ length: count }, (_, i) => ({ path: `image-${i}.png` }))
      const seen = new Set()
      const actualRequests = []
      let calls = 0
      const model = {
        id: 'image-overflow-recovery',
        limits: { contextTokens: 200000, inputTokens: 180000, outputTokens: 4000 },
        estimate: async () => ({ tokens: 1000, precision: 'estimate', basis: 'test' }),
        async *stream(request) {
          actualRequests.push(request)
          calls++
          if (calls === 1) {
            let offset = 0
            const groups = scenario.batches.map((size) => {
              const batch = files.slice(offset, offset + size)
              offset += size
              return batch
            })
            const sources = groups.map((batch) => `await view({files:${JSON.stringify(batch)}});`)
            if (scenario.observation) {
              yield turn(request, {
                observe: {
                  source: `import {view} from 'velaros:images';${sources.slice(0, 2).join('')}`,
                },
                execute: { source: `import {view} from 'velaros:images';${sources[2]}` },
              })
              yield { type: 'finish', reason: 'stop' }
              return
            }
            for (const source of scenario.singleExecution ? [sources.join('')] : sources) {
              yield turn(request, {
                execute: { source: `import {view} from 'velaros:images';${source}` },
              })
              yield { type: 'text', text: '\n' }
            }
            yield { type: 'finish', reason: 'stop' }
            return
          }
          assert(calls <= 3, 'bounded recovery must not loop')
          for (const image of request.images) seen.add(image.label.match(/image-\d+\.png/)[0])
          assert(request.images.every((image) => image.data === data.toString('base64')))
          const frame = JSON.parse(
            request.materials.findLast((item) => item.origin === 'runtime-view').text
          )
          const status = frame.partitions.runtime.materialStatus
          if (calls === 2) {
            assert.equal(
              request.images.length,
              scenario.delivered,
              JSON.stringify(runtimeFrame(request).results.map(({ ref, text }) => ({ ref, text })))
            )
            const deferred = scenario.singleExecution ? 0 : count - scenario.delivered
            assert.equal(status.imageDelivery.deferred, deferred)
            assert.equal(
              status.imageReferences.filter((item) => item.attached).length,
              scenario.delivered
            )
            assert.equal(status.imageReferences.filter((item) => item.deferred).length, deferred)
            if (scenario.bytes) assert.equal(status.imageDelivery.base64Bytes, 20 * 1024 * 1024)
            if (deferred) {
              assert.match(status.imageDelivery.advice, /memory\.release/)
              assert.match(status.imageDelivery.advice, /不会自动补送/)
            } else {
              assert.match(JSON.stringify(runtimeFrame(request).results), /只给了前 20 张/)
            }
            const results = [...new Set(status.imageReferences.map((item) => item.resultRef))]
            assert(results.every(Boolean))
            const remaining = files.filter((file) => !seen.has(file.path))
            if (scenario.observation)
              yield {
                type: 'text',
                text: `${marker(request)} observe({clear:true})\n${marker(request)}\n`,
              }
            yield turn(request, {
              execute: {
                source: `import {memory} from 'velaros:system';import {view} from 'velaros:images';for(const ref of ${JSON.stringify(results)})await memory.release({ref});await view({files:${JSON.stringify(remaining)}});`,
              },
            })
            yield { type: 'finish', reason: 'stop' }
            return
          }
          assert.equal(request.images.length, count - scenario.delivered)
          assert.equal(status.imageDelivery.deferred, 0)
          assert.deepEqual([...seen].sort(), files.map((file) => file.path).sort())
          yield* done(request, 'All images were actually delivered in bounded requests.')
        },
      }
      const shell = createLocalShellHost({
        cwd: f.root,
        processConfinement: { mode: 'danger-full-access', workspaceRoot: f.root },
      })
      f.cleanup.push(() => shell.dispose())
      const node = createNodeExecutionEnvironment({
        cwd: f.root,
        directory: join(f.root, 'runs'),
        host: shell,
      })
      const runtime = await createRuntime({
        storage: f.storage,
        node,
        modules: [module],
        model,
        context: { maintenance: false },
      })
      f.cleanup.push(() => runtime.close())
      const session = await runtime.openSession('s')
      const controller = new AbortController()
      if (scenario.cancelAudit) {
        const append = session.context.append.bind(session.context)
        t.mock.method(session.context, 'append', async (input, signal) => {
          const result = await append(input, signal)
          if (input.title === 'model-request:image-data') controller.abort()
          return result
        })
      }
      const events = []
      for await (const event of session.submit(
        `Inspect all ${count} images in batches.`,
        controller.signal
      ))
        events.push(event)
      if (scenario.cancelAudit) {
        assert.equal(calls, 1, 'cancelled image audit never dispatches the second request')
        assert.equal((await f.storage.records('s', { title: 'model-request' })).items.length, 1)
        assert.notEqual(events.at(-1).status, 'completed')
        return
      }
      assert.equal(
        events.at(-1).status,
        'completed',
        JSON.stringify(events.filter((event) => event.type === 'error'))
      )
      assert.equal(calls, 3)
      if (scenario.bytes) {
        const audits = (await f.storage.records('s', { title: 'model-request' })).items
        const auditRecord = audits[1]
        const raw = await f.storage.get('s', auditRecord.objectId)
        assert(raw.length < 8000000)
        assert.equal(
          auditRecord.sources.length,
          1,
          'identical pixels are archived once despite different labels'
        )
        const pixels = new Map()
        for (const ref of auditRecord.sources) {
          const record = await session.context.read(ref, { limit: 1 })
          pixels.set(ref.id, await f.storage.get('s', record.record.objectId))
        }
        const restored = JSON.parse(raw, (_key, value) => {
          if (value?.$velarosType !== 'context-image') return value
          const body = pixels.get(value.ref.id)
          assert.equal(typeof body, 'string')
          return value.encoding === 'data-url' ? value.prefix + body : body
        })
        assert.deepEqual(restored.request, JSON.parse(JSON.stringify(actualRequests[1])))
        const compiler = createProviderRequestCompiler()
        const expected = await compiler.compileModelTurn(actualRequests[1], model, 0)
        assert.deepEqual(
          restored.providerRequest,
          JSON.parse(JSON.stringify(expected.providerRequest))
        )
        await compiler.verify(restored.providerRequest)
      }
    }
  )

test('Node data codecs preserve UTF-8 and binary roundtrips without host objects', async (t) => {
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
