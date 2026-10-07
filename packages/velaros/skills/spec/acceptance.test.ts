import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { execa } from 'execa'

import { createExclusiveSqliteLock } from '@velaros-ai/core/utils/ExclusiveSqliteLock'
import {
  createOperationRuntime,
  type InvocationRecord,
  type OperationContext,
} from '@velaros-ai/kernel'
import type { NodeCodeRunnerOptions } from '@velaros-ai/script'
import {
  createKernelScriptSession,
  createNodeCodeRunner,
  nodeExecutable,
  scriptContractCompiler,
} from '@velaros-ai/script'

import type { SkillDependencyInstaller } from '../contract/requires'
import {
  builtinSkillDirectories,
  BuiltinSkillNames,
  createSkillRegistry,
  skillCapabilityModules,
  skillComposition,
  type SkillRegistryApi,
  type SkillsOperationContext,
  skillsOperations,
} from '../index'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(
  installer: SkillDependencyInstaller = { install: async () => {} },
  builtins = false
) {
  const root = await mkdtemp(join(tmpdir(), 'velaros-skills-'))
  roots.push(root)
  const store = join(root, 'store')
  await mkdir(store)
  const create = () =>
    createSkillRegistry({
      directory: store,
      nodeVersion: '24.15.0',
      builtins: builtins ? builtinSkillDirectories() : undefined,
      installer,
      lock: createExclusiveSqliteLock(() => new Database(join(store, 'lock.sqlite'))),
    })
  return { root, store, registry: create(), create }
}

async function selectAll(registry: SkillRegistryApi) {
  return (await registry.list()).map((item) => ({
    name: item.manifest.name,
    generation: item.generation,
    grants: item.manifest.contribution.capabilities.map((capability) => capability.module),
  }))
}

async function source(
  root: string,
  name: string,
  version = '1.0.0',
  contribution: object = { packages: [name] }
) {
  const directory = join(root, name.replace('/', '-'), version)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name,
      version,
      type: 'module',
      exports: { '.': './index.mjs', './detail': './detail.cjs' },
      agentSkill: contribution,
    })
  )
  await writeFile(
    join(directory, 'index.mjs'),
    `export const version = ${JSON.stringify(version)};`
  )
  await writeFile(
    join(directory, 'detail.cjs'),
    `module.exports = {version:${JSON.stringify(version)}};`
  )
  return directory
}

async function nodeOptions(root: string): Promise<NodeCodeRunnerOptions> {
  const cwd = join(root, 'workspace')
  await mkdir(cwd, { recursive: true })
  return {
    cwd,
    directory: join(root, 'runs'),
    execute: async (request, onOutput, signal) => {
      const result = await execa(nodeExecutable.resolve()!, [request.entrypoint!], {
        cwd,
        env: {
          ...request.environment,
          NODE_OPTIONS: `--import ${JSON.stringify(request.preload)}`,
        },
        reject: false,
        cancelSignal: signal,
      })
      onOutput(result.stdout)
      return { exitCode: result.exitCode ?? null, stdout: result.stdout, stderr: result.stderr }
    },
  }
}

test('INV-1 纯说明目录和标准 npm 包使用相同安装索引，来源目录保持原样', async () => {
  const f = await fixture()
  const directory = join(f.root, 'instructions')
  await mkdir(directory)
  await writeFile(
    join(directory, 'SKILL.md'),
    '---\nname: review-guide\ndescription: Review evidence\n---\nRead the actual diff.'
  )
  const instructions = await f.registry.install({ directory }, new AbortController().signal)
  expect(instructions.manifest.contribution.instructions).toBe('SKILL.md')
  expect(await Bun.file(join(directory, 'package.json')).exists()).toBe(false)
  await f.registry.install(
    { directory: await source(f.root, 'numbers') },
    new AbortController().signal
  )
  const lease = await f.registry.acquire(await selectAll(f.registry))
  expect(lease.environment.skills.map((item) => item.name).sort()).toEqual([
    'numbers',
    'review-guide',
  ])
  expect(lease.environment.packages.map((item) => item.name)).toEqual(['numbers'])
  expect(await readFile(join(instructions.directory, 'SKILL.md'), 'utf8')).toContain(
    'Read the actual diff.'
  )
  await lease.release()
})

