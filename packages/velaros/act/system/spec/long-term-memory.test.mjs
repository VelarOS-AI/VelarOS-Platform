import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createContextInvocationJournal } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { codeProgramChecker, nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { createRuntime } from '../../../dist/act/runtime/index.js'
import {
  LongTermMemoryModuleIds,
  PersistentLocalMemoryModuleId,
  PersistentMemoryModuleId,
} from '../../../dist/act/system/contract/constants.js'
import { createMemoryStore } from '../../../dist/memory/index.js'
import { done, marker, modelText, turn } from '../../runtime/test/support/model-turn.mjs'

const prelude = "import {memory,modules} from 'velaros:system';import {output} from 'velaros';"
const entry = (id, content = id) => ({
  id,
  type: 'work',
  title: id,
  description: `When working on ${id}`,
  tags: ['release'],
  content,
})
const model = (stream) => ({
  id: 'long-term-test',
  limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
  estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
  stream,
})
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'act-memory-'))
  const store = createMemoryStore({ root })
  const storage = localContextStorage({ path: ':memory:' })
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    modules: [],
    memory: () => store.scope('project:shared'),
    ...options,
  })
  t.after(async () => {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  })
  const session = await runtime.openSession('main')
  await session.context.append({ kind: 'user', body: 'Test memory' })
  return { root, store, storage, runtime, session }
}
async function execute(session, source) {
  const result = await session.execute({ source: prelude + source })
  assert(result.checked && !result.result.failed, JSON.stringify(result))
  return { receipt: result, value: result.result.value?.default }
}
async function describeMemory(session) {
  // 只交出断言所需的合同字段；完整 schema 的展示回执受预算限制，不能当作原值读取。
  return (
    await execute(
      session,
      `const description=await modules.describe({module:'velaros:system',exports: ['memory'],template:true});
       const member=description.exports.memory;
       output({binding:member.binding,operations:Object.keys(member.operations),declarations:description.declarations,template:description.template});`
    )
  ).value
}
async function readOutput(session, receipt) {
  let text = ''
  let pages = 0
  let totalChars
  do {
    const page = (
      await execute(
        session,
        `output(await memory.read(${JSON.stringify({
          ref: receipt.resultRef,
          pointer: '/output/blocks/0/value',
          offset: text.length,
          limit: 4000,
        })}));`
      )
    ).value
    assert.equal(page.offset, text.length)
    assert.equal(page.pointer, '/output/blocks/0/value')
    assert(page.text.length > 0)
    if (totalChars !== undefined) assert.equal(page.totalChars, totalChars)
    totalChars = page.totalChars
    text += page.text
    pages++
  } while (text.length < totalChars)
  assert.equal(text.length, totalChars)
  return { value: JSON.parse(text), pages }
}
async function submit(session, text = 'Continue') {
  const events = []
  for await (const event of session.submit(text)) events.push(event)
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
}

test('INV-12 主线长期记忆统一包合同、模板、发现和真实存储一致，纯脚本宿主也能接入', async (t) => {
  const f = await fixture(t)
  const description = await describeMemory(f.session)
  const operations = description.operations
  assert.equal(description.binding.moduleId, PersistentLocalMemoryModuleId)
  assert.deepEqual(
    [...operations].sort(),
    ['list', 'read', 'update', 'plan', 'retain', 'release', 'recall', 'save', 'remove'].sort()
  )
  assert(!operations.includes('organize'))
  assert.equal(
    codeProgramChecker.typecheck({
      source: description.template,
      granted: [{ namespace: 'velaros:system', declarations: description.declarations }],
    }).ok,
    true
  )
  await f.session.execute({ source: description.template })
  const catalog = (await execute(f.session, 'output(await modules.list({space:"system"}));')).value
  assert.equal(catalog.items.length, 1)
  assert(catalog.items[0].operations.includes('memory.recall'))
  assert(
    !(
      await execute(f.session, 'output(await modules.list({space:"capability"}));')
    ).value.items.some((item) => item.specifier.includes('memory'))
  )
  assert.equal(
    (
      await execute(
        f.session,
        `output(await memory.save(${JSON.stringify(entry('release-order', 'Platform then product'))}));`
      )
    ).value.created,
    true
  )
  assert.equal((await f.store.scope('project:shared').list())[0].content, 'Platform then product')
  const read = (await execute(f.session, 'output(await memory.recall({id:"release-order"}));'))
    .value
  assert.equal(read.items[0].content, 'Platform then product')
  assert.equal(read.nextOffset, null)
  assert.equal(
    (
      await execute(
        f.session,
        'const [found]= (await memory.recall({id:"release-order"})).items;const {revision,updatedAt,tags,...previous}=found;output(await memory.save({...previous,expectedRevision:revision,content:"Verified order"}));'
      )
    ).value.created,
    false
  )
  assert.deepEqual((await f.store.scope('project:shared').list())[0].tags, ['release'])
})

