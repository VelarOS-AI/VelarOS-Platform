import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  createContextInvocationJournal,
  createContextRuntime,
  createContextView,
} from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { createOperationRuntime } from '@velaros-ai/kernel'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { createRuntime } from '../../../dist/act/runtime/index.js'
import { storeModule } from '../../../dist/act/system/impl/StoreModule.js'
import { StoreSession } from '../../../dist/act/system/impl/StoreSession.js'
import {
  done,
  marker,
  modelText,
  runtimeFrame,
  turn,
} from '../../runtime/test/support/model-turn.mjs'
const prelude =
  "import {output} from 'velaros';import {store,modules} from 'velaros:system';const currentStore=(await store.list({})).items[0]?.id;"
const model = (stream) => ({
  id: 'state-test',
  limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
  estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
  stream,
})
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'act-state-'))
  const path = join(root, 'store.sqlite')
  const requests = []
  let storage
  let runtime
  let session
  let storeId
  const open = async () => {
    storage = localContextStorage({ path })
    storeId ??= (
      await storage.stores.create({
        scope: options.stores?.('main')?.scope ?? 'session:main',
        owner: 'main',
        name: 'work',
        operationId: 'fixture',
      })
    ).id
    runtime = await createRuntime({
      storage,
      runner: nodeSubprocessCodeRunner,
      modules: [],
      context: { maintenance: false },
      model: model(async function* (request) {
        requests.push(request)
        yield* done(request)
      }),
      ...options,
    })
    session = await runtime.openSession('main')
  }
  await open()
  await session.context.append({ kind: 'user', body: '共享调查信息' })
  t.after(async () => {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    path,
    requests,
    get storeId() {
      return storeId
    },
    get storage() {
      return storage
    },
    get runtime() {
      return runtime
    },
    get session() {
      return session
    },
    restart: async () => {
      await runtime.close()
      await open()
    },
  }
}
async function execute(session, code) {
  const result = await session.execute({ source: prelude + code })
  assert(result.checked && !result.result.failed, JSON.stringify(result))
  return result.result.value?.default
}
async function submit(session, input = '继续') {
  const events = []
  for await (const event of session.submit(input)) events.push(event)
  return events
}
const frames = (requests) =>
  requests.map((request) =>
    runtimeFrame(request.materials.findLast((x) => x.origin === 'runtime-view').text)
  )