test('INV-1 依赖安装失败与取消都保留原来的安装版本', async () => {
  const f = await fixture({
    install: async () => {
      throw new Error('installer failed')
    },
  })
  await f.registry.install(
    { directory: await source(f.root, 'numbers') },
    new AbortController().signal
  )
  const directory = await source(f.root, 'numbers', '2.0.0')
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  manifest.dependencies = { dependency: '1.0.0' }
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
  await expect(f.registry.install({ directory }, new AbortController().signal)).rejects.toThrow(
    'installer failed'
  )
  const signal = AbortSignal.abort(new Error('cancelled'))
  await expect(f.registry.install({ directory }, signal)).rejects.toThrow('cancelled')
  expect((await f.registry.list())[0]!.manifest.version).toBe('1.0.0')
})

test('INV-2 升级与卸载保留旧环境文件，租约释放后才能回收', async () => {
  const f = await fixture()
  const first = await f.registry.install(
    { directory: await source(f.root, 'numbers') },
    new AbortController().signal
  )
  const old = await f.registry.acquire(await selectAll(f.registry))
  await f.registry.install(
    { directory: await source(f.root, 'numbers', '2.0.0') },
    new AbortController().signal
  )
  const current = await f.registry.acquire(await selectAll(f.registry))
  expect(current.environment.id).not.toBe(old.environment.id)
  expect(old.environment.packages[0]!.version).toBe('1.0.0')
  await f.registry.remove('numbers')
  await f.registry.collect()
  expect(await Bun.file(join(first.directory, 'index.mjs')).exists()).toBe(true)
  await old.release()
  expect(await f.registry.collect()).toContain(`packages/${first.generation}`)
  expect(await Bun.file(join(first.directory, 'index.mjs')).exists()).toBe(false)
  await current.release()
})

test('INV-3 安装不激活 Skill，会话选择与能力授权互不影响，升级使旧代次失效', async () => {
  const f = await fixture()
  const module = 'skill:example'
  const directory = await source(f.root, 'example', '1.0.0', {
    capabilities: [{ module, entry: 'index.mjs', contract: 'api.d.ts' }],
  })
  await writeFile(
    join(directory, 'api.d.ts'),
    '/** @OperationEffect none */ export function read(): Promise<string>;'
  )
  const record = await f.registry.install({ directory }, new AbortController().signal)
  const empty = await f.registry.acquire()
  const readonly = await f.registry.acquire([
    { name: 'example', generation: record.generation, grants: [] },
  ])
  const authorized = await f.registry.acquire([
    { name: 'example', generation: record.generation, grants: [module] },
  ])
  expect(empty.environment.skills).toHaveLength(0)
  expect(readonly.environment.skills[0]!.capabilities).toEqual([])
  expect(authorized.environment.skills[0]!.capabilities).toEqual([module])
  expect(
    await skillCapabilityModules.create({
      registry: f.registry,
      lease: readonly,
      node: await nodeOptions(f.root),
    })
  ).toHaveLength(0)
  await expect(
    f.registry.acquire([
      { name: 'example', generation: record.generation, grants: ['skill:unknown'] },
    ])
  ).rejects.toThrow('未知')
  await f.registry.install({ directory }, new AbortController().signal)
  await expect(
    f.registry.acquire([{ name: 'example', generation: record.generation, grants: [] }])
  ).rejects.toThrow('重新选择')
  await expect(f.registry.assertGranted('example', record.generation, module)).rejects.toThrow(
    '授权已失效'
  )
  await Promise.all([empty.release(), readonly.release(), authorized.release()])
})