for (const organize of [false, true])
  test(`INV-12 完整记忆合同保存在原始输出并可通过公开分页读取（organize=${organize}）`, async (t) => {
    const passive = model(async function* (request) {
      yield* done(request)
    })
    const f = await fixture(t, {
      model: passive,
      context: { sources: [], maintenance: organize ? { model: passive } : false },
    })
    const description = await describeMemory(f.session)
    const { receipt } = await execute(
      f.session,
      "output(await modules.describe({module:'velaros:system',exports: ['memory'],template:true}));"
    )
    const recalled = await readOutput(f.session, receipt)
    assert(recalled.pages > 1, '完整合同应覆盖跨页的 JSON、中文和换行')
    assert.deepEqual(recalled.value.exports.memory.binding, description.binding)
    assert.deepEqual(Object.keys(recalled.value.exports.memory.operations), description.operations)
    assert.equal(recalled.value.declarations, description.declarations)
    assert.equal(recalled.value.template, description.template)
    assert.equal(description.operations.includes('organize'), organize)
    if (typeof receipt.result.value === 'object')
      assert.deepEqual(
        receipt.result.value.default,
        recalled.value,
        '合同能完整放入兼容展示时内容仍须一致'
      )
    else
      assert.equal(
        typeof receipt.result.value,
        'string',
        '超限兼容展示须明确保留文本，完整合同由原文分页核对'
      )
  })

for (const organize of [false, true])
  test(`INV-12 长期记忆公开合同保留版本并按条件保存、删除与拒绝过期写（organize=${organize}）`, async (t) => {
    const passive = model(async function* (request) {
      yield* done(request)
    })
    const f = await fixture(
      t,
      organize ? { model: passive, context: { sources: [], maintenance: { model: passive } } } : {}
    )
    const { value, receipt } = await execute(
      f.session,
      `
      const initial=${JSON.stringify(entry('conditional', 'v1'))};
      const created=await memory.save({...initial,expectedRevision:null});
      const previous=(await memory.recall({id:initial.id})).items[0];
      const {revision,updatedAt,...writable}=previous;
      const updated=await memory.save({...writable,expectedRevision:revision,content:'v2'});
      let metadataRejected='';
      try { await memory.save({...previous,expectedRevision:updated.revision}); }
      catch(error) { metadataRejected=error.message; }
      const failures=[];
      for(const attempt of [
        ()=>memory.save({...initial,expectedRevision:null}),
        ()=>memory.save({...initial,expectedRevision:revision,content:'stale'}),
        ()=>memory.remove({id:initial.id,expectedRevision:revision})
      ]) { try { await attempt(); failures.push('unexpected-success'); } catch(error) { failures.push(error.code); } }
      const current=(await memory.recall({id:initial.id})).items[0];
      const removed=await memory.remove({id:initial.id,expectedRevision:updated.revision});
      const absent=await memory.remove({id:initial.id,expectedRevision:null});
      output({created,previous,updated,metadataRejected,failures,current,removed,absent});
    `
    )
    assert.match(value.created.revision, /^[a-f0-9]{64}$/)
    assert.equal(value.created.created, true)
    assert.equal(value.previous.revision, value.created.revision)
    assert.equal(value.updated.created, false)
    assert.notEqual(value.updated.revision, value.created.revision)
    assert.match(value.metadataRejected, /多了不认识的字段/)
    assert.deepEqual(value.failures, ['CONFLICT', 'CONFLICT', 'CONFLICT'])
    assert.equal(value.current.content, 'v2')
    assert.equal(value.current.revision, value.updated.revision)
    assert.deepEqual(value.removed, { removed: true })
    assert.deepEqual(value.absent, { removed: false })
    const conflicts = (
      await createContextInvocationJournal(f.storage).list('main', receipt.executionId)
    ).filter((record) => record.receipt?.error?.code === 'CONFLICT')
    assert.equal(conflicts.length, 3)
    assert(conflicts.every((record) => record.receipt.effect === 'none'))
    assert.equal((await f.store.scope('project:shared').list()).length, 0)
  })

