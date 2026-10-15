import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { createNodeCodeRunner } from '@velaros-ai/script'

import { safePackPackage } from '../../../../../scripts/release/safe-package-pack.mjs'
import { createNodeExecutionEnvironment, createRuntime } from '../../../dist/act/runtime/index.js'
import { EnvironmentLimits } from '../../../dist/act/system/contract/constants.js'
import { VelarSystemEnvironmentModule } from '../../../dist/act/system/contract/surface.js'
import { createEnvironmentRegistry, environmentModule } from '../../../dist/act/system/index.js'
import { createLocalShellHost } from '../../../dist/execution/local.js'
import { done, turn } from '../../runtime/test/support/model-turn.mjs'
import { verifyModule } from '../../runtime/test/support/module-contract.mjs'

let root
let server
let registryUrl
const manifests = new Map()
const tarballs = new Map()
let stalled

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'velaros-environment-test-'))
  server = createServer((request, response) => {
    const url = new URL(request.url, registryUrl)
    const name = decodeURIComponent(url.pathname.slice(1))
    if (name === 'environment-stalled') {
      stalled?.()
      return
    }
    response.setHeader('content-type', 'application/json')
    if (url.pathname === '/-/v1/search') {
      response.end(
        JSON.stringify({
          objects: [
            {
              package: {
                name: 'environment-fixture',
                version: '2.0.0',
                description: 'fixture parser',
                maintainers: [],
                keywords: [],
                links: {},
              },
            },
          ],
          total: 1,
        })
      )
    } else if (tarballs.has(name)) {
      response.setHeader('content-type', 'application/octet-stream')
      response.end(tarballs.get(name))
    } else if (manifests.has(name)) {
      response.end(JSON.stringify(manifests.get(name)))
    } else {
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'package not found' }))
    }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  registryUrl = `http://127.0.0.1:${server.address().port}`
  for (const [name, versions] of [
    ['environment-helper', ['1.0.0']],
    ['environment-fixture', ['1.0.0', '2.0.0']],
    ['environment-incompatible', ['1.0.0']],
  ]) {
    const metadata = { name, 'dist-tags': { latest: versions.at(-1) }, versions: {} }
    for (const version of versions) {
      const directory = join(root, 'sources', name, version)
      await mkdir(directory, { recursive: true })
      const manifest = {
        name,
        version,
        description: 'fixture parser',
        type: 'module',
        exports: {
          '.': { import: './index.mjs', require: './index.cjs' },
          './detail': './detail.mjs',
        },
        bin: { [name]: './cli.cjs' },
        engines: { node: name === 'environment-incompatible' ? '>=999' : '>=22' },
        ...(name === 'environment-fixture'
          ? {
              dependencies: { 'environment-helper': '1.0.0' },
              scripts: {
                postinstall: "node -e \"require('fs').writeFileSync('built.txt','built')\"",
              },
            }
          : {}),
      }
      await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
      await writeFile(
        join(directory, 'index.mjs'),
        `export const version = '${version}'; ${name === 'environment-fixture' ? "export {version as helper} from 'environment-helper';" : ''}`
      )
      await writeFile(join(directory, 'index.cjs'), `module.exports = {version:'${version}'};`)
      await writeFile(join(directory, 'detail.mjs'), `export default 'detail-${version}';`)
      await writeFile(join(directory, 'README.md'), `${name} ${version} usage`)
      await writeFile(
        join(directory, 'cli.cjs'),
        `#!/usr/bin/env node\nconsole.log('cli-${version}');`
      )
      await chmod(join(directory, 'cli.cjs'), 0o755)
      await mkdir(join(root, 'archives'), { recursive: true })
      const filename = join(root, 'archives', `${name}-${version}.tgz`)
      await safePackPackage({ packageDirectory: directory, filename, timeoutMs: 15_000 })
      const bytes = await readFile(filename)
      tarballs.set(`${name}-${version}.tgz`, bytes)
      metadata.versions[version] = {
        ...manifest,
        dist: {
          tarball: `${registryUrl}/${name}-${version}.tgz`,
          integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        },
      }
    }
    manifests.set(name, metadata)
  }
})