test('INV-4 越界链接、无效 Node 版本和安装后篡改都明确失败', async () => {
  const f = await fixture()
  const directory = await source(f.root, 'example')
  await writeFile(join(f.root, 'outside.txt'), 'outside')
  await symlink(join(f.root, 'outside.txt'), join(directory, 'outside'))
  await expect(f.registry.install({ directory }, new AbortController().signal)).rejects.toThrow(
    '越过安装目录'
  )
  await rm(join(directory, 'outside'))
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  manifest.engines = { node: '>=100' }
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
  await expect(f.registry.install({ directory }, new AbortController().signal)).rejects.toThrow(
    '需要 Node'
  )
  delete manifest.engines
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
  const installed = await f.registry.install({ directory }, new AbortController().signal)
  await writeFile(join(installed.directory, 'index.mjs'), 'export const tampered = true')
  await expect(f.registry.acquire(await selectAll(f.registry))).rejects.toThrow('安装收据不符')
})

test('INV-5 公开包冲突不会覆盖另一个 Skill 的版本', async () => {
  const installer: SkillDependencyInstaller = {
    install: async (directory) => {
      const owner = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).name
      const dependency = join(directory, 'node_modules', 'common')
      await mkdir(dependency, { recursive: true })
      await writeFile(
        join(dependency, 'package.json'),
        JSON.stringify({ name: 'common', version: '1.0.0', main: 'index.js' })
      )
      await writeFile(join(dependency, 'index.js'), `module.exports = ${owner === 'first' ? 1 : 2}`)
    },
  }
  const f = await fixture(installer)
  for (const name of ['first', 'second']) {
    const directory = await source(f.root, name, '1.0.0', { packages: ['common'] })
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    manifest.dependencies = { common: '1.0.0' }
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
    await f.registry.install({ directory }, new AbortController().signal)
  }
  expect((await f.registry.list()).map((skill) => skill.manifest.name)).toEqual(['first', 'second'])
  const selected = await selectAll(f.registry)
  await expect(f.registry.acquire(selected)).rejects.toThrow('已由 first 提供')
  for (const item of selected) await (await f.registry.acquire([item])).release()
})

test('INV-2 两个注册实例从当前索引发布，互不丢失已安装包', async () => {
  const f = await fixture()
  const second = f.create()
  await f.registry.install(
    { directory: await source(f.root, 'first') },
    new AbortController().signal
  )
  await second.install({ directory: await source(f.root, 'second') }, new AbortController().signal)
  expect((await f.registry.list()).map((skill) => skill.manifest.name).sort()).toEqual([
    'first',
    'second',
  ])
})

test('INV-2 环境中的 ESM、CJS、子路径与保存脚本在真实 Node 进程使用同一版本', async () => {
  const f = await fixture()
  await f.registry.install(
    { directory: await source(f.root, 'numbers') },
    new AbortController().signal
  )
  const lease = await f.registry.acquire(await selectAll(f.registry))
  const cwd = join(f.root, 'workspace')
  await mkdir(cwd)
  await writeFile(join(cwd, 'saved.cjs'), "console.log(require('numbers/detail').version)")
  const runner = createNodeCodeRunner({
    cwd,
    directory: join(f.root, 'runs'),
    runtime: lease.environment,
    execute: async (request, onOutput, signal) => {
      const result = await execa(nodeExecutable.resolve()!, [request.entrypoint!], {
        cwd,
        env: {
          ...request.environment,
          NODE_OPTIONS: `--import ${JSON.stringify(request.preload)}`,
        },
        reject: false,
        cancelSignal: signal,
      })
      onOutput(result.stdout)
      return { exitCode: result.exitCode ?? null, stdout: result.stdout, stderr: result.stderr }
    },
  })
  const outcome = await runner.run(
    {
      source:
        "import {version} from 'numbers'; import {createRequire} from 'node:module'; import {execa} from 'execa'; const require=createRequire(import.meta.url); const child=await execa(process.execPath,['saved.cjs']); console.log(JSON.stringify([version,require('numbers/detail').version,child.stdout]));",
      modules: {},
      operations: {},
      blobs: {},
      timeoutMs: 10_000,
    },
    async () => ({ error: { code: 'PERMISSION', message: 'no calls' } }),
    () => {}
  )
  expect(outcome.error).toBeUndefined()
  expect(outcome.process?.stderr).toBe('')
  expect(outcome.ok).toBe(true)
  expect(outcome.process?.stdout).toContain('["1.0.0","1.0.0","1.0.0"]')
  await lease.release()
})