test('INV-12 作用域在主会话打开时固定，同作用域跨会话与重启召回，任务笔记仍隔离', async (t) => {
  const f = await fixture(t)
  await execute(
    f.session,
    `await memory.save(${JSON.stringify(entry('shared'))});await memory.update({key:'local',baseRevision:0,body:'local only'});`
  )
  const second = await f.runtime.openSession('second')
  await second.context.append({ kind: 'user', body: 'Other task' })
  assert.equal(
    (await execute(second, 'output(await memory.recall({}));')).value.items[0].id,
    'shared'
  )
  assert.equal(
    (await execute(second, 'output(await memory.list({kind:"notes"}));')).value.items.length,
    0
  )
  await f.runtime.close()
  let mappings = 0
  let scope = 'project:shared'
  const runtime = await createRuntime({
    storage: localContextStorage({ path: ':memory:' }),
    runner: nodeSubprocessCodeRunner,
    modules: [],
    memory: () => {
      mappings++
      return createMemoryStore({ root: f.root }).scope(scope)
    },
  })
  t.after(() => runtime.close())
  const restored = await runtime.openSession('restored')
  await restored.context.append({ kind: 'user', body: 'Restore' })
  scope = 'project:private'
  assert.equal(await runtime.openSession('restored'), restored)
  assert.equal(
    (await execute(restored, 'output(await memory.recall({}));')).value.items[0].id,
    'shared'
  )
  const other = await runtime.openSession('private')
  await other.context.append({ kind: 'user', body: 'Private' })
  assert.equal((await execute(other, 'output(await memory.recall({}));')).value.total, 0)
  assert.equal(mappings, 2)
  const outside = await other.execute({
    source: `${prelude}output(await memory.recall({scope:"project:shared"}));`,
  })
  assert.match(outside.result.failed.message, /多了不认识的字段 scope/)
})

test('INV-12 释放笔记和结果驻留不会删除长期记忆，remove 才会删除原始 Markdown', async (t) => {
  const f = await fixture(t)
  const first = await execute(
    f.session,
    `await memory.save(${JSON.stringify(entry('keep'))});output(await memory.update({key:'progress',baseRevision:0,body:'progress'}));`
  )
  await execute(
    f.session,
    `await memory.release({ref:${JSON.stringify(first.value.ref)}});await memory.release({ref:${JSON.stringify(first.receipt.resultRef)}});`
  )
  assert.equal(
    (await execute(f.session, 'output(await memory.recall({id:"keep"}));')).value.total,
    1
  )
  assert.deepEqual((await execute(f.session, 'output(await memory.remove({id:"keep"}));')).value, {
    removed: true,
  })
  assert.equal((await f.store.scope('project:shared').list()).length, 0)
  assert.deepEqual((await execute(f.session, 'output(await memory.remove({id:"keep"}));')).value, {
    removed: false,
  })
  assert.match(
    (
      await execute(
        f.session,
        `output(await memory.read({ref:${JSON.stringify(first.value.ref)}}));`
      )
    ).value.text,
    /progress/
  )
})

test('INV-12 recall 支持正文检索、精确 ID 和有界分页，不自动塞进模型请求', async (t) => {
  const requests = []
  const f = await fixture(t, {
    context: { maintenance: false },
    model: model(async function* (request) {
      requests.push(request)
      yield* done(request)
    }),
  })
  const scope = f.store.scope('project:shared')
  for (let i = 0; i < 10; i++)
    await scope.save(
      entry(`item-${i}`, i % 2 ? 'durable evidence' : 'secret-not-automatically-loaded')
    )
  const first = (
    await execute(f.session, 'output(await memory.recall({query:"DURABLE",limit:2}));')
  ).value
  assert.equal(first.total, 5)
  assert.equal(first.items.length, 2)
  assert.equal(first.nextOffset, 2)
  const rest = (
    await execute(f.session, 'output(await memory.recall({query:"durable",limit:32,offset:2}));')
  ).value
  assert.equal(rest.items.length, 3)
  assert.equal(rest.nextOffset, null)
  assert.equal(new Set([...first.items, ...rest.items].map((item) => item.id)).size, 5)
  await submit(f.session)
  assert.match(requests[0].instructions, /index.json/)
  assert(!JSON.stringify(requests[0]).includes('secret-not-automatically-loaded'))
})