after(async () => {
  server?.closeAllConnections()
  if (server) await new Promise((done) => server.close(done))
  if (root) await rm(root, { recursive: true, force: true })
})

async function fixture(t) {
  const directory = join(root, randomUUID())
  const cwd = join(directory, 'workspace')
  const dataDir = join(directory, 'data')
  await mkdir(cwd, { recursive: true })
  const shell = createLocalShellHost({ cwd })
  const node = createNodeExecutionEnvironment({
    cwd,
    directory: join(directory, 'runs'),
    host: shell,
    environment: { npm_config_registry: registryUrl, npm_config_fetch_retries: '0' },
  })
  const options = { directory: join(dataDir, 'environments', 'default'), npm: node.npm }
  const registry = createEnvironmentRegistry(options)
  const controller = new AbortController()
  t.after(async () => {
    controller.abort()
    await shell.dispose()
  })
  const runner = createNodeCodeRunner({
    cwd,
    directory: node.directory,
    execute: (request, output, signal) => node.execute(request, output, signal),
    acquireRuntime: (signal) => registry.acquire(signal),
  })
  const run = (source, onLog = () => {}) =>
    runner.run(
      { source, timeoutMs: 20_000, operations: {}, modules: {}, blobs: {} },
      async () => {
        throw Error('unexpected call')
      },
      onLog,
      controller.signal
    )
  return { directory, cwd, dataDir, node, registry, options, run, signal: controller.signal }
}

test('INV-23 环境 TS 合同、效果、模板与常量一致', async () => {
  await verifyModule(
    { create: () => environmentModule.create({ directory: '/definition-only' }) },
    new URL('../environment-template.js', import.meta.url)
  )
  assert.equal(VelarSystemEnvironmentModule.operations.apply.effects, 'write')
  assert.equal(VelarSystemEnvironmentModule.operations.rollback.effects, 'write')
  for (const limit of [
    EnvironmentLimits.changes,
    EnvironmentLimits.specChars,
    EnvironmentLimits.nameChars,
    EnvironmentLimits.packages,
    EnvironmentLimits.history,
    EnvironmentLimits.searchResults,
  ])
    assert(VelarSystemEnvironmentModule.declarations.includes(String(limit)))
})