test('INV-13 唯一 store 成员提供完整空间操作和模板，跨重启保存结构化值', async (t) => {
  const f = await fixture(t)
  const info = await execute(
    f.session,
    "output(await modules.describe({module:'velaros:system',export:'store',template:true}));"
  )
  assert.deepEqual(Object.keys(info.exports.store.operations).sort(), [
    'ack',
    'create',
    'events',
    'get',
    'keys',
    'list',
    'publish',
    'read',
    'remove',
    'set',
    'share',
    'subscribe',
    'watch',
  ])
  assert.match(info.template, /from 'velaros:system'/)
  const saved = await execute(
    f.session,
    "output(await store.set({store:currentStore,key:'finding',baseRevision:0,value:{files:['a.ts'],ok:true}}));"
  )
  assert.equal(saved.revision, 1)
  await f.restart()
  assert.deepEqual(
    (await execute(f.session, "output(await store.get({store:currentStore,key:'finding'}));"))
      .value,
    { files: ['a.ts'], ok: true }
  )
  const other = await f.runtime.openSession('other')
  await other.context.append({ kind: 'user', body: 'other' })
  assert.deepEqual((await execute(other, 'output(await store.list({}));')).items, [])
})
test('INV-13 多主线显式共享，未授权空间不可发现；只读投影无写入和创建', async (t) => {
  const f = await fixture(t, {
    stores: (session) => ({
      scope: 'project',
      create: session === 'main',
      grants: session === 'reader' ? [{ store: id, read: ['public/'], write: [] }] : [],
    }),
  })
  const id = f.storeId
  await f.storage.stores.commit({
    store: id,
    key: 'private/secret',
    value: 'hidden',
    baseRevision: 0,
    actor: 'host',
    operationId: 'seed',
  })
  await execute(
    f.session,
    "await store.set({store:currentStore,key:'public/x',baseRevision:0,value:1});"
  )
  const reader = await f.runtime.openSession('reader')
  await reader.context.append({ kind: 'user', body: 'read' })
  const result = await execute(
    reader,
    "output({value:await store.get({store:currentStore,key:'public/x'}),list:await store.keys({store:currentStore}),info:await modules.describe({module:'velaros:system',export:'store'})});"
  )
  assert.equal(result.value.value, 1)
  assert.deepEqual(
    result.list.items.map((x) => x.key),
    ['public/x']
  )
  assert.deepEqual(Object.keys(result.info.exports.store.operations).sort(), [
    'ack',
    'events',
    'get',
    'keys',
    'list',
    'read',
    'subscribe',
    'watch',
  ])
  const readOnly = await reader.execute({
    source: `${prelude}await store.set({store:currentStore,key:'public/x',baseRevision:1,value:2});`,
  })
  assert.match(readOnly.result.failed.message, /not a function/)
  assert.equal(
    await execute(
      reader,
      "try{await store.get({store:currentStore,key:'private/secret'})}catch(error){output(error.code)}"
    ),
    'STORE_DENIED'
  )
  assert.equal(
    await execute(
      reader,
      "try{await store.watch({store:currentStore,prefixes:['']})}catch(error){output(error.code)}"
    ),
    'STORE_DENIED'
  )
  const stranger = await f.runtime.openSession('stranger')
  await stranger.context.append({ kind: 'user', body: 'inspect' })
  assert.deepEqual((await execute(stranger, 'output(await store.list({}));')).items, [])
  assert.equal(
    await execute(
      stranger,
      `try{await store.get({store:${JSON.stringify(id)},key:'public/x'})}catch(error){output(error.code)}`
    ),
    'STORE_DENIED'
  )
  await submit(reader)
  assert(!f.requests.at(-1).instructions.includes('set/remove'))
  assert(!f.requests.at(-1).instructions.includes('create 只在'))
})
test('INV-13 observe 只能读取；写入、订阅与冲突在效果产生前拒绝', async (t) => {
  const f = await fixture(t)
  await f.session.observe({
    source: `${prelude}try{await store.set({store:currentStore,key:'bad',baseRevision:0,value:1})}catch(error){output(error.code)}`,
  })
  await submit(f.session)
  assert.equal(await f.storage.stores.get(f.storeId, 'bad'), null)
  assert.match(frames(f.requests)[0].observation.text, /OPERATION_MODE_DENIED/)
  await f.session.observe({
    source: `${prelude}output(await store.get({store:currentStore,key:'ok'}));`,
  })
  await execute(f.session, "await store.set({store:currentStore,key:'ok',baseRevision:0,value:1});")
  assert.equal(
    await execute(
      f.session,
      "try{await store.set({store:currentStore,key:'ok',baseRevision:0,value:2})}catch(error){output(error.code)}"
    ),
    'STORE_CONFLICT'
  )
})
test('INV-13 宿主拒绝写入不落盘，也不发布变化', async (t) => {
  const f = await fixture(t, {
    authorize: async (invocation) => {
      if (invocation.operation === 'set')
        throw Object.assign(new Error('host denied'), { code: 'HOST_DENIED' })
    },
  })
  await execute(f.session, "await store.watch({store:currentStore,keys:['x']});")
  assert.equal(
    await execute(
      f.session,
      "try{await store.set({store:currentStore,key:'x',baseRevision:0,value:1})}catch(error){output(error.code)}"
    ),
    'HOST_DENIED'
  )
  assert.equal(await f.storage.stores.get(f.storeId, 'x'), null)
  await submit(f.session)
  assert.deepEqual(
    frames(f.requests)
      .at(-1)
      .stores.changes.flatMap((x) => x.events),
    []
  )
})
test('INV-14 订阅元数据进入真正模型帧且纳入 footprint，正文只经 observe 输出', async (t) => {
  const f = await fixture(t)
  await execute(
    f.session,
    "await store.watch({store:currentStore,keys:['x']});await store.set({store:currentStore,key:'x',baseRevision:0,value:{status:'ready',body:'secret-large-body'}});"
  )
  await submit(f.session)
  const frame = frames(f.requests)[0]
  assert.equal(frame.stores.changes.flatMap((x) => x.events)[0].key, 'x')
  assert(!JSON.stringify(frame.stores).includes('secret-large-body'))
  assert.match(f.requests[0].compiledPrompt, /store.changed/)
  const raw = JSON.parse(f.requests[0].materials[0].text)
  assert.equal(raw.memoryStatus.footprint.runtime, JSON.stringify(raw.partitions.runtime).length)
  await f.restart()
  await submit(f.session)
  assert.deepEqual(
    frames(f.requests)
      .at(-1)
      .stores.changes.flatMap((x) => x.events),
    []
  )
})
test('INV-14 模型调用失败后重启补收通知；接受响应时只确认该帧序号', async (t) => {
  let fail = true
  const requests = []
  const f = await fixture(t, {
    model: model(async function* (request) {
      requests.push(request)
      if (fail) throw Error('provider down')
      yield* done(request)
    }),
  })
  await execute(
    f.session,
    "await store.watch({store:currentStore,keys:['x']});await store.set({store:currentStore,key:'x',baseRevision:0,value:1});"
  )
  const events = await submit(f.session)
  assert.notEqual(events.at(-1).status, 'completed')
  const before = frames(requests)[0].stores.changes
  fail = false
  await f.restart()
  await submit(f.session)
  assert.deepEqual(frames(requests)[1].stores.changes, before)
})
test('INV-14 模型思考期间新变更强制再交付一帧，原有通知确认不吞新事件', async (t) => {
  let called = 0
  const requests = []
  const f = await fixture(t, {
    model: model(async function* (request) {
      requests.push(request)
      if (called++ === 0)
        await f.storage.stores.commit({
          store: f.storeId,
          key: 'x',
          baseRevision: 1,
          value: 2,
          actor: 'other',
          operationId: 'concurrent',
        })
      yield* done(request)
    }),
  })
  await execute(f.session, "await store.watch({store:currentStore,keys:['x']});")
  await f.storage.stores.commit({
    store: f.storeId,
    key: 'x',
    baseRevision: 0,
    value: 1,
    actor: 'other',
    operationId: 'first',
  })
  const events = await submit(f.session)
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
  assert.deepEqual(
    frames(requests).map((x) => x.stores.changes.flatMap((x) => x.events).map((e) => e.revision)),
    [[1], [2]]
  )
})
test('INV-14 关注声明可取消，无关键不进入通知且不会驱动额外回合', async (t) => {
  const f = await fixture(t)
  await execute(
    f.session,
    "await store.watch({store:currentStore,keys:['x']});await store.set({store:currentStore,key:'unrelated',baseRevision:0,value:1});"
  )
  await submit(f.session)
  assert.equal(f.requests.length, 1)
  assert.deepEqual(
    frames(f.requests)[0].stores.changes.flatMap((x) => x.events),
    []
  )
  await execute(
    f.session,
    "await store.watch({store:currentStore,keys:[]});await store.set({store:currentStore,key:'x',baseRevision:0,value:1});"
  )
  await submit(f.session)
  assert.equal(frames(f.requests).at(-1).stores.changes.length, 0)
})
test('INV-15 子 Agent 继承父空间与读写范围，但不能再派发子任务', async (t) => {
  let calls = 0
  let started = false
  const child = model(async function* (request) {
    const frame = runtimeFrame(request)
    assert.deepEqual(frame.stores.items[0].access, { read: [''], write: [''] })
    if (calls++ === 0) {
      yield turn(request, {
        execute: {
          source: `${prelude}const parent=await store.get({store:currentStore,key:'plan'});if(!parent)throw Error('missing plan');await store.set({store:currentStore,key:'plan',baseRevision:parent.revision,value:'revised'});const list=await modules.list({});await store.set({store:currentStore,key:'agents/result',baseRevision:0,value:{parent:parent.value,canDelegate:list.items.some(x=>x.specifier==='velaros:agents')}});`,
        },
      })
      yield { type: 'finish', reason: 'stop' }
    } else yield* done(request)
  })
  const root = model(async function* (request) {
    if (!started) {
      started = true
      // 不给 profile、不声明写入与空间：子任务直接继承
      yield turn(request, {
        execute: {
          source: `${prelude}import {start,wait} from 'velaros:agents';const job=await start({task:'inspect'});await wait({id:job.id});`,
        },
      })
      yield { type: 'finish', reason: 'stop' }
    } else yield* done(request)
  })
  const f = await fixture(t, {
    model: root,
    agents: { profiles: { worker: { model: child, modules: [] } }, concurrency: 1, maxChildren: 2 },
  })
  await execute(
    f.session,
    "await store.set({store:currentStore,key:'plan',baseRevision:0,value:'implement'});"
  )
  const events = await submit(f.session)
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
  assert.deepEqual((await f.storage.stores.get(f.storeId, 'agents/result')).value, {
    parent: 'implement',
    canDelegate: false,
  })
  assert.equal((await f.storage.stores.get(f.storeId, 'plan')).value, 'revised')
})
test('INV-15 外部改了读过的状态不挡业务写入，收尾也不再按读到的版本打回', async (t) => {
  let calls = 0
  let writes = 0
  const business = {
    binding: { moduleId: 'test:business', instanceId: 'one', generation: 1, schemaRevision: '1' },
    summary: 'business write',
    operations: {
      write: {
        summary: 'write',
        input: { type: 'null' },
        output: { type: 'integer' },
        effects: 'write',
        run: () => ++writes,
      },
    },
  }
  const f = await fixture(t, {
    modules: [business],
    model: model(async function* (request) {
      if (++calls === 1) {
        await f.storage.stores.commit({
          store: f.storeId,
          key: 'x',
          baseRevision: 1,
          value: 2,
          actor: 'external',
          operationId: 'external',
        })
        yield turn(request, {
          execute: { source: "import {write} from 'test:business';await write(null);" },
        })
        yield { type: 'finish', reason: 'stop' }
      } else if (calls === 2) {
        assert.equal(writes, 1)
        await f.storage.stores.commit({
          store: f.storeId,
          key: 'x',
          baseRevision: 2,
          value: 3,
          actor: 'external',
          operationId: 'external-again',
        })
        yield* done(request)
      } else assert.fail('收尾不该被打回重来')
    }),
  })
  await execute(f.session, "await store.set({store:currentStore,key:'x',baseRevision:0,value:1});")
  await f.session.observe({
    source: `${prelude}output(await store.get({store:currentStore,key:'x'}));`,
  })
  assert.equal((await submit(f.session)).at(-1).status, 'completed')
  assert.equal(writes, 1)
  assert.equal(calls, 2)
})
test('INV-15 自己的状态写回按版本接着改，同一脚本可继续修改和删除', async (t) => {
  let calls = 0
  const f = await fixture(t, {
    model: model(async function* (request) {
      if (calls++ === 0) {
        yield turn(request, {
          execute: {
            source: `${prelude}await store.set({store:currentStore,key:'x',baseRevision:1,value:2});await store.set({store:currentStore,key:'x',baseRevision:2,value:3});await store.remove({store:currentStore,key:'x',baseRevision:3});await store.set({store:currentStore,key:'x',baseRevision:4,value:4});`,
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else yield* done(request)
    }),
  })
  await execute(f.session, "await store.set({store:currentStore,key:'x',baseRevision:0,value:1});")
  await f.session.observe({
    source: `${prelude}output(await store.get({store:currentStore,key:'x'}));`,
  })
  assert.equal((await submit(f.session)).at(-1).status, 'completed')
  const value = await f.storage.stores.get(f.storeId, 'x')
  assert.equal(value.revision, 5)
  assert.equal(value.value, 4)
})
test('INV-13 提交成功而调用回执丢失时，Kernel 从持久提交证据核对，不重跑写入', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  let commits = 0
  const faulted = new Proxy(storage.stores, {
    get(target, key) {
      if (key === 'commit')
        return async (input) => {
          commits++
          await target.commit(input)
          throw Error('lost commit acknowledgement')
        }
      const value = target[key]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const data = await storage.stores.create({
    scope: 'shared',
    owner: 'main',
    name: 'work',
    operationId: 'create',
  })
  const state = new StoreSession(
    'main',
    new Proxy(storage, {
      get: (target, key) =>
        key === 'stores'
          ? faulted
          : typeof target[key] === 'function'
            ? target[key].bind(target)
            : target[key],
    }),
    { scope: 'shared' }
  )
  await state.initialize()
  const kernel = createOperationRuntime({
    journal: createContextInvocationJournal(storage),
    modules: [storeModule.create({ stores: () => state })],
  })
  t.after(async () => {
    await kernel.dispose()
    await storage.close()
  })
  await kernel.start()
  const result = await kernel.invoke({
    id: 'uncertain',
    sessionId: 'main',
    executionId: 'execute',
    binding: kernel.bind('main', 'velaros:system-store'),
    operation: 'set',
    input: { store: data.id, key: 'x', baseRevision: 0, value: 1 },
  })
  assert.equal(result.effect, 'unknown')
  assert.equal((await storage.stores.get(data.id, 'x')).revision, 1)
  const checked = await kernel.reconcile('main', 'uncertain')
  assert.equal(checked.reconciliation.outcome, 'succeeded')
  assert.equal(checked.reconciliation.effect, 'committed')
  assert.equal(commits, 1)
  assert.equal((await storage.stores.get(data.id, 'x')).revision, 1)
})
test('INV-15 显式关闭时 store 同时退出发现、声明与执行', async (t) => {
  const f = await fixture(t, { stores: () => undefined })
  await assert.rejects(
    f.session.execute({
      source: "import {store} from 'velaros:system';await store.get({store:currentStore,key:'x'});",
    }),
    { code: 'SCRIPT_CHECK' }
  )
  const listing = await f.session.execute({
    source:
      "import {output} from 'velaros';import {modules} from 'velaros:system';output(await modules.list({space:'system'}));",
  })
  assert(!listing.result.value.default.items[0].exports.includes('store'))
})

test(
  'INV-14 活动主线等待子任务时，相关状态变化先唤醒下一轮而无需子任务结束',
  { timeout: 10000 },
  async (t) => {
    let release
    let childStarted
    let rootCalls = 0
    let childCalls = 0
    let woke = false
    let jobId
    const hold = new Promise((resolve) => {
      release = resolve
    })
    const started = new Promise((resolve) => {
      childStarted = resolve
    })
    t.after(() => release())
    const child = model(async function* (request) {
      childCalls++
      childStarted()
      await hold
      yield* done(request)
    })
    const root = model(async function* (request) {
      rootCalls++
      if (rootCalls === 1) {
        yield turn(request, {
          execute: {
            source:
              "import {start} from 'velaros:agents';import {output} from 'velaros';output(await start({task:'wait for release',profile:'worker'}));",
          },
        })
        yield { type: 'finish', reason: 'stop' }
        return
      }
      const frame = runtimeFrame(request)
      jobId ??= frame.children[0]?.id
      if (frame.stores.changes.some((x) => x.events.some((event) => event.key === 'signal'))) {
        assert.equal(frame.children[0].status, 'running')
        woke = true
        release()
      }
      yield* done(request)
    })
    const f = await fixture(t, {
      model: root,
      agents: {
        profiles: { worker: { model: child, modules: [] } },
        concurrency: 1,
        maxChildren: 1,
      },
    })
    await execute(f.session, "await store.watch({store:currentStore,keys:['signal']});")
    const running = submit(f.session)
    await started
    // 第一次 waiting 后写入，避免只验证普通下一帧投影。
    for (let i = 0; rootCalls < 2 && i < 400; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert(rootCalls >= 2)
    await new Promise((resolve) => setTimeout(resolve, 40))
    await f.storage.stores.commit({
      store: f.storeId,
      key: 'signal',
      baseRevision: 0,
      value: 'ready',
      actor: 'external',
      operationId: 'wake',
    })
    const timer = setTimeout(() => release(), 4000)
    try {
      const events = await running
      assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
      assert(woke)
      assert.equal(childCalls, 1)
      assert(jobId)
    } finally {
      clearTimeout(timer)
      release()
    }
  }
)

test('INV-15 搜索模型的发现与声明保持叶子能力，不注入共享状态', async (t) => {
  let mainCalls = 0
  let searchCalls = 0
  const search = model(async function* (request) {
    searchCalls++
    assert.equal(runtimeFrame(request).stores, undefined)
    assert(!request.instructions.includes('store.set'))
    if (searchCalls === 1) {
      yield turn(request, {
        execute: {
          source:
            "import {output} from 'velaros';import {modules} from 'velaros:system';output(await modules.list({space:'system'}));",
        },
      })
      yield { type: 'finish', reason: 'stop' }
    } else {
      assert(!modelText(request).includes('system-store'))
      yield {
        type: 'text',
        text: `${turn(request, { execute: { source: "import {output} from 'velaros';import {report} from 'velaros:evidence';await report({findings:[],gaps:[],nextSteps:[]});" } }).text}\n${marker(request)} done`,
      }
      yield { type: 'finish', reason: 'stop' }
    }
  })
  const root = model(async function* (request) {
    if (mainCalls++ === 0) {
      yield turn(request, {
        execute: {
          source: "import {search} from 'velaros:search';await search({query:'inspect'});",
        },
      })
      yield { type: 'finish', reason: 'stop' }
    } else yield* done(request)
  })
  const f = await fixture(t, {
    model: root,
    search: {
      model: search,
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
  const events = await submit(f.session)
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
  assert.equal(searchCalls, 2)
})

test('INV-16 模型创建多个同名空间，相同键互不影响；observe 按空间取正文', async (t) => {
  const f = await fixture(t)
  const pair = await execute(
    f.session,
    "const a=await store.create({name:'work'});const b=await store.create({name:'work'});await store.set({store:a.id,key:'x',baseRevision:0,value:'A'});await store.set({store:b.id,key:'x',baseRevision:0,value:'B'});output([a.id,b.id]);"
  )
  assert.notEqual(pair[0], pair[1])
  await f.restart()
  await f.session.observe({
    source: `${prelude}output([await store.get({store:${JSON.stringify(pair[0])},key:'x'}),await store.get({store:${JSON.stringify(pair[1])},key:'x'})]);`,
  })
  assert.equal((await submit(f.session)).at(-1).status, 'completed')
  const frame = frames(f.requests)[0]
  assert.match(frame.observation.text, /A/)
  assert.match(frame.observation.text, /B/)
  assert.equal((await execute(f.session, 'output(await store.list({}));')).items.length, 3)
  await assert.rejects(
    f.session.execute({ source: "import {state} from 'velaros:system';state.get({key:'x'});" }),
    { code: 'SCRIPT_CHECK' }
  )
})
test('INV-16 observe 不能创建空间；归档立即阻止新读取且目录撤回', async (t) => {
  const f = await fixture(t)
  await f.session.observe({
    source: `${prelude}try{await store.create({name:'bad'})}catch(error){output(error.code)}`,
  })
  await submit(f.session)
  assert.match(frames(f.requests)[0].observation.text, /OPERATION_MODE_DENIED/)
  assert.equal((await f.storage.stores.directory('session:main', 'main', [])).items.length, 1)
  await f.storage.stores.archive('session:main', f.storeId)
  assert.equal(
    await execute(
      f.session,
      `try{await store.get({store:${JSON.stringify(f.storeId)},key:'x'})}catch(error){output(error.code)}`
    ),
    'STORE_DENIED'
  )
  assert.deepEqual((await execute(f.session, 'output(await store.list({}));')).items, [])
})
test('INV-16 多空间变化共享总预算，轮换投递不会饿死后面的空间，确认与重启独立', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  t.after(() => storage.close())
  const session = new StoreSession('main', storage, { scope: 'project' })
  await session.initialize()
  const ids = []
  for (let i = 0; i < 10; i++) {
    const value = await session.create({ name: `s${i}` }, `create${i}`)
    ids.push(value.id)
    await session.watch({ store: value.id, keys: ['x'] }, `watch${i}`)
    await session.set({ store: value.id, key: 'x', value: i, baseRevision: 0 }, `set${i}`)
  }
  const delivered = new Set()
  for (let round = 0; round < 5; round++) {
    const frame = await session.frame(2)
    assert.equal(frame.changes.length, 2)
    assert.equal(frame.changes.flatMap((x) => x.events).length, 2)
    assert.equal(frame.items.length, 4)
    assert(frame.nextAfter)
    for (const item of frame.changes) delivered.add(item.store)
    await session.acknowledge(frame)
  }
  assert.equal(delivered.size, 10)
  assert.equal(await session.pending(), false)
  await session.set({ store: ids[0], key: 'x', value: 100, baseRevision: 1 }, 'later')
  const fresh = new StoreSession('main', storage, { scope: 'project' })
  await fresh.initialize()
  assert.deepEqual(
    (await fresh.frame(2)).changes.map((x) => x.store),
    [ids[0]]
  )
  await fresh.watch({ store: ids[0], keys: [] }, 'clear')
  assert.equal(await fresh.pending(), false)
})
test('INV-16 子任务继承的空间与范围不超过自己；获配 ID 不等于权限；租户边界不能跨越', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  t.after(() => storage.close())
  const owner = new StoreSession('owner', storage, { scope: 'p' })
  await owner.initialize()
  const a = await owner.create({ name: 'a' }, 'a')
  const b = await owner.create({ name: 'b' }, 'b')
  const grant = { store: a.id, read: ['public/'], write: ['public/result/'] }
  const reader = new StoreSession(
    'child',
    storage,
    { scope: 'p', create: false, grants: [grant] },
    false
  )
  await reader.initialize()
  assert.deepEqual(
    (await reader.list({})).items.map((x) => x.id),
    [a.id]
  )
  // 继承的就是自己此刻的范围：不会比自己宽，也拿不到没授权的空间
  assert.deepEqual(await reader.inherit(), [grant])
  assert.deepEqual(
    (await owner.inherit()).map((x) => [x.store, x.read, x.write]).sort(),
    [
      [a.id, [''], ['']],
      [b.id, [''], ['']],
    ].sort()
  )
  await assert.rejects(reader.get(b.id, 'x'), { code: 'STORE_DENIED' })
  const foreign = new StoreSession('owner', storage, { scope: 'foreign', grants: [grant] })
  await assert.rejects(foreign.initialize(), { code: 'STORE_DENIED' })
})
test('INV-16 新会话目录为空，并发打开复用会话，创建后的对象与订阅跨重启恢复', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'store-session-'))
  const path = join(root, 'store.sqlite')
  let storage = localContextStorage({ path })
  let runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    modules: [],
    context: { maintenance: false },
  })
  t.after(async () => {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  })
  const [session, concurrent] = await Promise.all([
    runtime.openSession('main'),
    runtime.openSession('main'),
  ])
  assert.equal(session, concurrent)
  await session.context.append({ kind: 'user', body: 'inspect' })
  assert.deepEqual((await execute(session, 'output(await store.list({}));')).items, [])
  const id = await execute(
    session,
    "const created=await store.create({name:'work'});await store.watch({store:created.id,keys:['x']});await store.set({store:created.id,key:'x',baseRevision:0,value:'saved'});output(created.id);"
  )
  await runtime.close()
  storage = localContextStorage({ path })
  runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    modules: [],
    context: { maintenance: false },
  })
  const reopened = await runtime.openSession('main')
  assert.equal(
    (await execute(reopened, `output(await store.get({store:${JSON.stringify(id)},key:'x'}));`))
      .value,
    'saved'
  )
  const port = new StoreSession('main', storage, { scope: 'session:main' })
  await port.initialize()
  const frame = await port.frame(8)
  assert.equal(frame.changes[0].store, id)
  assert.equal(frame.changes[0].events[0].revision, 1)
  assert.deepEqual(
    (await port.list({})).items.map((item) => item.id),
    [id]
  )
})
test('INV-16 创建回执丢失可核对，重试原调用只得到同一个空间', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  let creates = 0
  const context = createContextRuntime({ sessionId: 'main', storage })
  const view = createContextView({ sessionId: 'main', storage, context, sources: [] })
  await view.begin((await context.append({ kind: 'user', body: 'create workspace' })).ref)
  const faulted = new Proxy(storage.stores, {
    get(target, key) {
      if (key === 'create')
        return async (input) => {
          creates++
          await target.create(input)
          throw Error('lost create response')
        }
      const value = target[key]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const session = new StoreSession(
    'main',
    new Proxy(storage, {
      get: (target, key) =>
        key === 'stores'
          ? faulted
          : typeof target[key] === 'function'
            ? target[key].bind(target)
            : target[key],
    }),
    { scope: 'p' }
  )
  await session.initialize()
  const kernel = createOperationRuntime({
    journal: createContextInvocationJournal(storage),
    modules: [storeModule.create({ stores: () => session })],
  })
  t.after(async () => {
    await kernel.dispose()
    await storage.close()
  })
  await kernel.start()
  const result = await kernel.invoke({
    id: 'create',
    sessionId: 'main',
    executionId: 'e',
    binding: kernel.bind('main', 'velaros:system-store'),
    operation: 'create',
    input: { name: 'work' },
  })
  assert.equal(result.effect, 'unknown')
  assert.equal((await kernel.reconcile('main', 'create')).reconciliation.effect, 'committed')
  assert.equal(creates, 1)
  const receipt = await storage.stores.creation('p', 'main', 'create')
  assert.deepEqual((await storage.load('main')).task.storeRefs, [receipt.id])
  assert.equal(
    (
      await storage.stores.create({
        scope: 'p',
        owner: 'main',
        operationId: 'create',
        name: 'work',
      })
    ).id,
    receipt.id
  )
  assert.equal((await session.list({})).items.length, 1)
})

test('INV-16 子任务每次运行都继承父任务此刻的空间与权限，续跑重新继承，能建空间', async (t) => {
  let rootCalls = 0
  let childCalls = 0
  let jobId
  const child = model(async function* (request) {
    childCalls++
    const frame = runtimeFrame(request)
    assert.equal(frame.stores.items[0].id, f.storeId)
    assert.deepEqual(frame.stores.items[0].access, { read: [''], write: [''] })
    assert(request.instructions.includes('create 只在'))
    yield* done(request)
  })
  const root = model(async function* (request) {
    rootCalls++
    if (rootCalls === 1) {
      yield turn(request, {
        execute: {
          source: `${prelude}import {start,wait} from 'velaros:agents';const j=await start({task:'read'});output(await wait({id:j.id}));`,
        },
      })
      yield { type: 'finish', reason: 'stop' }
    } else if (rootCalls === 2) {
      jobId = runtimeFrame(request).children[0].id
      yield turn(request, {
        execute: {
          source: `import {resume,wait} from 'velaros:agents';await resume({id:${JSON.stringify(jobId)},input:'continue'});await wait({id:${JSON.stringify(jobId)}});`,
        },
      })
      yield { type: 'finish', reason: 'stop' }
    } else if (rootCalls === 3) {
      yield turn(request, {
        execute: {
          source:
            "import {start,wait} from 'velaros:agents';const j=await start({task:'independent',profile:'worker'});await wait({id:j.id});",
        },
      })
      yield { type: 'finish', reason: 'stop' }
    } else yield* done(request)
  })
  const f = await fixture(t, {
    model: root,
    agents: { profiles: { worker: { model: child, modules: [] } }, concurrency: 1, maxChildren: 3 },
  })
  assert.equal((await submit(f.session)).at(-1).status, 'completed')
  assert.equal(childCalls, 3)
})
test('INV-16 宿主显式收窄拥有者权限时，目录与合同一致，订阅按当前授权跨实例恢复', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  t.after(() => storage.close())
  const store = await storage.stores.create({
    scope: 'project',
    owner: 'owner',
    name: 'work',
    operationId: 'create',
  })
  const configuration = {
    scope: 'project',
    create: false,
    grants: [{ store: store.id, read: ['public/'], write: [] }],
  }
  const first = new StoreSession('owner', storage, configuration)
  await first.initialize()
  await first.watch({ store: store.id, keys: ['public/x'] }, 'watch')
  await storage.stores.commit({
    store: store.id,
    key: 'public/x',
    value: 1,
    baseRevision: 0,
    actor: 'host',
    operationId: 'write',
  })
  const session = new StoreSession('owner', storage, configuration)
  await session.initialize()
  assert.equal(session.mode, 'read')
  assert.deepEqual((await session.list({})).items[0].access, { read: ['public/'], write: [] })
  await assert.rejects(
    session.set({ store: store.id, key: 'public/x', baseRevision: 1, value: 2 }, 'denied'),
    { code: 'STORE_DENIED' }
  )
  await assert.rejects(session.get(store.id, 'private/x'), { code: 'STORE_DENIED' })
  const frame = await session.frame(1)
  assert.equal(frame.changes[0].events[0].key, 'public/x')
  await session.acknowledge(frame)
  assert.equal(await first.pending(), false)
  const writer = new StoreSession('owner', storage, { scope: 'project', create: false })
  await writer.initialize()
  assert.equal(writer.mode, 'write')
  assert.deepEqual((await writer.list({})).items[0].access, { read: [''], write: [''] })
  assert.equal(await writer.pending(), false)
})

test('INV-17 六个空间在结果租约到期后持续进入真实请求，重启和继续保留，新任务重建引用', async (t) => {
  const f = await fixture(t)
  const ids = await execute(
    f.session,
    "const ids=[];for(let i=0;i<6;i++){const s=await store.create({name:'investigation-'+i,description:'持续调查登录逻辑'});await store.set({store:s.id,key:'evidence',baseRevision:0,value:'body-only-on-read'});ids.push(s.id)}output(ids);"
  )
  const taskId = (await f.session.view.inspect()).id
  for (let round = 0; round < 4; round++)
    assert.equal((await submit(f.session)).at(-1).status, 'completed')
  const frame = frames(f.requests).at(-1)
  assert.equal(frame.stores.items.length, 4)
  assert.equal(frame.stores.active.total, 6)
  assert.equal(frame.stores.active.omitted, 0)
  assert.deepEqual(new Set(frame.stores.active.items.map((item) => item.id)), new Set(ids))
  assert.equal(frame.stores.active.taskId, taskId)
  assert.deepEqual(frame.results, [])
  assert(!JSON.stringify(frame.stores).includes('body-only-on-read'))
  assert(f.requests.at(-1).instructions.includes('store.list({active:true})'))
  await f.restart()
  await submit(f.session)
  assert.equal(frames(f.requests).at(-1).stores.active.total, 6)
  await submit(f.session, { text: '另一个任务', task: 'new' })
  assert.equal(frames(f.requests).at(-1).stores.active.total, 0)
  assert.notEqual(frames(f.requests).at(-1).stores.active.taskId, taskId)
  assert.equal((await f.storage.stores.get(ids[0], 'evidence')).value, 'body-only-on-read')
  await execute(
    f.session,
    `output(await store.get({store:${JSON.stringify(ids[0])},key:'evidence'}));`
  )
  await submit(f.session)
  assert.deepEqual(
    frames(f.requests)
      .at(-1)
      .stores.active.items.map((item) => item.id),
    [ids[0]]
  )
})

test('INV-17 活跃引用按字符预算投影，省略量明确，现有 list 分页返回完整用途且不会激活整个目录', async (t) => {
  const f = await fixture(t)
  const ids = await execute(
    f.session,
    "const ids=[];for(let i=0;i<6;i++)ids.push((await store.create({name:'work-'+i,description:'x'.repeat(400)})).id);output(ids);"
  )
  const port = new StoreSession('main', f.storage, { scope: 'session:main' })
  await port.initialize()
  const frame = await port.frame(8, 400)
  assert.equal(frame.active.total, 6)
  assert(frame.active.omitted > 0)
  assert(frame.active.items.length > 0)
  assert.equal(frame.active.items.length + frame.active.omitted, 6)
  assert(JSON.stringify(frame.active.items).length <= 400)
  assert(
    frame.active.items.every((item) => item.descriptionTruncated && item.description.length === 160)
  )
  const found = []
  let after
  do {
    const page = await execute(
      f.session,
      `output(await store.list({active:true,limit:2,${after ? `after:${JSON.stringify(after)}` : ''}}));`
    )
    found.push(...page.items)
    after = page.nextAfter
  } while (after)
  assert.deepEqual(new Set(found.map((item) => item.id)), new Set(ids))
  assert(found.every((item) => item.description.length === 400))
  assert.equal((await port.frame(8, 0)).active.omitted, 6)
  await execute(f.session, 'output(await store.list({}));')
  assert.equal((await port.frame(8)).active.total, 6)
})

test('INV-17 活跃引用每轮核验授权，归档与撤回不泄漏名称和用途', async (t) => {
  let grants = []
  const f = await fixture(t, { stores: () => ({ scope: 'project', grants }) })
  const shared = await f.storage.stores.create({
    scope: 'project',
    owner: 'foreign',
    name: 'restricted-name',
    description: 'restricted-purpose',
    operationId: 'shared',
  })
  grants = [{ store: shared.id, read: ['public/'], write: [] }]
  await f.restart()
  await submit(f.session)
  assert.equal(frames(f.requests).at(-1).stores.active.items[0].id, shared.id)
  await execute(f.session, `await store.get({store:${JSON.stringify(shared.id)},key:'public/x'});`)
  grants = []
  await f.restart()
  await submit(f.session)
  assert.equal(frames(f.requests).at(-1).stores.active.total, 0)
  assert(!JSON.stringify(frames(f.requests).at(-1).stores).includes('restricted'))
  const own = await execute(
    f.session,
    "output(await store.create({name:'archived-name',description:'archived-purpose'}));"
  )
  await f.storage.stores.archive('project', own.id)
  await submit(f.session)
  assert.equal(frames(f.requests).at(-1).stores.active.total, 0)
  assert.deepEqual((await execute(f.session, 'output(await store.list({active:true}));')).items, [])
})

test('INV-17 并发使用多个空间以任务 CAS 合并引用，重复 observe 读取不增加重复条目', async (t) => {
  const f = await fixture(t)
  await submit(f.session)
  const ids = []
  for (let i = 0; i < 8; i++)
    ids.push(
      (
        await f.storage.stores.create({
          scope: 'session:main',
          owner: 'main',
          name: `s${i}`,
          operationId: `host${i}`,
        })
      ).id
    )
  const port = new StoreSession('main', f.storage, { scope: 'session:main' })
  await port.initialize()
  await Promise.all(ids.map((id) => port.get(id, 'x')))
  assert.deepEqual(new Set((await f.storage.load('main')).task.storeRefs), new Set(ids))
  await f.session.observe({
    source: `import {output} from 'velaros';import {store} from 'velaros:system';output(await store.get({store:${JSON.stringify(ids[0])},key:'x'}));`,
  })
  await submit(f.session)
  await submit(f.session)
  assert.equal(frames(f.requests).at(-1).stores.active.total, 8)
  assert.equal((await f.storage.load('main')).task.storeRefs.length, 8)
})

test('INV-17 模型只创建而不 output 的空间，后续多轮仍由 Runtime 自动提供引用', async (t) => {
  let calls = 0
  let id
  const f = await fixture(t, {
    model: model(async function* (request) {
      calls++
      if (calls === 1) {
        yield turn(request, {
          execute: {
            source:
              "import {store} from 'velaros:system';await store.create({name:'model-work',description:'整理登录证据'});",
          },
        })
        yield { type: 'finish', reason: 'stop' }
        return
      }
      const active = runtimeFrame(request).stores.active
      assert.equal(active.total, 1)
      assert.equal(active.items[0].name, 'model-work')
      id ??= active.items[0].id
      assert.equal(active.items[0].id, id)
      if (calls < 6) {
        yield turn(request, {
          execute: { source: "import {output} from 'velaros';output('continue investigation');" },
        })
        yield { type: 'finish', reason: 'stop' }
      } else yield* done(request)
    }),
  })
  assert.equal((await submit(f.session)).at(-1).status, 'completed')
  assert.equal(calls, 6)
  assert.deepEqual((await f.storage.load('main')).task.storeRefs, [id])
})

test('INV-18 独立消息只自动注入元数据，接受帧不代表处理，重启仍可读取并确认', async (t) => {
  const f = await fixture(t)
  await execute(
    f.session,
    "await store.subscribe({store:currentStore,topics:['task/']});await store.publish({store:currentStore,topic:'task/ready',value:{text:'message-body-private'}});"
  )
  await submit(f.session)
  const frame = frames(f.requests).at(-1).stores
  assert.equal(frame.messages[0].pending, 1)
  assert.equal(frame.messages[0].events[0].topic, 'task/ready')
  assert(!JSON.stringify(frame).includes('message-body-private'))
  await f.restart()
  const pending = await execute(f.session, 'output(await store.events({store:currentStore}));')
  assert.equal(pending.pending, 1)
  assert.equal(pending.events[0].value.text, 'message-body-private')
  await execute(
    f.session,
    `await store.ack({store:currentStore,ids:[${JSON.stringify(pending.events[0].id)}]});`
  )
  assert.equal(
    (await execute(f.session, 'output(await store.events({store:currentStore}));')).pending,
    0
  )
})
test('INV-18 只读接收者可订阅和确认，发布不可发现；原子事件还需主题写权限', async (t) => {
  const f = await fixture(t, {
    stores: (s) => ({
      scope: 'project',
      create: s === 'main',
      grants:
        s === 'reader'
          ? [{ store: id, read: ['public/'], write: [] }]
          : s === 'writer'
            ? [{ store: id, read: ['public/'], write: ['public/'] }]
            : [],
    }),
  })
  const id = f.storeId
  const reader = await f.runtime.openSession('reader')
  const writer = await f.runtime.openSession('writer')
  await reader.context.append({ kind: 'user', body: 'reader' })
  await writer.context.append({ kind: 'user', body: 'writer' })
  await execute(reader, "await store.subscribe({store:currentStore,topics:['public/']});")
  const unpublished = await reader.execute({
    source: `${prelude}await store.publish({store:currentStore,topic:'public/a',value:1});`,
  })
  assert.match(unpublished.result.failed.message, /not a function/)
  assert.equal(
    await execute(
      reader,
      "try{await store.subscribe({store:currentStore,topics:['private/']})}catch(error){output(error.code)}"
    ),
    'STORE_DENIED'
  )
  assert.equal(
    await execute(
      writer,
      "try{await store.set({store:currentStore,key:'public/state',baseRevision:0,value:1,event:{topic:'private/alert',value:1}})}catch(error){output(error.code)}"
    ),
    'STORE_DENIED'
  )
  assert.equal(await f.storage.stores.get(id, 'public/state'), null)
  await execute(
    writer,
    "await store.set({store:currentStore,key:'public/state',baseRevision:0,value:1,event:{topic:'public/ready',value:1}});"
  )
  const event = await execute(
    reader,
    'output((await store.events({store:currentStore}))?.events[0]);'
  )
  await execute(reader, `await store.ack({store:currentStore,ids:[${JSON.stringify(event.id)}]});`)
})
test('INV-18 发布只执行一次，持续 observe 中不会产生消息；新消息在下一轮强制投递', async (t) => {
  let call = 0
  const requests = []
  const f = await fixture(t, {
    model: model(async function* (request) {
      requests.push(request)
      if (call++ === 0)
        await f.storage.stores.publish({
          store: f.storeId,
          topic: 'event',
          value: 1,
          actor: 'external',
          operationId: 'external',
        })
      yield* done(request)
    }),
  })
  await execute(f.session, "await store.subscribe({store:currentStore,topics:['']});")
  await f.session.observe({
    source: `${prelude}try{await store.publish({store:currentStore,topic:'bad',value:1})}catch(error){output(error.code)}`,
  })
  const result = await submit(f.session)
  assert.equal(result.at(-1).status, 'completed')
  assert.equal(call, 2)
  assert.match(modelText(requests[0]), /OPERATION_MODE_DENIED/)
  assert.deepEqual(
    (await execute(f.session, 'output(await store.events({store:currentStore}));')).events.map(
      (item) => item.topic
    ),
    ['event']
  )
})
test('INV-18 共享材料按键授权、正文可分页，伪造跨键或源会话引用不能读出原文', async (t) => {
  const f = await fixture(t, {
    stores: (s) => ({
      scope: 'project',
      create: s === 'main',
      grants: s === 'reader' ? [{ store: id, read: ['public/'], write: ['public/'] }] : [],
    }),
  })
  const id = f.storeId
  const ref = (
    await f.session.context.append({
      kind: 'note',
      title: 'evidence',
      body: 'literal code ` ${x}\nshared evidence',
    })
  ).ref
  await execute(
    f.session,
    `await store.share({store:currentStore,key:'public/evidence',baseRevision:0,ref:${JSON.stringify(ref)}});await store.share({store:currentStore,key:'private/evidence',baseRevision:0,ref:${JSON.stringify(ref)}});`
  )
  const reader = await f.runtime.openSession('reader')
  await reader.context.append({ kind: 'user', body: 'read shared' })
  const first = await execute(
    reader,
    "output(await store.read({store:currentStore,key:'public/evidence',limit:8}));"
  )
  assert.equal(first.text, 'literal ')
  assert.equal(first.nextOffset, 8)
  const secret = await f.storage.stores.get(id, 'private/evidence')
  await execute(
    reader,
    `await store.set({store:currentStore,key:'public/forged',baseRevision:0,value:${JSON.stringify(secret.value)}});`
  )
  assert.equal(
    await execute(
      reader,
      "try{await store.read({store:currentStore,key:'public/forged'})}catch(error){output(error.code)}"
    ),
    'STORE_DENIED'
  )
  assert.equal(
    await execute(
      reader,
      `try{await store.share({store:currentStore,key:'public/copied',baseRevision:0,ref:${JSON.stringify(ref)}})}catch(error){output(error.code)}`
    ),
    'STORE_DENIED'
  )
  await f.restart()
  assert.match(
    (
      await execute(
        f.session,
        "output(await store.read({store:currentStore,key:'public/evidence',offset:8}));"
      )
    ).text,
    /shared evidence/
  )
})

test('INV-18 空闲宿主可等待持久消息，唤醒不启动模型且关闭会话释放等待', async (t) => {
  const f = await fixture(t)
  await execute(f.session, "await store.subscribe({store:currentStore,topics:['ready']});")
  const control = new AbortController()
  const waiting = f.session.waitForChanges(control.signal)
  const other = localContextStorage({ path: f.path })
  try {
    await other.stores.publish({
      store: f.storeId,
      topic: 'ready',
      value: 1,
      actor: 'worker',
      operationId: 'outside',
    })
    await waiting
  } finally {
    await other.close()
  }
  assert.equal(f.requests.length, 0)
  await submit(f.session)
  assert.equal(f.requests.length, 1)
  const closed = f.session.waitForChanges(control.signal)
  const rejected = assert.rejects(closed, /会话已关闭/)
  await f.session.close()
  await rejected
})