test('INV-3 第三方能力经过真实 Kernel 和独立 Node，卸载后既有客户端不能继续调用', async () => {
  const f = await fixture()
  const module = 'skill:calculator'
  const directory = await source(f.root, 'calculator', '1.0.0', {
    capabilities: [{ module, entry: 'index.mjs', contract: 'api.d.ts' }],
  })
  await writeFile(
    join(directory, 'index.mjs'),
    'export async function double(input) { return {value:input.value*2,pid:process.pid}; } export async function optional(input={value:7}) { return input.value; } export async function nothing() {} export async function nullable(input) { return input === null; }'
  )
  await writeFile(
    join(directory, 'api.d.ts'),
    '/** 计算二倍并返回进程身份。\n * @OperationEffect none\n */\nexport function double(input: {value:number}): Promise<{value:number;pid:number}>;\n/** @OperationEffect none */\nexport function optional(input?: {value:number}): Promise<number>;\n/** @OperationEffect none */\nexport function nothing(): Promise<void>;\n/** @OperationEffect none */\nexport function nullable(input: {value:number}|null): Promise<boolean>;'
  )
  await f.registry.install({ directory }, new AbortController().signal)
  const lease = await f.registry.acquire(await selectAll(f.registry))
  const node = await nodeOptions(f.root)
  const modules = await skillCapabilityModules.create({ registry: f.registry, lease, node })
  const records = new Map<string, InvocationRecord>()
  const kernel = createOperationRuntime({
    modules,
    journal: {
      read: async (_session, id) => records.get(id) ?? null,
      claim: async (prepared) => {
        const existing = records.get(prepared.id)
        if (existing) return existing
        records.set(prepared.id, { phase: 'reserved', prepared })
        return null
      },
      prepare: async (prepared) => {
        records.set(prepared.id, { phase: 'prepared', prepared })
      },
      settle: async (receipt) => {
        records.set(receipt.invocation.id, {
          phase: 'settled',
          prepared: receipt.invocation,
          receipt,
        })
      },
    },
  })
  try {
    const run = (
      id: string,
      source = `import {double} from '${module}'; export default await double({value:21});`
    ) =>
      createKernelScriptSession({
        runtime: kernel,
        runner: createNodeCodeRunner({ ...node, runtime: lease.environment }),
        sessionId: 'skill-client',
        executionId: id,
        allowedModules: [module],
      }).run({
        source,
      })
    const result = await run('first')
    expect(result.checked).toBe(true)
    if (!result.checked) throw new Error('source should parse')
    expect(result.result.failed).toBeUndefined()
    expect(result.rawValue).toMatchObject({ value: 42 })
    expect((result.rawValue as { pid: number }).pid).not.toBe(process.pid)
    for (const [name, expected] of [
      ['optional', 7],
      ['nothing', null],
      ['nullable', true],
    ] as const) {
      const value = await run(
        name,
        `import {${name}} from '${module}'; export default await ${name}(${name === 'nullable' ? 'null' : ''});`
      )
      if (!value.checked) throw new Error('source should parse')
      expect(value.result.failed).toBeUndefined()
      expect(value.rawValue).toBe(expected)
    }
    await f.registry.remove('calculator')
    const denied = await run('denied')
    expect(denied.checked).toBe(true)
    if (!denied.checked) throw new Error('source should parse')
    expect(denied.result.failed?.message).toContain('授权已失效')
    expect(
      [...records.values()].filter((record) => record.receipt?.outcome === 'succeeded')
    ).toHaveLength(4)
  } finally {
    await kernel.dispose()
    await lease.release()
  }
})

test('INV-4 冻结的环境事实不可修改，替换环境链接后禁止复用', async () => {
  const f = await fixture()
  await f.registry.install(
    { directory: await source(f.root, 'numbers') },
    new AbortController().signal
  )
  const lease = await f.registry.acquire(await selectAll(f.registry))
  expect(Object.isFrozen(lease.environment.packages[0])).toBe(true)
  expect(Object.isFrozen(lease.skills[0]?.manifest.contribution)).toBe(true)
  const target = join(lease.environment.packages[0]!.directory, 'node_modules/numbers')
  await rm(target)
  await symlink(f.root, target, 'junction')
  await expect(f.registry.acquire(await selectAll(f.registry))).rejects.toThrow(
    '环境包目标已被修改'
  )
  await lease.release()
})

