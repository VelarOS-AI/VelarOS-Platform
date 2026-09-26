import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createContextInvocationJournal } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { createOperationRuntime } from '@velaros-ai/kernel'
import {
  codeProgramChecker,
  createKernelScriptSession,
  nodeSubprocessCodeRunner,
  scriptPackageCompiler,
} from '@velaros-ai/script'

import { createRuntime } from '../../../dist/act/runtime/index.js'
import { SystemMembers } from '../../../dist/act/system/contract/constants.js'
import { ContextMaintenanceState } from '../../../dist/act/system/impl/ContextMaintenanceState.js'
import { SystemCatalog } from '../../../dist/act/system/impl/SystemCatalog.js'
import { done, turn } from '../../runtime/test/support/model-turn.mjs'

const model = (stream) => ({
  id: 'system-test',
  limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
  estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
  stream,
})
async function fixture(t, options = {}) {
  const storage = localContextStorage({ path: ':memory:' })
  const requests = []
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    modules: [],
    model: model(async function* (request) {
      requests.push(request)
      yield* done(request)
    }),
    ...options,
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('s')
  await session.context.append({ kind: 'user', body: 'Maintain progress' })
  return { storage, runtime, session, requests }
}
async function execute(session, source, extra = {}) {
  const result = await session.execute({ source, ...extra })
  assert(result.checked && !result.result.failed, JSON.stringify(result))
  return { receipt: result, value: result.result.value?.default }
}
async function submit(session) {
  const events = []
  for await (const event of session.submit('Continue')) events.push(event)
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
}
const prelude = "import {output} from 'velaros';import * as system from 'velaros:system';"

// 使用真实 QuickJS、Kernel 与 ContextStorage，验证包入口没有另起执行路径。
test('INV-2 系统命名空间和附属模块共用真实操作身份与输入/blob通道', async (t) => {
  const f = await fixture(t)
  const result = await execute(
    f.session,
    `${prelude}import {input,blobs} from 'velaros:program';import {remember} from './note.js';const note=await remember(input.key,blobs.body);output({note,frozen:Object.isFrozen(system)&&Object.isFrozen(system.memory)});`,
    {
      input: { key: 'plan' },
      blobs: { body: 'literal ` ${text} \\ 内容' },
      modules: {
        'note.js':
          "import {memory as notes} from 'velaros:system';export async function remember(key,body){return notes.update({key,baseRevision:0,body});}",
      },
    }
  )
  assert.equal(result.value.note.revision, 1)
  assert.equal(result.value.frozen, true)
  const journal = await createContextInvocationJournal(f.storage).list('s')
  assert.deepEqual(
    journal.map((item) => [item.prepared.binding.moduleId, item.prepared.operation]),
    [['velaros:system-memory', 'update']]
  )
  const text = await execute(
    f.session,
    `${prelude}output(await system.memory.read({ref:${JSON.stringify(result.value.note.ref)}}));`
  )
  assert.equal(JSON.parse(text.value.text).body, 'literal ` ${text} \\ 内容')
})

test('INV-3 目录集中展示系统包，成员合同和模板可直接检查执行', async (t) => {
  const f = await fixture(t)
  const listing = await execute(
    f.session,
    `${prelude}output(await system.modules.list({space:'system',limit:1}));`
  )
  assert.equal(listing.value.items.length, 1)
  assert.equal(listing.value.nextOffset, null)
  assert.deepEqual(listing.value.items[0].exports, Object.keys(SystemMembers))
  assert.equal(listing.value.items[0].operations.length, 25)
  assert.equal(listing.value.items[0].binding, undefined)
  const result = await execute(
    f.session,
    `${prelude}output(await system.modules.describe({module:'velaros:system',export:'memory'}));`
  )
  assert.equal(result.value.exports.memory.binding.moduleId, 'velaros:system-memory')
  assert.deepEqual(Object.keys(result.value.exports), ['memory'])
  assert.equal(
    codeProgramChecker.typecheck({
      source: result.value.template,
      granted: [{ namespace: 'velaros:system', declarations: result.value.declarations }],
    }).ok,
    true
  )
  await execute(f.session, result.value.template)
  const root = await execute(
    f.session,
    `${prelude}const description=await system.modules.describe({module:'velaros:system'});if(!description.exports)throw new Error('missing exports');output({template:description.template,modules:description.exports.modules,goal:description.exports.goal});`
  )
  await execute(f.session, root.value.template)
  assert.equal(result.value.exports.memory.operations.organize.allowedModes[0], 'execute')
  assert.equal(root.value.modules.operations.release, undefined)
  assert.deepEqual(Object.keys(root.value.goal.operations), ['get', 'update'])
  assert.equal(root.value.goal.operations.update.allowedModes[0], 'execute')
})

