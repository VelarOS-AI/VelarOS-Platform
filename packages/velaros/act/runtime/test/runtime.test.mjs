import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { createRuntime } from '../../../dist/act/runtime/index.js'
import { createProjectKernel } from '../../../dist/project/index.js'

import { done, turn } from './support/model-turn.mjs'

test('INV-37 injected storage runs the real runtime when SQLite is disabled', async () => {
  const fixture = fileURLToPath(new URL('./support/no-sqlite.fixture.mjs', import.meta.url))
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--no-experimental-sqlite', fixture],
    { timeout: 60000, maxBuffer: 1024 * 1024 }
  )
  assert.match(stdout, /SQLite disabled: real Act loop/)
})

test('INV-2 runtime exposes one script-context contract and preserves paged source retrieval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'velaros-contract-'))
  const runtime = await createRuntime({
    storage: localContextStorage({ path: join(root, 'state.sqlite') }),
    runner: nodeSubprocessCodeRunner,
    modules: [],
  })
  try {
    const names = runtime.modules().items.map((item) => item.binding.moduleId)
    assert.deepEqual(names, [
      'velaros:interaction',
      'velaros:modules',
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
    runner: nodeSubprocessCodeRunner,
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
    assert.equal((await session.context.search({ query: '仍需保留' })).items.length, 1)
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

test('INV-30 正式入口从 workspace/dataDir 建立唯一主干；关闭重开保留源码和状态', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'act-bootstrap-'))
  const workspace = join(root, 'project')
  const dataDir = join(root, 'state')
  await mkdir(workspace)
  await writeFile(join(workspace, 'a.txt'), 'one\n')
  const runtime = await createRuntime({ workspace, dataDir })
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
      "import {output} from 'velaros';import {read,edit} from 'velaros:project';const file=(await read({files:[{path:'a.txt'}]})).files[0];if(!file.fileRef)throw Error('missing');await edit({steps:[{action:'edit',fileRef:file.fileRef,edits:[{op:'replace',range:1,text:'two'}]}]});output('changed');",
  })
  assert.equal(receipt.result.failed, undefined, JSON.stringify(receipt))
  assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'two\n')
  const durablePath = join(
    dataDir,
    'projects',
    createHash('sha256')
      .update(await realpath(workspace))
      .digest('hex'),
    'transactions.json'
  )
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

test('工作区预设的搜索与 worker 可发现；profile 来自实际配置且可显式关闭', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'act-profiles-'))
  const workspace = join(root, 'project')
  await mkdir(workspace)
  const model = {
    id: 'deterministic',
    limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
    async *stream(request) {
      yield* done(request)
    },
  }
  const runtime = await createRuntime({ workspace, dataDir: join(root, 'state'), model })
  const limited = await createRuntime({
    workspace,
    dataDir: join(root, 'limited'),
    model,
    agents: false,
    search: false,
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
      "import {profiles} from 'velaros:agents';import {output} from 'velaros';const p=await profiles();output(p);if(p[0]?.name!=='worker'||!p[0].modules.includes('velaros:project'))throw Error('invalid profile');",
  })
  assert.equal(response.result.failed, undefined, JSON.stringify(response))
  const search = await session.execute({
    source:
      "import {profiles} from 'velaros:search';import {output} from 'velaros';const p=await profiles();output(p);if(!p.some(item=>item.name==='standard'&&item.default))throw Error('missing standard profile');",
  })
  assert.equal(search.result.failed, undefined, JSON.stringify(search))
  assert.throws(() => limited.describe('velaros:agents'), /未挂载/)
  assert.throws(() => limited.describe('velaros:search'), /未挂载/)
})