test('INV-4 损坏租约不会被当成进程组信号，也不会触发文件回收', async () => {
  const f = await fixture()
  await mkdir(join(f.store, 'leases'), { recursive: true })
  await writeFile(
    join(f.store, 'leases/broken.json'),
    JSON.stringify({ pid: -1, environment: 'bad', generations: [] })
  )
  await expect(f.registry.collect()).rejects.toThrow('环境租约无效')
})

test('INV-2 两个实例并发发布只保留完整安装，冲突后可重试而不丢失更新', async () => {
  const f = await fixture()
  const first = await source(f.root, 'first')
  const second = await source(f.root, 'second')
  const registries = [f.registry, f.create()]
  const directories = [first, second]
  const results = await Promise.allSettled(
    registries.map((registry, i) =>
      registry.install({ directory: directories[i]! }, new AbortController().signal)
    )
  )
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      expect(String(result.reason)).toContain('另一个进程正在修改')
      await registries[index]!.install(
        { directory: directories[index]! },
        new AbortController().signal
      )
    }
  }
  expect((await f.registry.list()).map((item) => item.manifest.name).sort()).toEqual([
    'first',
    'second',
  ])
  const lease = await f.registry.acquire(await selectAll(f.registry))
  expect(lease.environment.packages).toHaveLength(2)
  await lease.release()
})

test('INV-3 第三方合同支持可省略参数并拒绝通过类型导入读取宿主依赖', () => {
  const surface = scriptContractCompiler.compile(
    '/** Optional lookup. @OperationEffect none */\nexport declare function lookup(input?: { id: string }): Promise<string>;',
    'skill:lookup'
  )
  expect(surface.operations.lookup!.input.anyOf?.[0]).toEqual({ type: 'null' })
  expect(() =>
    scriptContractCompiler.compile('export type Host = import("node:fs");', 'skill:lookup')
  ).toThrow('不能导入外部类型')
  expect(() =>
    scriptContractCompiler.compile(
      '/** @OperationEffect none */ export default function read(): string;',
      'skill:lookup'
    )
  ).toThrow('需要具名导出')
})

test('INV-1 说明、标准包和组合 Skill 经真实 Node 发现并调用独立服务', async () => {
  const examples = resolve(import.meta.dir, '../../../../examples/skills')
  const dependency = dirname(createRequire(import.meta.url).resolve('semver/package.json'))
  const f = await fixture({
    install: async (directory) => {
      await cp(dependency, join(directory, 'node_modules/semver'), {
        recursive: true,
        dereference: true,
      })
    },
  })
  const server = createServer((request, response) => {
    expect(new URL(request.url!, 'http://localhost').searchParams.get('q')).toBe('reviewer')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify([{ name: 'Release Reviewer', email: 'reviewer@example.test' }]))
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  try {
    await f.registry.install(
      { directory: join(examples, 'guided-review') },
      new AbortController().signal
    )
    await f.registry.install(
      { directory: join(examples, 'semver-tools') },
      new AbortController().signal
    )
    const combined = join(f.root, 'combined')
    await cp(join(examples, 'team-directory'), combined, { recursive: true })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing service address')
    await writeFile(
      join(combined, 'service.json'),
      JSON.stringify({ endpoint: `http://127.0.0.1:${address.port}/members` })
    )
    const manifest = JSON.parse(await readFile(join(combined, 'package.json'), 'utf8'))
    manifest.dependencies = { semver: '7.8.5' }
    manifest.agentSkill.packages = ['semver']
    await writeFile(join(combined, 'package.json'), JSON.stringify(manifest))
    await f.registry.install({ directory: combined }, new AbortController().signal)
    const lease = await f.registry.acquire(await selectAll(f.registry))
    const node = { ...(await nodeOptions(f.root)), runtime: lease.environment }
    const modules = await skillCapabilityModules.create({ registry: f.registry, lease, node })
    const provider = modules[0]!
    const runner = createNodeCodeRunner(node)
    const result = await runner.run(
      {
        source: `
      import {readFile} from 'node:fs/promises'; import {join} from 'node:path';
      import semver from 'semver'; import {search} from 'skill:team-directory';
      const catalog=JSON.parse(await readFile(join(process.env.VELAROS_HOST_DIR,'index.json'),'utf8'));
      const guide=catalog.skills.find(skill=>skill.name==='guided-review');
      console.log(await readFile(join(guide.directory,guide.instructions),'utf8'));
      export default {fits:semver.satisfies('1.2.3','^1'),people:await search({query:'reviewer'}),count:catalog.skills.length};`,
        timeoutMs: 10000,
        input: undefined,
        modules: {},
        blobs: {},
        mode: 'execute',
        operations: { 'skill:team-directory': ['search'] },
        host: {
          sessionId: 'examples',
          executionId: 'examples',
          modules: {
            'skill:team-directory': {
              summary: provider.summary,
              declarations: provider.surface!.declarations,
            },
          },
        },
      },
      async (call) => {
        const value = await provider.operations.search!.run(call.input, {
          signal: new AbortController().signal,
          invocation: {
            id: 'lookup',
            operation: 'search',
            input: call.input,
            sessionId: 'examples',
            executionId: 'examples',
            binding: provider.binding,
            mode: 'execute',
          },
          recordEffect: () => {},
          recordDiagnostic: () => {},
          recordObservation: () => {},
          attach: () => {},
        })
        return { value }
      },
      () => {}
    )
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({
      fits: true,
      people: [{ name: 'Release Reviewer', email: 'reviewer@example.test' }],
      count: 3,
    })
    expect(result.process?.stdout).toContain('验收标准')
    await lease.release()
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose()))
    )
  }
})