test('INV-3 业务模板统一通过 describe 按需读取，查询本身不运行业务操作', async (t) => {
  let reads = 0
  let deny = false
  const template =
    "import {output} from 'velaros';import {read} from 'velaros:example';output(await read());"
  const module = {
    binding: {
      moduleId: 'velaros:example',
      instanceId: 'example',
      generation: 1,
      schemaRevision: '1',
    },
    summary: 'example',
    template,
    operations: {
      read: {
        summary: 'read',
        input: { type: 'null' },
        output: { type: 'string' },
        effects: 'none',
        run: () => {
          reads++
          return 'actual value'
        },
      },
    },
  }
  const f = await fixture(t, {
    modules: [module],
    authorize: async (invocation) => {
      if (deny && invocation.binding.moduleId === 'velaros:modules')
        throw Object.assign(new Error('revoked'), { code: 'HOST_DENIED' })
    },
  })
  const result = await execute(
    f.session,
    `${prelude}import * as program from 'velaros:program';output({description:await system.modules.describe({module:'velaros:example'}),programKeys:Object.keys(program).sort()});`
  )
  assert.equal(result.value.description.template, template)
  assert.deepEqual(result.value.programKeys, ['blobs', 'input'])
  assert.equal(reads, 0)
  assert.equal((await execute(f.session, result.value.description.template)).value, 'actual value')
  assert.equal(reads, 1)
  deny = true
  const denied = await execute(
    f.session,
    `${prelude}try{output(await system.modules.describe({module:'velaros:example'}));}catch(error){output({code:error.code});}`
  )
  assert.deepEqual(denied.value, { code: 'HOST_DENIED' })
  assert.equal(reads, 1)
})

test('INV-4 observe 无法修改自身状态，execute 后新笔记进入下一模型帧', async (t) => {
  const f = await fixture(t)
  await f.session.observe({
    source: `${prelude}await system.memory.update({key:'bad',baseRevision:0,body:'must not repeat'});`,
  })
  await submit(f.session)
  assert.match(f.requests[0].materials[0].text, /OPERATION_MODE_DENIED/)
  const empty = await execute(
    f.session,
    `${prelude}output(await system.memory.list({kind:'notes'}));`
  )
  assert.equal(empty.value.items.length, 0)
  await execute(
    f.session,
    `${prelude}await system.memory.update({key:'progress',baseRevision:0,body:'next inspect state'});`
  )
  await f.session.observe({ source: `${prelude}output(await system.memory.list({kind:'notes'}));` })
  await submit(f.session)
  const frame = JSON.parse(f.requests.at(-1).materials[0].text)
  assert.equal(frame.partitions.workspace.notes[0].text, 'next inspect state')
  assert.equal(frame.partitions.workspace.notes[0].read.module, 'velaros:system')
  assert.equal(frame.partitions.workspace.notes[0].read.export, 'memory')
})

test('INV-5 系统调用始终经过宿主授权，引用不能跨会话', async (t) => {
  let deny = false
  const f = await fixture(t, {
    authorize: async (invocation) => {
      if (deny && invocation.binding.moduleId === 'velaros:system-memory')
        throw Object.assign(new Error('revoked'), { code: 'HOST_DENIED' })
    },
  })
  const note = await execute(
    f.session,
    `${prelude}output(await system.memory.update({key:'private',baseRevision:0,body:'secret'}));`
  )
  deny = true
  const blocked = await execute(
    f.session,
    `${prelude}try{await system.memory.list({kind:'notes'});}catch(error){output(error.code);}`
  )
  assert.equal(blocked.value, 'HOST_DENIED')
  deny = false
  const other = await f.runtime.openSession('other')
  await other.context.append({ kind: 'user', body: 'Other task' })
  const foreign = await execute(
    other,
    `${prelude}try{await system.memory.read({ref:${JSON.stringify(note.value.ref)}});}catch(error){output(error.code);}`
  )
  assert.equal(foreign.value, 'SCOPE_MISMATCH')
})