test('默认入口在建立状态存储前核验路径、重复挂载和配置', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'act-bootstrap-invalid-'))
  const workspace = join(root, 'project')
  await mkdir(workspace)
  await symlink(workspace, join(root, 'alias'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dataDir of [
    workspace,
    join(workspace, 'state'),
    join(workspace, '..hidden'),
    join(root, 'alias'),
  ])
    await assert.rejects(createRuntime({ workspace, dataDir }), /工作区/)
  await assert.rejects(
    createRuntime({
      workspace,
      modules: [{ binding: { moduleId: 'velaros:project' }, operations: {} }],
    }),
    /重复/
  )
  await assert.rejects(
    createRuntime({
      workspace,
      model: {
        provider: 'openai',
        model: 'test',
        apiKey: 'test',
        baseURL: 'https://example.invalid/?credential=test',
      },
    }),
    /dataDir/
  )
  await assert.rejects(
    createRuntime({
      workspace,
      dataDir: join(root, 'state'),
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

test('INV-32 长任务连续 80 次状态推进，观察和租约保持有界，关闭后真实值可恢复', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'act-soak-'))
  const path = join(root, 'context.sqlite')
  let calls = 0
  let spaceId
  let previous = -1
  const chars = []
  const driver = {
    id: 'soak',
    limits: { contextTokens: 200000, inputTokens: 180000, outputTokens: 4096 },
    estimate: async (request) => ({
      tokens: Math.ceil(JSON.stringify(request).length / 3),
      precision: 'estimate',
      basis: 'deterministic workload',
    }),
    async *stream(request) {
      calls++
      const frame = JSON.parse(request.materials[0].text)
      const tag = request.instructions.match(/当前帧标记：(\S+)。普通/)[1]
      chars.push(JSON.stringify(request).length)
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
          const value = JSON.parse(
            JSON.parse(frame.partitions.observation.text).blocks.find(
              (item) => item.key === 'counter'
            ).text
          ).value
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
    dataDir: root,
    model: driver,
    memory: false,
    context: { maintenance: false },
    limits: { turns: 100, timeoutMs: 180000, projectionChars: 48000 },
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
  assert(
    Math.max(...chars) < 160000,
    JSON.stringify({ max: Math.max(...chars), first: chars[0], last: chars.at(-1) })
  )
  await runtime.close()
  const storage = localContextStorage({ path })
  try {
    assert.equal((await storage.stores.get(spaceId, 'counter')).value, 80)
  } finally {
    await storage.close()
  }
})

test('INV-39 durable session workspace binding survives reopen, aliases and pure-chat capability changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-workspace-binding-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'one')
  const other = join(root, 'two')
  const alias = join(root, 'alias')
  const dataDir = join(root, 'state')
  await mkdir(workspace)
  await mkdir(other)
  await symlink(workspace, alias)
  const first = await createRuntime({ workspace, dataDir })
  await first.openSession('main')
  await first.close()
  const pure = await createRuntime({ workspace: alias, dataDir, project: false })
  assert(!pure.modules().items.some((item) => item.binding.moduleId === 'velaros:project'))
  await pure.openSession('main')
  await pure.close()
  await rm(alias)
  await symlink(other, alias)
  for (const requested of [other, alias, undefined]) {
    const changed = await createRuntime({ workspace: requested, dataDir, project: false })
    try {
      await assert.rejects(changed.openSession('main'), { code: 'WORKSPACE_BINDING_MISMATCH' })
    } finally {
      await changed.close()
    }
  }
  const restored = await createRuntime({ workspace, dataDir })
  await restored.openSession('main')
  await restored.close()
})

test('competing runtime instances atomically bind a new session to only one workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-workspace-race-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const one = join(root, 'one')
  const two = join(root, 'two')
  const dataDir = join(root, 'state')
  await mkdir(one)
  await mkdir(two)
  const runtimes = await Promise.all(
    [one, two].map((workspace) => createRuntime({ workspace, dataDir, project: false }))
  )
  try {
    const results = await Promise.allSettled(runtimes.map((runtime) => runtime.openSession('main')))
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = results.find((result) => result.status === 'rejected')
    assert.equal(rejected.reason.code, 'WORKSPACE_BINDING_MISMATCH')
    const winner = results.findIndex((result) => result.status === 'fulfilled')
    await runtimes[winner].openSession('main')
    // 不同产品会话仍可在同一存储中拥有自己的工作区。
    await runtimes[1 - winner].openSession('separate')
  } finally {
    await Promise.all(runtimes.map((runtime) => runtime.close()))
  }
})

test('existing workspace.json bindings and corrupted bindings fail closed before session activation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-workspace-legacy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'one')
  const other = join(root, 'two')
  const dataDir = join(root, 'state')
  await mkdir(workspace)
  await mkdir(other)
  await mkdir(dataDir)
  await writeFile(
    join(dataDir, 'workspace.json'),
    JSON.stringify({ workspace: await realpath(workspace) })
  )
  const wrong = await createRuntime({ workspace: other, dataDir, project: false })
  try {
    await assert.rejects(wrong.openSession('main'), { code: 'WORKSPACE_BINDING_MISMATCH' })
  } finally {
    await wrong.close()
  }
  const correct = await createRuntime({ workspace, dataDir, project: false })
  await correct.openSession('main')
  await correct.close()
  await rm(join(dataDir, 'workspace.json'))
  const persisted = await createRuntime({ workspace: other, dataDir, project: false })
  try {
    await assert.rejects(persisted.openSession('main'), { code: 'WORKSPACE_BINDING_MISMATCH' })
  } finally {
    await persisted.close()
  }
  await writeFile(join(dataDir, 'workspace.json'), '{broken')
  const corrupt = await createRuntime({ workspace, dataDir, project: false })
  try {
    await assert.rejects(corrupt.openSession('new'))
  } finally {
    await corrupt.close()
  }
})

test('workspace-free sessions cannot acquire a workspace by reopening with a different capability scope', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-workspace-none-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dataDir = join(root, 'state')
  const workspace = join(root, 'project')
  await mkdir(workspace)
  const pure = await createRuntime({ dataDir, project: false })
  await pure.openSession('main')
  await pure.close()
  const withWorkspace = await createRuntime({ workspace, dataDir })
  try {
    await assert.rejects(withWorkspace.openSession('main'), { code: 'WORKSPACE_BINDING_MISMATCH' })
  } finally {
    await withWorkspace.close()
  }
})