test('INV-6 内置规范、示例和管理操作按需加载，校验只读，写入受宿主确认且通知订阅者', async () => {
  const f = await fixture()
  const lease = await f.registry.acquire()
  let allowed = false
  let notifications = 0
  const effects: string[] = []
  const release = f.registry.subscribe(() => {
    notifications++
  })
  const ctx: SkillsOperationContext = {
    registry: f.registry,
    lease,
    cwd: f.root,
    sourceScope: 'workspace',
    abortSignal: new AbortController().signal,
    authorize: async () => {
      if (!allowed) throw new Error('host denied')
    },
    recordEffect: (effect) => {
      effects.push(effect)
    },
  }
  const guide = await skillsOperations.guide(undefined, ctx)
  expect(guide.content).toContain('agentSkill')
  const example = await skillsOperations.guide({ topic: 'example' }, ctx)
  const directory = join(f.root, 'demo')
  await mkdir(directory)
  for (const [file, content] of Object.entries(example.files))
    await writeFile(join(directory, file), content)
  expect((await skillsOperations.validate({ directory: './demo' }, ctx)).name).toBe('guided-review')
  expect(await Bun.file(join(directory, 'package.json')).exists()).toBe(false)
  await expect(skillsOperations.install({ directory }, ctx)).rejects.toThrow('host denied')
  expect(await f.registry.list()).toEqual([])
  expect(notifications).toBe(0)
  allowed = true
  const installed = await skillsOperations.install({ directory }, ctx)
  expect(installed.available).toBe(false)
  expect(notifications).toBe(1)
  await expect(skillsOperations.load({ name: 'guided-review' }, ctx)).rejects.toThrow(
    '未被本轮选择'
  )
  const selected = await f.registry.acquire(await selectAll(f.registry))
  const loaded = await skillsOperations.load({ name: 'guided-review' }, { ...ctx, lease: selected })
  expect(loaded.instructions).toContain('基于证据的代码审查')
  expect(loaded.skill.available).toBe(true)
  const outside = await fixture()
  await symlink(outside.root, join(f.root, 'escape'))
  await expect(skillsOperations.validate({ directory: 'escape' }, ctx)).rejects.toThrow(
    '越过安装目录'
  )
  await skillsOperations.remove({ name: 'guided-review' }, ctx)
  expect(notifications).toBe(2)
  expect(effects).toContain('committed')
  release()
  await Promise.all([lease.release(), selected.release()])
})

