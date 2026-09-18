/**
 * 项目空间里的 `velar:sandbox`：共用的沙箱操作配上项目端口——源目录钳在项目内；落回不问人，镜像里跑命令的输出原样交回。
 * 宿主的沙箱是假的（记下每次调用），内核是真的。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { SandboxDiff, SandboxRecord } from '@velaros-ai/velar/sandbox/contracts'
import { ShellLimits } from '@velaros-ai/velar/shell/contracts'

import type { ProjectSandboxPort } from '../src/contract/requires'

import { failureOf, projectSpaceFixture } from './support/space'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-sandbox-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** 记下每次调用的假沙箱端口：镜像根在临时区，差量固定三列。 */
function fakePort(calls: Array<Record<string, unknown>>, overrides: Partial<SandboxDiff> = {}): ProjectSandboxPort {
  const record: SandboxRecord = {
    id: '20260915-183000-3fa2c1', root: '/tmp/velaros-sandbox/20260915-183000-3fa2c1/tree', source: root, createdAt: 1,
    network: false, ignored: 'link', fileCount: 3, bytes: 30, linkedDirectories: ['node_modules'], git: true,
  }
  const diff: SandboxDiff = {
    sandboxId: record.id, source: root, created: ['src/new.ts'], modified: ['src/a.ts'], deleted: ['old.txt'],
    gitChanged: false, textDiffs: [], omittedDiffs: 0, fingerprint: 'fp1', ...overrides,
  }
  return {
    createSandbox: async (options) => { calls.push({ create: options }); return { ...record, source: options?.source ?? root, network: !!options?.network, ignored: options?.ignored ?? 'link' } },
    runInSandbox: async (options) => { calls.push({ run: options }); return { command: options.command, cwd: record.root, exitCode: 0, signal: null, stdout: 'ran', stderr: '', durationMs: 1, timedOut: false, aborted: false, truncated: false, success: true } as never },
    diffSandbox: async (options) => { calls.push({ diff: options }); return diff },
    applySandbox: async (options) => { calls.push({ apply: options }); return { sandboxId: options.sandboxId, created: diff.created, modified: diff.modified, deleted: diff.deleted, skippedGit: false } },
    discardSandbox: async (sandboxId) => { calls.push({ discard: sandboxId }); return { sandboxId, removed: true } },
  }
}

/** 调到了宿主的哪几个动作。 */
const actions = (calls: Array<Record<string, unknown>>) => calls.map((entry) => Object.keys(entry)[0])