test('INV-6 结果租约和历史源码读取使用同一归档，统一读取不重跑历史脚本', async (t) => {
  const f = await fixture(t)
  const first = await execute(f.session, `${prelude}output('once');`)
  const result = await execute(
    f.session,
    `${prelude}const kept=await system.memory.retain({ref:${JSON.stringify(first.receipt.resultRef)},turns:3});const body=await system.memory.read({ref:${JSON.stringify(first.receipt.resultRef)}});const source=await system.memory.read({ref:${JSON.stringify(first.receipt.sourceRef)}});await system.memory.release({ref:${JSON.stringify(first.receipt.resultRef)}});output({kept,body,source});`
  )
  assert.equal(result.value.kept.executed, false)
  assert.match(result.value.body.text, /once/)
  assert.match(result.value.source.text, /once/)
  const old = await execute(
    f.session,
    `import {output} from 'velaros';import {memory as programs} from 'velaros:system';output(await programs.read({ref:${JSON.stringify(first.receipt.sourceRef)}}));`
  )
  assert.equal(old.value.text, result.value.source.text)
  const log = await createContextInvocationJournal(f.storage).list('s')
  assert.equal(
    log.filter((item) => item.prepared.binding.moduleId === 'velaros:system-memory').length,
    5
  )
})

test('INV-7 过滤授权后分页，不出现空页跳过可见能力', async () => {
  const definitions = ['a', 'b', 'c', 'd'].map((name) => ({
    binding: { moduleId: `velaros:${name}`, instanceId: name, generation: 1, schemaRevision: '1' },
    summary: name,
    template: `// private template ${name}`,
    operations: {
      read: {
        summary: 'read',
        input: { type: 'null' },
        output: { type: 'null' },
        effects: 'none',
        run: () => null,
      },
    },
  }))
  const kernel = createOperationRuntime({ modules: definitions, journal: {} })
  try {
    const catalog = new SystemCatalog({
      kernel: () => kernel,
      allows: (_session, id) => ['velaros:b', 'velaros:d'].includes(id),
    })
    const page = catalog.list('s', { limit: 1, space: 'capability' })
    assert.deepEqual(
      page.items.map((item) => item.specifier),
      ['velaros:b']
    )
    assert.equal(page.nextOffset, 1)
    const next = catalog.list('s', { limit: 1, offset: page.nextOffset, space: 'capability' })
    assert.deepEqual(
      next.items.map((item) => item.specifier),
      ['velaros:d']
    )
    assert.equal(next.nextOffset, null)
    assert.throws(() => catalog.describe('s', 'velaros:a'), { code: 'CAPABILITY_DENIED' })
    assert.equal(catalog.describe('s', 'velaros:b').template, kernel.describe('velaros:b').template)
    assert.throws(() => catalog.describe('s', 'velaros:unknown'), { code: 'CAPABILITY_DENIED' })
  } finally {
    await kernel.dispose()
  }
})