test('INV-12 observe 每帧可召回最新记忆，但 save/remove 均在派发前拦截', async (t) => {
  const requests = []
  const f = await fixture(t, {
    context: { maintenance: false },
    model: model(async function* (request) {
      requests.push(request)
      yield* done(request)
    }),
  })
  const scope = f.store.scope('project:shared')
  await scope.save(entry('watched', 'v1-memory'))
  await f.session.observe({ source: `${prelude}output(await memory.recall({id:"watched"}));` })
  await submit(f.session)
  assert.match(JSON.stringify(requests.at(-1)), /v1-memory/)
  await scope.save(entry('watched', 'v2-memory'))
  await submit(f.session)
  assert.match(JSON.stringify(requests.at(-1)), /v2-memory/)
  for (const source of [
    `await memory.save(${JSON.stringify(entry('danger'))});`,
    'await memory.remove({id:"watched"});',
  ]) {
    await f.session.observe({ source: prelude + source })
    await submit(f.session)
    assert.match(JSON.stringify(requests.at(-1)), /OPERATION_MODE_DENIED/)
  }
  assert.deepEqual(
    (await scope.list()).map((item) => item.id),
    ['watched']
  )
  const records = await createContextInvocationJournal(f.storage).list('main')
  assert(
    records
      .filter((item) => ['save', 'remove'].includes(item.prepared.operation))
      .every((item) => item.receipt.effect === 'none')
  )
})

test('INV-12 宿主授权和既有输入验证保护长期写入，失败回执记录无副作用', async (t) => {
  let denied = false
  const f = await fixture(t, {
    authorize: async (invocation) => {
      if (denied && LongTermMemoryModuleIds.includes(invocation.binding.moduleId))
        throw Object.assign(new Error('Denied by host'), { code: 'HOST_DENIED' })
    },
  })
  denied = true
  assert.equal(
    (
      await execute(
        f.session,
        `try{await memory.save(${JSON.stringify(entry('blocked'))});}catch(error){output(error.code);}`
      )
    ).value,
    'HOST_DENIED'
  )
  denied = false
  assert.equal(
    (
      await execute(
        f.session,
        `try{await memory.save(${JSON.stringify(entry('../escape'))});}catch(error){output(error.code);}`
      )
    ).value,
    'VALIDATION'
  )
  assert.equal((await f.store.scope('project:shared').list()).length, 0)
  const records = (await createContextInvocationJournal(f.storage).list('main')).filter(
    (item) => item.prepared.operation === 'save'
  )
  assert.equal(records.length, 2)
  assert(records.every((item) => item.receipt.effect === 'none'))
})

test('INV-12 未装配长期记忆时实际合同隐藏三个操作，重复的业务模块入口有迁移错误', async (t) => {
  const f = await fixture(t, { memory: undefined })
  const description = await describeMemory(f.session)
  assert(!description.declarations.includes('recall'))
  assert(!description.template.includes('savedMemory'))
  const hidden = await f.session.execute({ source: `${prelude}output(await memory.recall({}));` })
  assert.match(hidden.result.failed.message, /not a function/)
  const storage = localContextStorage({ path: ':memory:' })
  t.after(() => storage.close())
  await assert.rejects(
    () =>
      createRuntime({
        storage,
        runner: nodeSubprocessCodeRunner,
        modules: [{ binding: { moduleId: 'velaros:memory' }, operations: {} }],
      }),
    /memory\(sessionId\)/
  )
})

