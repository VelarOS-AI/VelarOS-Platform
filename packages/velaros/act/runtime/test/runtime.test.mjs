import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { localContextStorage } from '@velaros-ai/context/node'

import { createNodeRuntime } from '../../../dist/act/runtime/node.js'
import { createProjectKernel } from '../../../dist/project/index.js'

import { done, turn } from './support/model-turn.mjs'
import { projectFixture } from './support/project-fixture.mjs'
import {
  createTestRuntime as createRuntime,
  createTestStorage,
  testBinding,
} from './support/runtime-fixture.mjs'

test('INV-37 injected storage runs the real runtime when SQLite is disabled', async () => {
  const fixture = fileURLToPath(new URL('./support/no-sqlite.fixture.mjs', import.meta.url))
  const root = await mkdtemp(join(tmpdir(), 'runtime-storage-host-'))
  const path = join(root, 'context.sqlite')
  const methods = [
    'allocateReferenceId',
    'load',
    'loadMetadata',
    'selectSnapshot',
    'compareAndSwapMetadata',
    'compareAndSwap',
    'appendRecord',
    'put',
    'get',
    'has',
    'records',
    'close',
  ]
  const connections = []
  const child = fork(fixture, [], {
    execArgv: ['--no-experimental-sqlite'],
    serialization: 'advanced',
    silent: true,
    timeout: 60000,
    killSignal: 'SIGKILL',
  })
  const closed = new Promise((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal }))
  )
  let stdout = ''
  let stderr = ''
  let failure
  let serving = Promise.resolve()
  const stop = (error) => {
    if (failure) return
    failure = error
    child.kill('SIGKILL')
  }
  child.on('error', stop)
  child.stdout.setEncoding('utf8').on('data', (text) => {
    stdout += text
    if (Buffer.byteLength(stdout) > 1024 * 1024)
      stop(new Error('SQLite-disabled fixture stdout exceeded 1 MiB'))
  })
  child.stderr.setEncoding('utf8').on('data', (text) => {
    stderr += text
    if (Buffer.byteLength(stderr) > 1024 * 1024)
      stop(new Error('SQLite-disabled fixture stderr exceeded 1 MiB'))
  })
  // SQLite 连接归父宿主；IPC 只转发正式 ContextStorage 方法，不解释记录或实现 CAS。
  child.on('message', (request) => {
    serving = serving.then(async () => {
      const reply = { channel: 'context-storage', id: request.id }
      try {
        assert.equal(request.channel, 'context-storage')
        assert(Number.isSafeInteger(request.id))
        if (request.method === 'open') {
          const connection = connections.length
          connections.push({ storage: localContextStorage({ path }), closes: 0 })
          reply.value = { connection, methods }
        } else {
          assert(methods.includes(request.method), 'Only public ContextStorage methods are exposed')
          const owner = connections[request.connection]
          assert(owner, 'Storage connection must have been opened')
          assert(Array.isArray(request.args))
          reply.value = await owner.storage[request.method](...request.args)
          if (request.method === 'close') owner.closes++
        }
      } catch (error) {
        reply.error = { name: error.name, message: error.message, code: error.code }
      }
      if (child.connected)
        child.send(reply, (error) => {
          if (error && child.connected) stop(error)
        })
    })
    void serving.catch(stop)
  })
  try {
    const result = await closed
    await serving
    if (failure) throw failure
    assert.equal(result.code, 0, [stdout, stderr, result.signal].join('\n'))
    assert.match(stdout, /SQLite disabled: real Act loop/)
    assert.equal(connections.length, 2)
    assert.deepEqual(
      connections.map((owner) => owner.closes),
      [1, 1]
    )
    const persisted = localContextStorage({ path })
    try {
      assert((await persisted.load('main')).records.some((record) => record.kind === 'user'))
    } finally {
      await persisted.close()
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
    await serving.catch(() => {})
    await Promise.all(connections.map((owner) => owner.storage.close()))
    await rm(root, { recursive: true, force: true })
  }
})