test('INV-3 业务模块按导出名读合同：只交回它与它用到的类型，没有这个名字时说出它导出了什么', async () => {
  const declarations = [
    "declare module 'velaros:docs' {",
    '  /** 写一份文档。 */',
    '  export function write(input: WriteInput): Promise<Written>',
    '  /** 读一份文档。 */',
    '  export function read(input: { path: string }): Promise<string>',
    '  export interface WriteInput { path: string; blocks: Block[] }',
    "  export type Block = { kind: 'heading' | 'paragraph'; text: string }",
    '  export interface Written { path: string }',
    '}',
  ].join('\n')
  const operation = (summary) => ({
    summary,
    input: { type: 'object' },
    output: { type: 'object' },
    effects: 'none',
    run: () => null,
  })
  const kernel = createOperationRuntime({
    modules: [
      {
        binding: {
          moduleId: 'velaros:docs',
          instanceId: 'docs',
          generation: 1,
          schemaRevision: '1',
        },
        summary: 'docs',
        surface: {
          specifier: 'velaros:docs',
          namespace: 'docs',
          methods: ['write', 'read'],
          declarations,
          template: '// docs',
          revision: '1',
          operations: {
            write: { ...operation('write'), hasInput: true },
            read: { ...operation('read'), hasInput: true },
          },
        },
        operations: { write: operation('write'), read: operation('read') },
      },
    ],
    journal: {},
  })
  try {
    const catalog = new SystemCatalog({ kernel: () => kernel, allows: () => true })
    const write = catalog.describe('s', 'velaros:docs', 'write')
    assert.match(write.declarations, /function write/)
    assert.match(write.declarations, /interface WriteInput/)
    assert.match(write.declarations, /type Block/)
    assert.match(write.declarations, /interface Written/)
    assert.doesNotMatch(write.declarations, /function read/)
    assert.deepEqual(Object.keys(write.operations), ['write'])
    assert.equal(write.specifier, 'velaros:docs')
    assert.throws(() => catalog.describe('s', 'velaros:docs', 'remove'), {
      code: 'MODULE_EXPORT',
      message: /write、read/,
    })
  } finally {
    await kernel.dispose()
  }
})

test('INV-8 任意业务包不能占用系统身份或替换系统入口', async () => {
  for (const id of ['velaros:system', 'velaros:system-memory', 'velaros:program']) {
    const storage = localContextStorage({ path: ':memory:' })
    try {
      await assert.rejects(
        () =>
          createRuntime({
            storage,
            runner: nodeSubprocessCodeRunner,
            modules: [{ binding: { moduleId: id }, operations: {} }],
          }),
        /系统保留身份/
      )
    } finally {
      await storage.close()
    }
  }
  assert.throws(
    () =>
      scriptPackageCompiler.compile(
        [
          { specifier: 'velaros:system', exports: {} },
          { specifier: 'velaros:system', exports: {} },
        ],
        []
      ),
    /冲突/
  )
  assert.throws(
    () => scriptPackageCompiler.compile([{ specifier: 'velaros:program', exports: {} }], []),
    /冲突/
  )
  assert.throws(
    () =>
      scriptPackageCompiler.compile(
        [{ specifier: 'velaros:system', exports: JSON.parse('{"__proto__":"velaros:x"}') }],
        []
      ),
    /成员无效/
  )
})

test('INV-9 未授予的包成员检查失败且不进入 runner', async () => {
  const definition = {
    binding: {
      moduleId: 'velaros:private',
      instanceId: 'private',
      generation: 1,
      schemaRevision: '1',
    },
    summary: 'private',
    operations: {
      read: {
        summary: 'private',
        input: { type: 'null' },
        output: { type: 'null' },
        effects: 'none',
        run: () => null,
      },
    },
  }
  const kernel = createOperationRuntime({ modules: [definition], journal: {} })
  let ran = false
  try {
    const script = createKernelScriptSession({
      runtime: kernel,
      runner: {
        run: () => {
          ran = true
          throw new Error('must not run')
        },
      },
      sessionId: 's',
      executionId: 'test',
      allowedModules: [],
      packages: [{ specifier: 'velaros:system', exports: { private: 'velaros:private' } }],
    })
    const program = {
      source: "import {private as secret} from 'velaros:system';await secret.read();",
    }
    assert.equal(script.check(program).ok, false)
    const outcome = await script.run(program)
    assert.equal(outcome.checked, false)
    assert.equal(ran, false)
  } finally {
    await kernel.dispose()
  }
})