describe('项目空间的 velar:sandbox', () => {
  test('宿主没接沙箱时每个操作都明说用不了，并指路改文件、跑脚本的能力', async () => {
    const { call } = await projectSpaceFixture({ root })
    for (const [operation, input] of [['create', {}], ['run', { id: 'sb', command: 'ls' }], ['diff', { id: 'sb' }], ['discard', { id: 'sb' }]] as const) {
      const failure = await failureOf(call('sandbox', operation, input))
      expect(failure.code, operation).toBe('UNAVAILABLE')
      expect(failure.message, operation).toContain('velar:project')
      expect(failure.message, operation).toContain('velar:shell')
    }
  })

  test('create 只镜像项目或项目里的目录，出了项目就拒', async () => {
    const calls: Array<Record<string, unknown>> = []
    const { call } = await projectSpaceFixture({ root, sandbox: fakePort(calls) })
    const whole = await call('sandbox', 'create')
    expect(whole.source).toBe(root)
    expect(calls[0]).toEqual({ create: { source: root } })
    const sub = await call('sandbox', 'create', { source: 'packages/app', network: true, ignored: 'copy' })
    expect(sub).toMatchObject({ source: join(root, 'packages', 'app'), network: true, ignored: 'copy' })
    // 源出了项目（含经符号链接指到项目外）一律拒，一个镜像都不建。
    for (const source of ['../elsewhere', '/etc']) {
      const outside = await failureOf(call('sandbox', 'create', { source }))
      expect(outside.code, source).toBe('PERMISSION')
      expect(outside.message, source).toContain('项目之内')
    }
    // 名字以 .. 开头的目录在项目之内，照常接受。
    expect((await call('sandbox', 'create', { source: '..cache' })).source).toBe(join(root, '..cache'))
    expect(actions(calls)).toEqual(['create', 'create', 'create'])
  })

  test('run 把沙箱 id 与命令原样交给宿主，回执只留模型面的字段', async () => {
    const calls: Array<Record<string, unknown>> = []
    const { call } = await projectSpaceFixture({ root, sandbox: fakePort(calls) })
    const ran = await call('sandbox', 'run', { id: 'sb', command: 'bun scripts/migrate.ts', timeoutMs: 1000 })
    // 输出不折叠：交给宿主的是只守内存的那个上限。
    expect(calls).toEqual([{ run: { sandboxId: 'sb', command: 'bun scripts/migrate.ts', timeoutMs: 1000, maxOutputChars: ShellLimits.outputChars } }])
    expect(ran).toEqual({ id: 'sb', command: 'bun scripts/migrate.ts', exitCode: 0, stdout: 'ran', stderr: '', durationMs: 1, timedOut: false, truncated: false, success: true })
  })

  test('镜像里跑危险命令也先问用户，被拒就一个进程都不起', async () => {
    const calls: Array<Record<string, unknown>> = []
    const { call, confirmations } = await projectSpaceFixture({ root, sandbox: fakePort(calls), approve: false })
    const refused = await failureOf(call('sandbox', 'run', { id: 'sb', command: 'rm -rf build' }))
    expect(refused.code).toBe('PERMISSION')
    expect(confirmations).toHaveLength(1)
    expect(calls).toEqual([])
  })

  test('apply 不问人：要不附文本差量的完整三列核对点名的路径，再把差量指纹交给宿主落回', async () => {
    const calls: Array<Record<string, unknown>> = []
    const { call, confirmations } = await projectSpaceFixture({ root, sandbox: fakePort(calls, { modified: ['src/a.ts', 'src/api.generated.ts'] }), approve: false })
    const applied = await call('sandbox', 'apply', { id: 'sb', paths: ['src/a.ts', 'src/api.generated.ts'] })
    expect(applied.modified).toEqual(['src/a.ts', 'src/api.generated.ts'])
    expect(calls.at(-2)).toEqual({ diff: { sandboxId: 'sb', textDiffs: false } })
    expect(calls.at(-1)).toEqual({ apply: { sandboxId: 'sb', paths: ['src/a.ts', 'src/api.generated.ts'], fingerprint: 'fp1' } })
    // 审批端口一次都没被叫到（它会拒）：落回照常做完。
    expect(confirmations).toEqual([])
    const unknown = await failureOf(call('sandbox', 'apply', { id: 'sb', paths: ['nope.ts'] }))
    expect(unknown.code).toBe('VALIDATION')
    expect(unknown.message).toContain('nope.ts')
  })

  test('镜像里跑命令的输出原样交回：像密钥的片段也不遮', async () => {
    const secret = ['sk', 'live', '0123456789abcdefghij'].join('-')
    const port = fakePort([])
    port.runInSandbox = async () => ({ command: 'cat .env', cwd: '/tmp', exitCode: 0, stdout: `${secret}\n`, stderr: '', durationMs: 1, timedOut: false, truncated: false, success: true }) as never
    const { call } = await projectSpaceFixture({ root, sandbox: port })
    const ran = await call('sandbox', 'run', { id: 'sb', command: 'cat .env' })
    expect(ran.stdout).toBe(`${secret}\n`)
  })

  test('diff 与 discard 原样转给宿主', async () => {
    const calls: Array<Record<string, unknown>> = []
    const { call } = await projectSpaceFixture({ root, sandbox: fakePort(calls) })
    const changes = await call('sandbox', 'diff', { id: 'sb', paths: ['src/a.ts'] })
    expect(changes.deleted).toEqual(['old.txt'])
    const discarded = await call('sandbox', 'discard', { id: 'sb' })
    expect(discarded.removed).toBe(true)
    expect(calls).toEqual([{ diff: { sandboxId: 'sb', paths: ['src/a.ts'] } }, { discard: 'sb' }])
  })
})