test('INV-2 runtime exposes one script-context contract and preserves paged source retrieval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'velaros-contract-'))
  const runtime = await createRuntime({
    storage: localContextStorage({ path: join(root, 'state.sqlite') }),
    modules: [],
  })
  try {
    const names = runtime.modules().items.map((item) => item.binding.moduleId)
    assert.deepEqual(names, [
      'velaros:executions',
      'velaros:interaction',
      'velaros:modules',
      'velaros:programs',
      'velaros:system-goal',
      'velaros:system-memory-local',
      'velaros:system-store',
      'velaros:system-store-read',
      'velaros:system-store-write',
    ])
    assert.throws(() => runtime.describe('velaros:script'), /未挂载模块/)
    const s = await runtime.openSession('s')
    assert.equal('run' in s, false)
    await s.context.append({ kind: 'user', body: 'Read the saved script' })
    const source = `// source to recall\nimport {output} from 'velaros';output(1);`
    const saved = await s.observe({ source })
    const result = await s.execute({
      source: `import {output} from 'velaros';import {memory as programs} from 'velaros:system';output((await programs.read({ref:${JSON.stringify(saved.sourceRef)},offset:0,limit:60000})).text);`,
    })
    assert.equal(result.result.failed, undefined)
    assert.match(JSON.stringify(result), /source to recall/)
  } finally {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('INV-3 基础契约放不进窗口时明确阻塞；截断响应不执行程序', async () => {
  const root = await mkdtemp(join(tmpdir(), 'velaros-blocked-'))
  let requests = 0
  let effects = 0
  const options = {
    storage: localContextStorage({ path: join(root, 'blocked.sqlite') }),
    modules: [],
    model: {
      id: 'tiny',
      limits: { contextTokens: 100, inputTokens: 100, outputTokens: 10 },
      estimate: async () => ({ tokens: 200, precision: 'exact', basis: '测试' }),
      async *stream(request) {
        requests++
        yield* done(request)
      },
    },
    limits: {
      turns: 3,
      outputTokens: 10,
      safetyTokens: 10,
      projectionChars: 1000,
      recoveryChars: 1000,
      timeoutMs: 10000,
    },
  }
  const runtime = await createRuntime(options)
  try {
    const session = await runtime.openSession('tiny')
    const events = []
    for await (const event of session.submit('仍需保留的用户输入')) events.push(event)
    assert.equal(events.at(-1).status, 'context_blocked')
    assert.equal(requests, 0)
    assert.equal(
      (await session.context.search({ query: '仍需保留' })).items.filter(
        (hit) => hit.kind === 'user'
      ).length,
      1
    )
  } finally {
    await runtime.close()
  }
  const truncated = await createRuntime({
    ...options,
    limits: { ...options.limits, projectionChars: 30000, recoveryChars: 6000 },
    storage: localContextStorage({ path: join(root, 'truncated.sqlite') }),
    model: {
      ...options.model,
      limits: { contextTokens: 1000, inputTokens: 1000, outputTokens: 100 },
      estimate: async () => ({ tokens: 1, precision: 'exact', basis: '测试' }),
      async *stream(request) {
        yield turn(request, {
          execute: {
            source:
              "import { increment } from 'example:counter'; export default await increment(1)",
          },
        })
        yield { type: 'finish', reason: 'length' }
      },
    },
    modules: [
      {
        binding: {
          moduleId: 'example:counter',
          instanceId: 'one',
          generation: 1,
          schemaRevision: '1',
        },
        summary: '计数',
        operations: {
          increment: {
            summary: '增加',
            input: { type: 'integer' },
            output: { type: 'integer' },
            effects: 'write',
            run: (value) => {
              effects += value
              return effects
            },
          },
        },
      },
    ],
  })
  try {
    const events = []
    for await (const event of (await truncated.openSession('truncated')).submit('执行'))
      events.push(event)
    assert.equal(events.at(-1).status, 'failed')
    assert.equal(effects, 0)
  } finally {
    await truncated.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('INV-30 显式 Node 与 Project 组合共享主干；关闭重开保留源码和状态', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'act-bootstrap-'))
  const workspace = join(root, 'project')
  const dataDir = join(root, 'state')
  await mkdir(workspace)
  await writeFile(join(workspace, 'a.txt'), 'one\n')
  const durablePath = join(dataDir, 'project-transactions.json')
  const runtime = await createNodeRuntime({
    cwd: workspace,
    stateDirectory: dataDir,
    binding: testBinding,
    localHost: { processConfinement: { mode: 'danger-full-access' } },
    ...(await projectFixture({ root: workspace, transactionStatePath: durablePath })),
  })
  t.after(async () => {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  })
  const [first, same] = await Promise.all([
    runtime.openSession('main'),
    runtime.openSession('main'),
  ])
  assert.equal(first, same)
  await first.context.append({ kind: 'user', body: 'Edit a.txt and preserve script state' })
  const receipt = await first.execute({
    source:
      "import {output} from 'velaros';import {commit} from 'velaros:project';await commit({changes:[{path:'a.txt',oldText:'one',newText:'two'}]});output('changed');",
  })
  assert.equal(receipt.result.failed, undefined, JSON.stringify(receipt))
  assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'two\n')
  const durable = JSON.parse(await readFile(durablePath, 'utf8'))
  assert.match(JSON.stringify(durable), /applied/)
  const recovered = await createProjectKernel({
    root: await realpath(workspace),
    transactionStatePath: durablePath,
  })
  assert.equal((await recovered.read({ path: 'a.txt' })).snapshot.content, 'two\n')

  const saved = await first.observe({
    source: "import {output} from 'velaros';output('stable context');",
  })
  await Promise.all([first.close(), first.close()])
  assert.equal(runtime.getSession('main'), undefined)
  const reopened = await runtime.openSession('main')
  assert.notEqual(reopened, first)
  const replay = await reopened.execute({ sourceRef: saved.sourceRef })
  assert.equal(replay.result.failed, undefined, JSON.stringify(replay))
  assert.match(JSON.stringify(replay), /stable context/)
  await assert.rejects(runtime.openSession('store-material:forged'), /身份无效/)
})

test('执行目录与模型不推导业务能力；worker 按显式 profile 挂载', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'act-profiles-'))
  const cwd = join(root, 'execution')
  await mkdir(cwd)
  const model = {
    id: 'deterministic',
    limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
    async *stream(request) {
      yield* done(request)
    },
  }
  const options = {
    cwd,
    binding: testBinding,
    localHost: { processConfinement: { mode: 'danger-full-access' } },
    model,
  }
  const limited = await createNodeRuntime({ ...options, stateDirectory: join(root, 'limited') })
  const runtime = await createNodeRuntime({
    ...options,
    stateDirectory: join(root, 'state'),
    agents: {
      profiles: { worker: { model, node: true, modules: [] } },
      concurrency: 1,
      maxChildren: 4,
    },
  })
  t.after(async () => {
    await runtime.close()
    await limited.close()
    await rm(root, { recursive: true, force: true })
  })
  const session = await runtime.openSession('main')
  await session.context.append({ kind: 'user', body: 'Inspect available profiles' })
  const response = await session.execute({
    source:
      "import {profiles} from 'velaros:agents';import {output} from 'velaros';const p=await profiles();output(p);if(p[0]?.name!=='worker'||p[0].modules.length)throw Error('invalid profile');",
  })
  assert.equal(response.result.failed, undefined, JSON.stringify(response))
  for (const module of ['velaros:project', 'velaros:images', 'velaros:agents', 'velaros:search'])
    assert.throws(() => limited.describe(module), /未挂载/)
})

