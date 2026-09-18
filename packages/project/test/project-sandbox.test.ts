/**
 * 项目空间里的 `velar:sandbox`：共用的沙箱操作配上项目端口——源目录钳在项目内、落回前先过项目的写授权与修改授权、
 * 镜像里跑命令的输出过项目的脱敏。宿主的沙箱是假的（记下每次调用），内核是真的（写授权、脱敏都用它）。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createSecretRedactionProvider } from '@velaros-ai/velar/project'
import type { SandboxDiff, SandboxRecord } from '@velaros-ai/velar/sandbox/contracts'

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
    truncated: false, gitChanged: false, textDiffs: [], omittedDiffs: 0, fingerprint: 'fp1', ...overrides,
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
    expect(calls).toEqual([{ run: { sandboxId: 'sb', command: 'bun scripts/migrate.ts', timeoutMs: 1000 } }])
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

  test('apply 先过项目的修改授权再问用户；任何一关被拒都抛错，一个文件都不落', async () => {
    const declined: Array<Record<string, unknown>> = []
    const notAuthorized = await projectSpaceFixture({ root, sandbox: fakePort(declined), prepareMutation: async () => ({ approved: false, message: '宿主不许落回' }) })
    const unauthorized = await failureOf(notAuthorized.call('sandbox', 'apply', { id: 'sb' }))
    expect(unauthorized).toEqual({ code: 'PERMISSION', message: '宿主不许落回' })
    // 修改授权排在问用户之前：被它拒了就不打扰用户。
    expect(notAuthorized.confirmations).toEqual([])
    const notConfirmed = await projectSpaceFixture({ root, sandbox: fakePort(declined), approve: false })
    expect((await failureOf(notConfirmed.call('sandbox', 'apply', { id: 'sb' }))).code).toBe('PERMISSION')
    expect(notConfirmed.mutations).toEqual([{ operation: '把演练沙箱的改动落回项目', cwd: undefined, paths: undefined }])
    expect(actions(declined)).not.toContain('apply')

    const calls: Array<Record<string, unknown>> = []
    const { call, confirmations } = await projectSpaceFixture({ root, sandbox: fakePort(calls) })
    const applied = await call('sandbox', 'apply', { id: 'sb', paths: ['src/a.ts'] })
    expect(applied.modified).toEqual(['src/a.ts'])
    // 落回前要的是不截断、不附文本差量的完整差量；确认之后把差量指纹一起交给宿主。
    expect(calls.at(-2)).toEqual({ diff: { sandboxId: 'sb', maxFiles: Number.MAX_SAFE_INTEGER, textDiffs: false } })
    expect(calls.at(-1)).toEqual({ apply: { sandboxId: 'sb', paths: ['src/a.ts'], fingerprint: 'fp1' } })
    // 确认卡片：落到当前项目，高风险、必须用户亲自点。
    expect(confirmations).toHaveLength(1)
    expect(confirmations[0]!.message).toContain('当前项目')
    expect(confirmations[0]!.message).toContain('覆盖：src/a.ts')
    expect(confirmations[0]!.options).toMatchObject({ approvalRisk: 'high', riskScope: 'project-sandbox:apply', requireManualApproval: true })
    const unknown = await failureOf(call('sandbox', 'apply', { id: 'sb', paths: ['nope.ts'] }))
    expect(unknown.code).toBe('VALIDATION')
    expect(unknown.message).toContain('nope.ts')
  })

  test('apply 遇到截断的差量在问任何人之前就拒；确认文案按完整的三列算', async () => {
    const calls: Array<Record<string, unknown>> = []
    const truncated = await projectSpaceFixture({ root, sandbox: fakePort(calls, { truncated: true }) })
    expect((await failureOf(truncated.call('sandbox', 'apply', { id: 'sb' }))).code).toBe('VALIDATION')
    expect(truncated.confirmations).toEqual([])
    expect(truncated.mutations).toEqual([])
    expect(actions(calls)).not.toContain('apply')

    const many = Array.from({ length: 2100 }, (_, index) => `gen/${index}.ts`)
    const full = await projectSpaceFixture({ root, sandbox: fakePort([], { created: many, modified: [], deleted: [] }) })
    await full.call('sandbox', 'apply', { id: 'sb' })
    expect(full.confirmations[0]!.message).toContain('新增 2100 个')
  })

  test('落回前每条路径都过项目的写授权：有不许写的就在问用户之前整批拒绝', async () => {
    const calls: Array<Record<string, unknown>> = []
    const blocked = await projectSpaceFixture({ root, sandbox: fakePort(calls, { modified: ['src/api.generated.ts'] }) })
    const refusal = await failureOf(blocked.call('sandbox', 'apply', { id: 'sb' }))
    expect(refusal.code).toBe('PERMISSION')
    expect(refusal.message).toContain('src/api.generated.ts（GENERATED_FILE）')
    expect(refusal.message).toContain('用 paths 点名要落的文件')
    // 问用户、问修改授权之前就拒绝，一个都不落。
    expect(blocked.confirmations).toEqual([])
    expect(blocked.mutations).toEqual([])
    expect(actions(calls)).not.toContain('apply')
    // 把不许写的那条从 paths 里去掉，剩下的照常落回。
    const allowed = await blocked.call('sandbox', 'apply', { id: 'sb', paths: ['src/new.ts'] })
    expect(allowed.created).toEqual(['src/new.ts'])
    expect(calls.at(-1)).toEqual({ apply: { sandboxId: 'sb', paths: ['src/new.ts'], fingerprint: 'fp1' } })
  })

  test('镜像里跑命令的输出和 velar:shell 一样过项目的脱敏', async () => {
    const secret = ['sk', 'live', '0123456789abcdefghij'].join('-')
    const port = fakePort([])
    port.runInSandbox = async () => ({ command: 'cat .env', cwd: '/tmp', exitCode: 0, stdout: `${secret}\n`, stderr: `api_key=${secret}`, durationMs: 1, timedOut: false, truncated: false, success: true }) as never
    const { call } = await projectSpaceFixture({ root, sandbox: port, providers: { secretRedaction: createSecretRedactionProvider() } })
    const ran = await call('sandbox', 'run', { id: 'sb', command: 'cat .env' })
    expect(ran.stdout).toBe('[REDACTED]\n')
    expect(ran.stderr).toContain('[REDACTED]')
    expect(JSON.stringify(ran)).not.toContain(secret)
  })

  test('diff 与 discard 原样转给宿主', async () => {
    const calls: Array<Record<string, unknown>> = []
    const { call } = await projectSpaceFixture({ root, sandbox: fakePort(calls) })
    const changes = await call('sandbox', 'diff', { id: 'sb', maxFiles: 5 })
    expect(changes.deleted).toEqual(['old.txt'])
    const discarded = await call('sandbox', 'discard', { id: 'sb' })
    expect(discarded.removed).toBe(true)
    expect(calls).toEqual([{ diff: { sandboxId: 'sb', maxFiles: 5 } }, { discard: 'sb' }])
  })
})