test('INV-23 真实 npm 搜索、安装和升级支持 ESM/CJS、子路径、间接依赖、CLI、alias、重启和回滚', async (t) => {
  const f = await fixture(t)
  assert.equal(
    (await f.registry.search({ query: 'parser' }, f.signal))[0].name,
    'environment-fixture'
  )
  assert.equal(
    (await f.registry.describe({ package: 'environment-fixture@1.0.0' }, f.signal))[0].version,
    '1.0.0'
  )
  const installed = await f.registry.apply(
    { baseRevision: 0, install: ['environment-fixture@1.0.0'] },
    f.signal
  )
  assert.equal(installed.revision, 1)
  assert.equal(installed.packages[0].version, '1.0.0')
  await assert.rejects(
    readFile(join(installed.packages[0].directory, 'node_modules/environment-fixture/built.txt')),
    { code: 'ENOENT' }
  )
  const source = `import {version,helper} from 'environment-fixture'; import detail from 'environment-fixture/detail'; import {createRequire} from 'node:module'; import {execa} from 'execa'; console.log(JSON.stringify({version,helper,detail,cjs:createRequire(import.meta.url)('environment-fixture').version,cli:(await execa('environment-fixture')).stdout,child:(await execa('node',['--input-type=module','-e',"import {version} from 'environment-fixture';console.log(version)"])).stdout}));`
  const first = await f.run(source)
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.deepEqual(JSON.parse(first.process.stdout), {
    version: '1.0.0',
    helper: '1.0.0',
    detail: 'detail-1.0.0',
    cjs: '1.0.0',
    cli: 'cli-1.0.0',
    child: '1.0.0',
  })
  const updated = await f.registry.apply(
    {
      baseRevision: 1,
      install: ['environment-fixture@2.0.0', 'older@npm:environment-fixture@1.0.0'],
      allowScripts: true,
    },
    f.signal
  )
  assert.equal(updated.revision, 2)
  assert.equal(
    await readFile(
      join(
        updated.packages.find((pkg) => pkg.name === 'environment-fixture').directory,
        'node_modules/environment-fixture/built.txt'
      ),
      'utf8'
    ),
    'built'
  )
  assert.equal((await createEnvironmentRegistry(f.options).list()).revision, 2)
  const second = await f.run(
    `import {version} from 'environment-fixture'; import {version as older} from 'older'; console.log(version, older)`
  )
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.match(second.process.stdout, /2\.0\.0 1\.0\.0/u)
  const restored = await f.registry.rollback({ baseRevision: 2, revision: 1 }, f.signal)
  assert.equal(restored.revision, 3)
  assert.equal(restored.packages[0].version, '1.0.0')
  const replaced = await f.registry.apply(
    { baseRevision: 3, install: ['environment-helper@1.0.0'], remove: ['environment-fixture'] },
    f.signal
  )
  assert.deepEqual(
    replaced.packages.map((pkg) => pkg.name),
    ['environment-helper']
  )
  const removed = await f.registry.apply(
    { baseRevision: 4, remove: ['environment-helper'] },
    f.signal
  )
  assert.deepEqual(removed.packages, [])
  assert.equal((await f.run("import 'environment-fixture'")).ok, false)
  assert.deepEqual(await readdir(f.cwd), [])
})