test('INV-12 业务子任务和搜索在发现、声明与导入执行层均没有主线长期记忆能力', async (t) => {
  let childCalls = 0
  let searchCalls = 0
  let mappingCalls = 0
  let mainCalls = 0
  const source = `${prelude}output({keys:Object.keys(memory),catalog:await modules.list({space:'system'})});`
  const searchModel = model(async function* (request) {
    if (++searchCalls === 1) {
      yield turn(request, { execute: { source } })
      yield { type: 'finish', reason: 'stop' }
    } else {
      assert(!request.instructions.includes('memory.recall'))
      assert(!modelText(request).includes('system-memory-persistent'))
      assert(!modelText(request).includes('memory.save'))
      yield {
        type: 'text',
        text: `${turn(request, { execute: { source: "import {output} from 'velaros';import {report} from 'velaros:evidence';await report({findings:[],gaps:[],nextSteps:[]});" } }).text}\n${marker(request)} done`,
      }
      yield { type: 'finish', reason: 'stop' }
    }
  })
  const child = model(async function* (request) {
    if (++childCalls === 1) {
      yield turn(request, { execute: { source } })
      yield { type: 'finish', reason: 'stop' }
    } else if (childCalls === 2) {
      assert(!request.instructions.includes('memory.recall'))
      assert(!modelText(request).includes('system-memory-persistent'))
      yield turn(request, { execute: { source: `${prelude}await memory.recall({});` } })
      yield { type: 'finish', reason: 'stop' }
    } else {
      assert.match(modelText(request), /recall.*does not exist|Property 'recall'/)
      yield* done(request)
    }
  })
  const main = model(async function* (request) {
    const source =
      ++mainCalls === 1
        ? "import {start,wait} from 'velaros:agents';import {output} from 'velaros';const job=await start({task:'Inspect capabilities',profile:'worker'});output(await wait({id:job.id}));"
        : mainCalls === 2
          ? "import {search} from 'velaros:search';import {output} from 'velaros';output(await search({query:'Inspect capabilities'}));"
          : null
    if (source) {
      yield turn(request, { execute: { source } })
      yield { type: 'finish', reason: 'stop' }
    } else yield* done(request)
  })
  const f = await fixture(t, {
    model: main,
    memory: () => {
      mappingCalls++
      return {
        list: async () => [],
        save: async () => assert.fail('child write'),
        remove: async () => assert.fail('child delete'),
      }
    },
    agents: { concurrency: 1, maxChildren: 2, profiles: { worker: { model: child, modules: [] } } },
    search: {
      model: searchModel,
      defaultProfile: 'standard',
      profiles: {
        standard: {
          modelCalls: 8,
          modelTokens: 200000,
          finalizationTokens: 16000,
          timeoutMs: 30000,
          callTimeoutMs: 3000,
          finalizationMs: 4000,
          outputTokens: 1024,
          projectionChars: 32000,
          sourceQueries: 16,
          candidates: 64,
          reads: 16,
          readBytes: 128000,
        },
      },
    },
  })
  await submit(f.session, 'Run both branches')
  assert.equal(childCalls, 3)
  assert.equal(searchCalls, 2)
  assert.equal(mappingCalls, 1)
})

test('INV-12 长期记忆与整理共享主入口，整理模型只读固定材料并回传补丁', async (t) => {
  let mainCalls = 0
  let toolCalls = 0
  const organizer = model(async function* (request) {
    toolCalls++
    assert(!request.instructions.includes('memory.recall'))
    assert(!request.instructions.includes('memory.save'))
    assert.match(request.instructions, /index.json/)
    const snapshot = JSON.parse(
      JSON.parse(request.materials[0].text).partitions.task.goals[0].text
    ).snapshot
    const patch = {
      baseRevision: snapshot.baseRevision,
      summary: 'Keep required progress',
      unresolved: [],
    }
    yield {
      type: 'text',
      text: `${turn(request, { execute: { source: `import {output} from 'velaros';import {submit} from 'velaros:context-materials';output(await submit(${JSON.stringify(patch)}));` } }).text}\n${marker(request)} done`,
    }
    yield { type: 'finish', reason: 'stop' }
  })
  const main = model(async function* (request) {
    assert.match(request.instructions, /index.json/)
    assert.match(request.instructions, /capabilities/)
    assert.match(request.instructions, /documentationPath/)
    assert.match(request.instructions, /operationPaths/)
    if (++mainCalls === 1) {
      yield {
        type: 'text',
        text: `${turn(request, { execute: { source: `${prelude}await memory.organize({focus:"Keep progress"});` } }).text}\n${marker(request)} done`,
      }
      yield { type: 'finish', reason: 'stop' }
    } else {
      assert.equal(
        JSON.parse(request.materials[0].text).memoryStatus.maintenance.lastAttempt.status,
        'applied'
      )
      yield* done(request)
    }
  })
  const f = await fixture(t, {
    model: main,
    context: { sources: [], maintenance: { model: organizer } },
  })
  const description = await describeMemory(f.session)
  assert.equal(description.operations.length, 10)
  assert.equal(description.binding.moduleId, PersistentMemoryModuleId)
  assert.equal(
    codeProgramChecker.typecheck({
      source: description.template,
      granted: [{ namespace: 'velaros:system', declarations: description.declarations }],
    }).ok,
    true
  )
  await f.store.scope('project:shared').save(entry('durable', 'Keep across cleanup'))
  await submit(f.session)
  assert.equal(mainCalls, 2)
  assert.equal(toolCalls, 1)
  assert.equal((await f.store.scope('project:shared').list())[0].content, 'Keep across cleanup')
})