test('Node 装配在获取资源前核验路径、宿主所有权和模型配置', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'act-bootstrap-invalid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'execution')
  await mkdir(cwd)
  const options = {
    cwd,
    stateDirectory: join(root, 'state'),
    binding: testBinding,
    localHost: { processConfinement: { mode: 'danger-full-access' } },
  }
  await assert.rejects(createNodeRuntime({ ...options, cwd: 'relative' }), { code: 'VALIDATION' })
  await assert.rejects(createNodeRuntime({ ...options, stateDirectory: 'relative' }), {
    code: 'VALIDATION',
  })
  await assert.rejects(createNodeRuntime({ ...options, host: {} }), { code: 'VALIDATION' })
  await assert.rejects(createNodeRuntime({ ...options, localHost: {} }), { code: 'VALIDATION' })
  await assert.rejects(
    createNodeRuntime({
      ...options,
      model: {
        provider: 'openai',
        model: 'test',
        apiKey: 'test',
        baseURL: 'https://example.invalid/?credential=test',
      },
    }),
    /baseURL/
  )
})

test('打开会话失败后清除半初始化资源，可以用同一 ID 重试', async (t) => {
  let attempts = 0
  const runtime = await createRuntime({
    storage: localContextStorage({ path: ':memory:' }),
    memory: () => {
      if (++attempts === 1) throw Error('port unavailable')
      return {}
    },
  })
  t.after(() => runtime.close())
  await assert.rejects(runtime.openSession('main'), /port unavailable/)
  assert.equal(runtime.getSession('main'), undefined)
  assert.equal((await runtime.openSession('main')).id, 'main')
})