test('INV-10 无业务能力的子任务具有自己的系统包，不继承父会话笔记', async (t) => {
  let childCalls = 0
  const child = model(async function* (request) {
    if (++childCalls === 1) {
      yield turn(request, {
        execute: {
          source: `${prelude}const before=await system.memory.list({kind:'notes'});if(before.items.length)throw new Error('parent leaked');await system.memory.update({key:'child',baseRevision:0,body:'own progress'});output(await system.modules.list({space:'capability'}));`,
        },
      })
      yield { type: 'finish', reason: 'stop' }
    } else {
      assert.match(JSON.stringify(request.materials), /own progress/)
      yield* done(request)
    }
  })
  let parentCalls = 0
  const parentModel = model(async function* (request) {
    if (++parentCalls === 1) {
      yield turn(request, {
        execute: {
          source:
            "import {start,wait} from 'velaros:agents';import {output} from 'velaros';const job=await start({task:'work',profile:'worker'});output(await wait({id:job.id}));",
        },
      })
      yield { type: 'finish', reason: 'stop' }
    } else {
      assert.match(JSON.stringify(request.materials), /completed/)
      yield* done(request)
    }
  })
  const f = await fixture(t, {
    model: parentModel,
    agents: { profiles: { worker: { model: child, modules: [] } }, concurrency: 1, maxChildren: 1 },
  })
  await execute(
    f.session,
    `${prelude}await system.memory.update({key:'parent',baseRevision:0,body:'private parent'});`
  )
  await submit(f.session)
  assert.equal(childCalls, 2)
  const parent = await execute(
    f.session,
    `${prelude}output(await system.memory.list({kind:'notes'}));`
  )
  assert.deepEqual(
    parent.value.items.map((item) => item.key),
    ['parent']
  )
})