test('INV-6 v1 安装索引迁移保留包内容，默认环境为空', async () => {
  const f = await fixture()
  const record = await f.registry.install(
    { directory: await source(f.root, 'legacy') },
    new AbortController().signal
  )
  await writeFile(
    join(f.store, 'index.json'),
    JSON.stringify({ version: 1, revision: 1, skills: [{ ...record, enabled: true, grants: [] }] })
  )
  expect(await f.registry.list()).toEqual([record])
  const empty = await f.registry.acquire()
  expect(empty.environment.skills).toEqual([])
  await empty.release()
})

test('INV-7 内置 Skill 与安装包共用选择和租约，JS/TS 包按需公开', async () => {
  const f = await fixture(undefined, true)
  const installed = await f.registry.list()
  expect(installed.map((item) => item.manifest.name).sort()).toEqual(
    Object.values(BuiltinSkillNames).sort()
  )
  expect(installed.every((item) => item.builtin)).toBe(true)
  const base = await f.registry.acquire()
  expect(base.environment.packages).toHaveLength(0)
  await base.release()
  const selected = skillComposition.select(installed, [], [BuiltinSkillNames.jsts])
  const lease = await f.registry.acquire(selected)
  expect(lease.skills[0]!.grants).toEqual(['project:language:jsts'])
  await f.registry.assertGranted(
    BuiltinSkillNames.jsts,
    lease.skills[0]!.generation,
    'project:language:jsts'
  )
  expect(lease.environment.packages.map((pkg) => pkg.name).sort()).toEqual([
    '@ast-grep/napi',
    '@playwright/test',
    'jsonc-parser',
    'prettier',
    'ts-morph',
  ])
  const runner = createNodeCodeRunner({
    ...(await nodeOptions(f.root)),
    runtime: lease.environment,
  })
  const result = await runner.run(
    {
      source: `
    import {Project} from 'ts-morph'; import {format} from 'prettier';
    import {modify,applyEdits} from 'jsonc-parser'; import {parse,Lang} from '@ast-grep/napi';
    import {test} from '@playwright/test';
    const project = new Project({useInMemoryFileSystem:true});
    const a=project.createSourceFile('/a.ts','export const answer = 42');
    const b=project.createSourceFile('/b.ts',"import {answer} from './a'; console.log(answer)");
    a.getVariableDeclarationOrThrow('answer').rename('total');
    const config='{// keep\\n"value":1}';
    export default { code:b.getFullText(), formatted:await format('const n:number=42',{parser:'typescript',semi:false}), config:applyEdits(config,modify(config,['value'],2,{})), matches:parse(Lang.TypeScript,'call(42)').root().findAll('call($A)').length, playwright:typeof test};
  `,
      modules: {},
      blobs: {},
      operations: {},
      input: null,
      mode: 'execute',
      timeoutMs: 10000,
    },
    async () => {
      throw new Error('unexpected call')
    },
    () => {}
  )
  expect(result.ok).toBe(true)
  expect(result.value).toMatchObject({
    code: "import {total} from './a'; console.log(total)",
    formatted: 'const n: number = 42\n',
    matches: 1,
    playwright: 'function',
  })
  expect(JSON.stringify(result.value)).toContain('keep')
  await lease.release()
})