test(
  'INV-32 长任务连续 80 次状态推进，观察和租约保持有界，关闭后真实值可恢复',
  {
    skip:
      process.platform === 'darwin' || process.platform === 'linux'
        ? false
        : 'The 80-turn observation soak requires a default read-only process backend.',
  },
  async (t) => {
    // Assert the configured cap, including discovery metadata whose size varies by host path.
    const frameChars = 48000
    const root = await mkdtemp(join(tmpdir(), 'act-soak-'))
    const path = join(root, 'context.sqlite')
    let calls = 0
    let spaceId
    let previous = -1
    const bodies = []
    const statuses = []
    let largestFrame
    // 窗口较小，80 轮里会封几次段；观察到的计数跨段仍须逐轮正确
    const driver = {
      id: 'soak',
      limits: { contextTokens: 40000, inputTokens: 30000, outputTokens: 4096 },
      estimate: async (request) => ({
        tokens: Math.ceil(JSON.stringify(request).length / 3),
        precision: 'estimate',
        basis: 'deterministic workload',
      }),
      async *stream(request) {
        calls++
        const frame = JSON.parse(request.materials[0].text)
        const tag = request.compiledPrompt.match(/当前帧标记：(@@\w+)。/)[1]
        bodies.push(request.materials[0].text.length)
        if (!largestFrame || request.materials[0].text.length > largestFrame.chars)
          largestFrame = {
            chars: request.materials[0].text.length,
            partitions: Object.fromEntries(
              Object.entries(frame.partitions).map(([key, value]) => [
                key,
                JSON.stringify(value).length,
              ])
            ),
            recentResults: frame.partitions.recent.results.length,
            historyBodies: frame.partitions.recent.results.filter((item) => item.bodyInHistory)
              .length,
          }
        statuses.push(request.contextStatus)
        const block = (name, source) => `${tag} ${name}()\n${source}\n${tag}\n`
        if (calls === 1) {
          yield {
            type: 'text',
            text: block(
              'execute',
              "import {store} from 'velaros:system';import {output} from 'velaros';const s=await store.create({name:'soak'});await store.set({store:s.id,key:'counter',baseRevision:0,value:0});output(s);"
            ),
          }
        } else {
          const id = frame.partitions.runtime.stores.active.items[0].id
          spaceId ??= id
          assert.equal(id, spaceId)
          if (calls > 2) {
            assert.equal(frame.partitions.observation.presentation.format, 'text')
            const lines = frame.partitions.observation.text.split('\n')
            assert.equal(JSON.parse(lines[1]).key, 'counter')
            const value = JSON.parse(lines.slice(2).join('\n')).value
            assert.equal(value, calls - 2)
            previous = value
          }
          const expression = `await store.get({store:${JSON.stringify(id)},key:'counter'})`
          if (calls === 2)
            yield {
              type: 'text',
              text: block(
                'observe',
                `import {store} from 'velaros:system';import {output} from 'velaros';// 持续观察实际计数\noutput(${expression},{key:'counter',purpose:'Track actual progress'});`
              ),
            }
          if (calls <= 81)
            yield {
              type: 'text',
              text: block(
                'execute',
                `import {store} from 'velaros:system';import {output} from 'velaros';const current=${expression};if(!current)throw Error('missing');output(await store.set({store:${JSON.stringify(id)},key:'counter',baseRevision:current.revision,value:Number(current.value)+1}));`
              ),
            }
          else yield { type: 'text', text: `${tag} done` }
        }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const runtime = await createRuntime({
      storage: await createTestStorage(root),
      model: driver,

      context: { maintenance: false },
      limits: { turns: 100, timeoutMs: 180000, projectionChars: frameChars },
    })
    t.after(async () => {
      await runtime.close()
      await rm(root, { recursive: true, force: true })
    })
    const session = await runtime.openSession('main')
    const events = []
    for await (const event of session.submit(
      'Advance the counter 80 times and verify the final observation'
    ))
      if (event.type === 'state') events.push(event)
    assert.equal(events.at(-1).status, 'completed')
    assert.equal(calls, 82)
    assert.equal(previous, 80)
    // 每帧都在窗口内；本帧尾不随轮数变长；中间确实封过段
    assert(statuses.every((status) => status.inputTokens <= status.inputLimit))
    assert(Math.max(...bodies) <= frameChars, JSON.stringify(largestFrame))
    assert(
      Math.max(...statuses.map((status) => status.segment.index)) >= 2,
      JSON.stringify(statuses.map((status) => status.segment))
    )
    await runtime.close()
    const storage = localContextStorage({ path })
    try {
      assert.equal((await storage.stores.get(spaceId, 'counter')).value, 80)
      const snapshot = await storage.load('main')
      const requests = snapshot.records.filter((record) => record.title === 'model-request')
      assert.equal(requests.length, calls)
      let requestChars = 0
      for (const record of requests) {
        const body = await storage.get('main', record.objectId)
        assert.equal(record.chars, body.length)
        assert(body.length < 2048, `request ${record.ref.id}: ${body.length} UTF-16 units`)
        assert.equal(JSON.parse(body).requestAudit.schemaVersion, 3)
        requestChars += body.length
      }
      assert(
        requestChars < calls * 2048,
        '80-step persistence is bounded per request, independently of historical prefix size'
      )
      let frameChars = 0
      for (const record of snapshot.records.filter((record) =>
        record.title.startsWith('context:frame:')
      ))
        frameChars += (await storage.get('main', record.objectId)).length
      t.diagnostic(
        JSON.stringify({
          modelRequestUtf16: requestChars,
          contextFrameUtf16: frameChars,
          requests: calls,
        })
      )
    } finally {
      await storage.close()
    }
  }
)

test('INV-39 durable execution identity, authorization and capability bindings survive reopen', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-binding-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const module = {
    binding: {
      moduleId: 'fixture:resource',
      instanceId: 'one',
      generation: 1,
      schemaRevision: '1',
    },
    summary: 'binding fixture',
    operations: {},
  }
  const open = async (binding = testBinding, modules = [module]) =>
    createRuntime({ storage: await createTestStorage(root), binding, modules })
  const first = await open()
  await first.openSession('main')
  await first.close()
  const same = await open()
  await same.openSession('main')
  await same.close()
  for (const [binding, modules] of [
    [{ ...testBinding, executionIdentity: 'other-user' }, [module]],
    [{ ...testBinding, authorizationScope: 'other-grant' }, [module]],
    [testBinding, [{ ...module, binding: { ...module.binding, instanceId: 'two' } }]],
    [testBinding, [{ ...module, binding: { ...module.binding, generation: 2 } }]],
    [testBinding, []],
  ]) {
    const changed = await open(binding, modules)
    try {
      await assert.rejects(changed.openSession('main'), { code: 'CONFLICT' })
    } finally {
      await changed.close()
    }
  }
  const restored = await open()
  await restored.openSession('main')
  await restored.close()
})

test('competing runtimes atomically bind a session to one execution authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-binding-race-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtimes = await Promise.all(
    ['one', 'two'].map(async (executionIdentity) =>
      createRuntime({
        storage: await createTestStorage(root),
        binding: { ...testBinding, executionIdentity },
      })
    )
  )
  try {
    const results = await Promise.allSettled(runtimes.map((runtime) => runtime.openSession('main')))
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'CONFLICT')
    const winner = results.findIndex((result) => result.status === 'fulfilled')
    await runtimes[winner].openSession('main')
    await runtimes[1 - winner].openSession('separate')
  } finally {
    await Promise.all(runtimes.map((runtime) => runtime.close()))
  }
})