test('INV-11 系统包保存的观察程序与工作笔记可以跨 Runtime 重启恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'system-resume-'))
  const path = join(root, 'state.sqlite')
  const open = async () =>
    createRuntime({
      storage: localContextStorage({ path }),
      runner: nodeSubprocessCodeRunner,
      modules: [],
    })
  let runtime = await open()
  try {
    const session = await runtime.openSession('persist')
    await session.context.append({ kind: 'user', body: 'Persistent task' })
    await execute(
      session,
      `${prelude}await system.memory.update({key:'progress',baseRevision:0,body:'resume me'});`
    )
    const saved = await session.observe({
      source: `${prelude}output(await system.memory.list({kind:'notes'}));`,
    })
    await runtime.close()
    runtime = await open()
    const resumed = await runtime.openSession('persist')
    const result = await execute(
      resumed,
      `${prelude}output({notes:await system.memory.list({kind:'notes'}),source:await system.memory.read({ref:${JSON.stringify(saved.sourceRef)}})});`
    )
    assert.equal(result.value.notes.items[0].revision, 1)
    assert.match(result.value.source.text, /velaros:system/)
  } finally {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('memory unifies input, saved source, note and result discovery with paged reads', async (t) => {
  const f = await fixture(t)
  const saved = await execute(
    f.session,
    `${prelude}output(await system.memory.update({key:'indexed',baseRevision:0,title:'Human title',body:'primary text'}));`
  )
  const listing = await execute(
    f.session,
    `${prelude}output({inputs:await system.memory.list({kind:'inputs'}),programs:await system.memory.list({kind:'programs'}),results:await system.memory.list({kind:'results'}),notes:await system.memory.list({kind:'notes',query:'Human title'})});`
  )
  assert(listing.value.inputs.items.some((item) => item.kind === 'user'))
  assert(listing.value.programs.items.some((item) => item.ref.id === saved.receipt.sourceRef))
  assert(listing.value.results.items.some((item) => item.ref.id === saved.receipt.resultRef))
  assert.equal(listing.value.notes.items[0].key, 'indexed')
  const read = await execute(
    f.session,
    `${prelude}output(await system.memory.read({ref:${JSON.stringify(saved.receipt.sourceRef)},offset:0,limit:20}));`
  )
  assert.equal(read.value.text.length, 20)
  assert(read.value.totalChars > 20)
})

test('memory note retention is versioned, idempotent when resident and plan updates use the same entry', async (t) => {
  const f = await fixture(t)
  const note = await execute(
    f.session,
    `${prelude}output(await system.memory.update({key:'pin',baseRevision:0,body:'pin me'}));`
  )
  const ref = JSON.stringify(note.value.ref)
  const retained = await execute(
    f.session,
    `${prelude}output(await system.memory.retain({ref:${ref}}));`
  )
  assert.equal(retained.value.revision, 1)
  const released = await execute(
    f.session,
    `${prelude}output(await system.memory.release({ref:${ref}}));`
  )
  assert.equal(released.value.revision, 2)
  assert.equal(released.value.resident, false)
  const stale = await execute(
    f.session,
    `${prelude}try{await system.memory.retain({ref:${ref}})}catch(error){output(error.code)}`
  )
  assert.equal(stale.value, 'WORKSPACE_CONFLICT')
  await execute(
    f.session,
    `${prelude}await system.memory.plan({nextObjective:'Run tests',hypotheses:[],decisions:[],openQuestions:[]});`
  )
  assert.equal((await f.session.view.inspect()).capsule.nextObjective, 'Run tests')
  await submit(f.session)
})

test('rejected note or intent validation records no effect and does not require world reconciliation', async (t) => {
  const f = await fixture(t)
  const result = await execute(
    f.session,
    `${prelude}const failures=[];for(const action of [()=>system.memory.update({key:'missing',baseRevision:0,resident:false}),()=>system.memory.organize({focus:'   '})]){try{await action()}catch(error){failures.push(error.code)}}output(failures);`
  )
  assert.deepEqual(result.value, ['MEMORY_INPUT', 'MEMORY_INPUT'])
  const receipts = await createContextInvocationJournal(f.storage).list('s')
  assert(receipts.every((item) => item.receipt.effect === 'none'))
  await submit(f.session)
})

test('a file explicitly attached to a new task is readable while unrelated previous-task notes stay outside scope', async (t) => {
  let phase = 'initial'
  let checked = false
  const f = await fixture(t, {
    model: model(async function* (request) {
      if (phase === 'initial' || checked) {
        yield* done(request)
        return
      }
      const goal = JSON.parse(request.materials[0].text).partitions.task.goals[0]
      assert.deepEqual(JSON.parse(goal.text).read, {
        module: 'velaros:system',
        export: 'memory',
        operation: 'read',
        input: { ref: goal.record.ref },
      })
      checked = true
      yield turn(request, {
        execute: {
          source: `${prelude}const file=await system.memory.read({ref:${JSON.stringify(file.ref)}});if(file.text!=='Reattached contents')throw Error('file missing');try{await system.memory.read({ref:${JSON.stringify(oldNote)}});throw Error('old note leaked')}catch(error){if(error.code!=='SCOPE_MISMATCH')throw error}output(file.text);`,
        },
      })
      yield { type: 'finish', reason: 'stop' }
    }),
  })
  const file = await f.session.context.append({
    kind: 'audit',
    title: 'upload',
    body: 'Reattached contents',
  })
  const oldNote = (
    await execute(
      f.session,
      `${prelude}output(await system.memory.update({key:'old',baseRevision:0,body:'Previous task secret'}));`
    )
  ).value.ref
  await submit(f.session)
  phase = 'new'
  const events = []
  for await (const event of f.session.submit({
    text: 'Read the attached file',
    task: 'new',
    files: [{ ref: file.ref, name: 'again.txt', mediaType: 'text/plain' }],
  }))
    events.push(event)
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
  assert(checked)
  const state = new ContextMaintenanceState('s', f.storage)
  const snapshot = await state.snapshot(8000, new AbortController().signal)
  assert.equal(
    (await state.read(snapshot, file.ref, 0, 100, new AbortController().signal)).text,
    'Reattached contents'
  )
})

test('INV-3 模型可无参数发现并直接读取有类型的模板与声明', async (t) => {
  const f = await fixture(t)
  const result = await execute(
    f.session,
    `${prelude}const page=await system.modules.list();const api=await system.modules.describe({module:'velaros:system',export:'memory'});output({count:page.items.length,template:api.template.slice(0,200),declarations:api.declarations.slice(0,200)});`
  )
  assert(result.value.count > 0)
  assert.match(result.value.template, /memory/)
  assert.match(result.value.declarations, /declare module/)
})