test('INV-7 内置身份不能被安装替换或删除，缺失宿主绑定显式失败', async () => {
  const f = await fixture(undefined, true)
  const records = await f.registry.list()
  await expect(f.registry.remove(BuiltinSkillNames.browser)).rejects.toMatchObject({
    code: 'PERMISSION',
  })
  const directory = await source(f.root, BuiltinSkillNames.browser)
  await expect(
    f.registry.install({ directory }, new AbortController().signal)
  ).rejects.toMatchObject({ code: 'PERMISSION' })
  const lease = await f.registry.acquire(
    skillComposition.select(records, [], [BuiltinSkillNames.browser])
  )
  await expect(
    skillCapabilityModules.create({ registry: f.registry, lease, node: await nodeOptions(f.root) })
  ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  await lease.release()
  expect(
    skillComposition.select(records, [], [BuiltinSkillNames.browser, BuiltinSkillNames.browser])
  ).toHaveLength(1)
})

test('INV-7 多个 Skill 共用宿主绑定，一份撤销后另一份仍可授权', async () => {
  const f = await fixture()
  for (const name of ['one', 'two'])
    await f.registry.install(
      { directory: await source(f.root, name, '1.0.0', { hostCapabilities: ['velaros:browser'] }) },
      new AbortController().signal
    )
  let lastContext: OperationContext | undefined
  const records = await f.registry.list()
  const lease = await f.registry.acquire(skillComposition.select(records, [], ['one', 'two']))
  const modules = await skillCapabilityModules.create({
    registry: f.registry,
    lease,
    node: await nodeOptions(f.root),
    hostModules: {
      'velaros:browser': {
        binding: {
          moduleId: 'velaros:browser',
          instanceId: 'page',
          generation: 1,
          schemaRevision: '1',
        },
        summary: 'fixture',
        operations: {
          identity: {
            summary: 'fixture',
            input: { type: 'object' },
            output: { type: 'string' },
            effects: 'none',
            prepare: async (input) => input,
            observe: async () => 'bound-page',
            run: async (_input, context) => {
              lastContext = context
              return 'bound-page'
            },
          },
        },
      },
    },
  })
  expect(modules).toHaveLength(1)
  const journal = new Map<string, InvocationRecord>()
  const kernel = createOperationRuntime({
    modules,
    journal: {
      read: async (_session, id) => journal.get(id) ?? null,
      claim: async (prepared) => {
        const previous = journal.get(prepared.id)
        if (previous) return previous
        journal.set(prepared.id, { phase: 'reserved', prepared })
        return null
      },
      prepare: async (prepared) => {
        journal.set(prepared.id, { phase: 'prepared', prepared })
      },
      settle: async (receipt) => {
        journal.set(receipt.invocation.id, {
          phase: 'settled',
          prepared: receipt.invocation,
          receipt,
        })
      },
    },
  })
  const node = await nodeOptions(f.root)
  const invoke = (id: string) =>
    createKernelScriptSession({
      runtime: kernel,
      runner: createNodeCodeRunner({ ...node, runtime: lease.environment }),
      sessionId: 'shared',
      executionId: id,
      allowedModules: ['velaros:browser'],
    }).run({
      source: "import {identity} from 'velaros:browser';export default await identity({});",
    })
  try {
    const first = await invoke('first')
    expect(first.checked && first.rawValue).toBe('bound-page')
    await f.registry.remove('one')
    const second = await invoke('second')
    expect(second.checked && second.rawValue).toBe('bound-page')
    await f.registry.remove('two')
    const third = await invoke('third')
    expect(third.checked && third.result.failed?.code).toBe('PERMISSION')
    if (!lastContext) throw new Error('host context missing')
    await expect(
      modules[0]!.operations.identity!.observe!({}, { ...lastContext, recordEffect: () => {} })
    ).rejects.toMatchObject({ code: 'PERMISSION' })
    await expect(
      modules[0]!.operations.identity!.prepare!({}, { signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: 'PERMISSION' })
  } finally {
    await kernel.dispose()
  }
  await lease.release()
})

test('INV-7 未选择的专项包缺少依赖时基础环境仍可使用', async () => {
  const f = await fixture()
  const directory = await source(f.root, 'optional-language', '1.0.0', {
    packages: ['missing-dependency'],
  })
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  manifest.dependencies = { 'missing-dependency': '1.0.0' }
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
  const registry = createSkillRegistry({
    directory: f.store,
    nodeVersion: process.versions.node,
    builtins: [directory],
    lock: createExclusiveSqliteLock(() => new Database(join(f.store, 'lock.sqlite'))),
    installer: {
      install: async () => {
        throw new Error('unexpected install')
      },
    },
  })
  const base = await registry.acquire()
  expect(base.environment.packages).toHaveLength(0)
  await base.release()
  await expect(
    registry.acquire(skillComposition.select(await registry.list(), [], ['optional-language']))
  ).rejects.toMatchObject({ code: 'NOT_FOUND' })
})