test('INV-39 corrupted, duplicated and retired product bindings reject activation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-binding-corrupt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const initial = await createRuntime({ storage: await createTestStorage(root) })
  for (const id of ['corrupted', 'duplicated', 'retired']) await initial.openSession(id)
  await initial.close()
  const storage = await createTestStorage(root)
  try {
    for (const id of ['corrupted', 'duplicated', 'retired']) {
      const state = await storage.load(id)
      const binding = state.records.find((record) => record.title === 'runtime:binding')
      assert(binding)
      const records = [...state.records]
      if (id === 'corrupted') {
        const body = '{broken'
        const objectId = await storage.put(id, body)
        records[records.indexOf(binding)] = { ...binding, objectId, chars: body.length }
      } else if (id === 'retired')
        records[records.indexOf(binding)] = { ...binding, title: 'runtime:workspace' }
      else
        records.push({
          ...binding,
          ref: { sessionId: id, id: crypto.randomUUID() },
          sequence: records.at(-1).sequence + 1,
        })
      assert(
        await storage.compareAndSwap(id, state.version, {
          ...state,
          version: state.version + 1,
          records,
        })
      )
    }
  } finally {
    await storage.close()
  }
  const runtime = await createRuntime({ storage: await createTestStorage(root) })
  try {
    for (const id of ['corrupted', 'duplicated', 'retired'])
      await assert.rejects(runtime.openSession(id), { code: 'CONFLICT' })
  } finally {
    await runtime.close()
  }
})

test('Node canonical execution directory remains fixed across restore', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-node-binding-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const one = join(root, 'one')
  const two = join(root, 'two')
  const alias = join(root, 'alias')
  await mkdir(one)
  await mkdir(two)
  await symlink(one, alias)
  const options = {
    stateDirectory: join(root, 'state'),
    binding: testBinding,
    localHost: { processConfinement: { mode: 'danger-full-access' } },
  }
  const first = await createNodeRuntime({ ...options, cwd: one })
  await first.openSession('main')
  await first.close()
  const same = await createNodeRuntime({ ...options, cwd: alias })
  await same.openSession('main')
  await same.close()
  await rm(alias)
  await symlink(two, alias)
  const changed = await createNodeRuntime({ ...options, cwd: alias })
  try {
    await assert.rejects(changed.openSession('main'), { code: 'CONFLICT' })
  } finally {
    await changed.close()
  }
})