test('INV-23 同一已打开会话安装后下一次执行即用，宿主授权拒绝不启动安装', async (t) => {
  const f = await fixture(t)
  let denied = false
  const runtime = await createRuntime({
    workspace: f.cwd,
    dataDir: f.dataDir,
    node: f.node,
    project: false,
    agents: false,
    search: false,
    memory: false,
    context: { maintenance: false },
    authorize: (call) => {
      if (denied && call.operation === 'apply') throw Error('host denied')
    },
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('live-environment')
  await session.context.append({ kind: 'user', body: 'Install and manage parser dependencies' })
  const installed = await session.execute({
    source:
      "import {environment} from 'velaros:system'; const state=await environment.list(); console.log(await environment.apply({baseRevision:state.revision,install:['environment-fixture@1.0.0']}))",
  })
  assert.equal(installed.result.failed, undefined, JSON.stringify(installed))
  const used = await session.execute({
    source: "import {version} from 'environment-fixture'; console.log(version)",
  })
  assert.equal(used.result.failed, undefined, JSON.stringify(used))
  denied = true
  const failure = await session.execute({
    source:
      "import {environment} from 'velaros:system'; await environment.apply({baseRevision:1,remove:['environment-fixture']})",
  })
  assert(failure.result.failed, JSON.stringify(failure))
  assert.equal((await f.registry.list()).revision, 1)
})

test('INV-23 首帧获知当前 npm，安装升级回滚删除后的模型帧立即更新', async (t) => {
  const f = await fixture(t)
  const frames = []
  const changes = [
    { baseRevision: 0, install: ['environment-fixture@1.0.0'] },
    { baseRevision: 1, install: ['environment-fixture@2.0.0'] },
    { baseRevision: 2, revision: 1 },
    { baseRevision: 3, remove: ['environment-fixture'] },
  ]
  const runtime = await createRuntime({
    workspace: f.cwd,
    dataDir: f.dataDir,
    node: f.node,
    project: false,
    agents: false,
    search: false,
    memory: false,
    context: { maintenance: false },
    model: {
      id: 'environment-context-test',
      limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
      async *stream(request) {
        frames.push(request)
        const change = changes[frames.length - 1]
        if (!change) {
          yield* done(request)
          return
        }
        yield turn(request, {
          execute: {
            source: `import {environment} from 'velaros:system';console.log(await environment.${'revision' in change ? 'rollback' : 'apply'}(${JSON.stringify(change)}));`,
          },
        })
        yield { type: 'finish', reason: 'stop' }
      },
    },
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('npm-awareness')
  for await (const event of session.submit(
    'Install, upgrade, roll back, and remove the fixture dependency'
  ))
    assert.notEqual(event.type, 'error', JSON.stringify(event))
  assert.equal(frames.length, 5)
  const inventories = frames.map(
    (request) =>
      JSON.parse(request.materials.find((item) => item.origin === 'runtime-view').text).partitions
        .runtime.inventory
  )
  assert.deepEqual(
    inventories.map(
      (item) => item.packages.find((pkg) => pkg.name === 'environment-fixture')?.fallbackVersion
    ),
    [undefined, '1.0.0', '2.0.0', '1.0.0', undefined]
  )
  for (const inventory of inventories.slice(1, 4)) {
    assert.equal(
      inventory.packages.find((pkg) => pkg.name === 'environment-fixture').runtimeImport,
      'velaros:npm/environment-fixture'
    )
  }
  assert.equal(new Set(inventories.map((item) => item.npm.environment)).size, 5)
  assert.ok(frames.every((request) => request.instructions === frames[0].instructions))
  assert.match(frames[1].compiledPrompt, /environment-fixture/)
  assert.doesNotMatch(JSON.stringify(inventories.at(-1)), /environment-fixture/)
})

test('INV-23 更新期间运行中的进程保留旧快照，已结束快照释放租约', async (t) => {
  const f = await fixture(t)
  await f.registry.apply({ baseRevision: 0, install: ['environment-fixture@1.0.0'] }, f.signal)
  let started
  const ready = new Promise((done) => {
    started = done
  })
  const old = f.run(
    `import {existsSync} from 'node:fs'; import {setTimeout} from 'node:timers/promises'; console.log('ready'); while(!existsSync('continue')) await setTimeout(20); const {version}=await import('environment-fixture'); console.log(version)`,
    (text) => {
      if (text.includes('ready')) started()
    }
  )
  await ready
  await f.registry.apply({ baseRevision: 1, install: ['environment-fixture@2.0.0'] }, f.signal)
  await writeFile(join(f.cwd, 'continue'), '')
  const result = await old
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.match(result.process.stdout, /1\.0\.0/u)
  assert.match(
    (await f.run("import {version} from 'environment-fixture'; console.log(version)")).process
      .stdout,
    /2\.0\.0/u
  )
  assert.deepEqual(await readdir(join(f.options.directory, 'leases')), [])
})

test('INV-23 失败、取消、无效参数和并发提交都保留已发布环境', async (t) => {
  const f = await fixture(t)
  await f.registry.apply({ baseRevision: 0, install: ['environment-fixture@1.0.0'] }, f.signal)
  await assert.rejects(
    f.registry.apply({ baseRevision: 1, install: ['environment-incompatible'] }, f.signal),
    /npm 执行失败/u
  )
  for (const spec of [
    '../outside',
    'https://example.test/pkg.tgz',
    '--global',
    'node:fs',
    'x@file:../outside',
  ])
    await assert.rejects(f.registry.apply({ baseRevision: 1, install: [spec] }, f.signal), {
      code: 'VALIDATION',
    })
  await assert.rejects(
    f.registry.apply({ baseRevision: 0, remove: ['environment-fixture'] }, f.signal),
    { code: 'CONFLICT' }
  )
  const controller = new AbortController()
  const waiting = new Promise((done) => {
    stalled = done
  })
  const cancelled = f.registry.apply(
    { baseRevision: 1, install: ['environment-stalled'] },
    controller.signal
  )
  const rejection = assert.rejects(cancelled)
  await waiting
  controller.abort()
  await rejection
  assert.equal((await f.registry.list()).revision, 1)
  const other = createEnvironmentRegistry(f.options)
  const results = await Promise.allSettled([
    f.registry.apply({ baseRevision: 1, install: ['environment-fixture@2.0.0'] }, f.signal),
    other.apply({ baseRevision: 1, remove: ['environment-fixture'] }, f.signal),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'CONFLICT')
  assert.equal((await f.registry.list()).revision, 2)
})

test('INV-23 历史回收保护存活租约，释放后删除过期安装目录', async (t) => {
  const f = await fixture(t)
  const first = await f.registry.apply(
    { baseRevision: 0, install: ['environment-fixture@1.0.0'] },
    f.signal
  )
  const lease = await f.registry.acquire(f.signal)
  let state = await f.registry.apply(
    { baseRevision: 1, install: ['environment-fixture@2.0.0'] },
    f.signal
  )
  for (let i = 0; i < EnvironmentLimits.history; i++)
    state = await f.registry.rollback(
      { baseRevision: state.revision, revision: state.revision },
      f.signal
    )
  await f.registry.collect()
  assert.equal(JSON.parse(await readFile(first.packages[0].packageJson, 'utf8')).version, '1.0.0')
  await lease.release()
  await assert.rejects(readFile(first.packages[0].packageJson), { code: 'ENOENT' })
})

test('INV-23 工作区依赖优先，安装失败的效果与回收不完整的候选有明确状态', async (t) => {
  const f = await fixture(t)
  await f.registry.apply({ baseRevision: 0, install: ['environment-fixture@1.0.0'] }, f.signal)
  const local = join(f.cwd, 'node_modules/environment-fixture')
  await mkdir(local, { recursive: true })
  await writeFile(
    join(local, 'package.json'),
    JSON.stringify({
      name: 'environment-fixture',
      version: '9.0.0',
      type: 'module',
      exports: './index.mjs',
    })
  )
  await writeFile(join(local, 'index.mjs'), "export const version='9.0.0'")
  const result = await f.run("import {version} from 'environment-fixture';console.log(version)")
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.match(result.process.stdout, /9\.0\.0/u)
  const effects = []
  await assert.rejects(
    f.registry.apply({ baseRevision: 0, remove: ['environment-fixture'] }, f.signal, (effect) =>
      effects.push(effect)
    ),
    { code: 'CONFLICT' }
  )
  assert.deepEqual(effects, ['none'])
  const directory = join(f.directory, 'incomplete')
  const incomplete = createEnvironmentRegistry({
    directory,
    npm: {
      install: async () => {
        throw Object.assign(Error('uncollected'), { cleanupIncomplete: true })
      },
    },
  })
  await assert.rejects(
    incomplete.apply({ baseRevision: 0, install: ['environment-fixture'] }, f.signal),
    /uncollected/u
  )
  await incomplete.collect()
  assert.equal((await readdir(join(directory, 'revisions'))).length, 1)
  assert.equal((await incomplete.list()).revision, 0)
})

test('INV-23 单个安装包损坏后仍能执行修复程序并重新安装', async (t) => {
  const f = await fixture(t)
  const installed = await f.registry.apply(
    { baseRevision: 0, install: ['environment-fixture@1.0.0'] },
    f.signal
  )
  await rm(installed.packages[0].packageJson)
  const diagnosis = await f.run(
    "import {readFile} from 'node:fs/promises';const catalog=JSON.parse(await readFile(process.env.VELAROS_HOST_DIR+'/index.json','utf8'));console.log(catalog.packages.find(pkg=>pkg.name==='environment-fixture').error.code)"
  )
  assert.equal(diagnosis.ok, true, JSON.stringify(diagnosis))
  await f.registry.apply({ baseRevision: 1, install: ['environment-fixture@1.0.0'] }, f.signal)
  assert.equal((await f.run("import 'environment-fixture' ")).ok, true)
})
