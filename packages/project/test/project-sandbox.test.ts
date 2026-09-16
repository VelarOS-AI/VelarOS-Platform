import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { SandboxDiff, SandboxRecord } from '@velaros-ai/rehearsal-sandbox/contracts'

import type { ProjectSandboxPort, ProjectToolContext } from '../src/contract/requires'
import { projectTools } from '../src/impl/ProjectTools'

const root = '/projects/demo'

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
    runInSandbox: async (options) => { calls.push({ run: options }); return { command: options.command, cwd: record.root, exitCode: 0, signal: null, stdout: 'ran', stderr: '', durationMs: 1, timedOut: false, aborted: false, truncated: false, success: true, verification: { kind: 'unknown', status: 'passed', summary: '', exitCode: 0 } } as never },
    diffSandbox: async (options) => { calls.push({ diff: options }); return diff },
    applySandbox: async (options) => { calls.push({ apply: options }); return { sandboxId: options.sandboxId, created: diff.created, modified: diff.modified, deleted: diff.deleted, skippedGit: false } },
    discardSandbox: async (sandboxId) => { calls.push({ discard: sandboxId }); return { sandboxId, removed: true } },
  }
}

/** 工具上下文：授权与确认按给定方式回答，宿主端口可有可无；内核只提供落回的写治理与命令输出脱敏两件事。 */
function contextFor(options: { port?: ProjectSandboxPort; approved?: boolean; confirmed?: boolean; blockedPaths?: string[]; redact?: boolean }): ProjectToolContext {
  const blocked = new Set(options.blockedPaths ?? [])
  const project: Record<string, unknown> = {
    getRootPath: () => root,
    kernel: async () => ({
      authorizeWrites: async (paths: readonly string[]) =>
        paths.map((path) => (blocked.has(path) ? { path, allowed: false, reason: 'GENERATED_FILE', message: `${path} 是生成文件` } : { path, allowed: true })),
      redactText: async ({ content }: { content: string }) => (options.redact ? { content: content.replace(/sk-[a-z0-9-]+/gi, '[REDACTED]'), redacted: true } : { content, redacted: false }),
    }),
    prepareMutation: async () => ({ approved: options.approved !== false, message: options.approved === false ? 'fixture rejected' : '已授权' }),
    runCommand: async () => { throw new Error('not needed') },
    queryCode: async () => ({}),
  }
  if (options.port) project.sandbox = options.port
  return {
    abortSignal: new AbortController().signal,
    toolCallId: 'sandbox-1',
    project,
    approval: { awaitConfirmationDecision: async () => ({ approved: options.confirmed !== false, message: 'user said no' }) },
  } as unknown as ProjectToolContext
}

const tool = projectTools['project:sandbox']!
const call = (input: Record<string, unknown>, context: ProjectToolContext): Promise<unknown> => tool.execute(tool.schema.parse(input), context)

describe('project:sandbox', () => {
  test('is hidden when the host has no sandbox port, and refuses to run without one', async () => {
    expect(tool.hideWhenUnavailable).toBe(true)
    expect(tool.isAvailable?.(contextFor({}))).toBe(false)
    expect(tool.isAvailable?.(contextFor({ port: fakePort([]) }))).toBe(true)
    await expect(call({ action: 'create' }, contextFor({}))).rejects.toMatchObject({ reason: 'NOT_SUPPORTED' })
  })

  test('create mirrors the project or a directory inside it, never a path outside', async () => {
    const calls: Array<Record<string, unknown>> = []
    const context = contextFor({ port: fakePort(calls) })
    const whole = await call({ action: 'create' }, context) as { source: string; root: string; note: string }
    expect(whole.source).toBe(root)
    // 回执里的说明只说下一步；镜像根是模型碰不到的绝对路径，不再抄给它。
    expect(whole.note).toContain('接下来用 action=run')
    expect(whole.note).not.toContain(whole.root)
    const sub = await call({ action: 'create', source: 'packages/app', network: true, ignored: 'copy' }, context) as { source: string; network: boolean; ignored: string }
    expect(sub).toMatchObject({ source: join(root, 'packages', 'app'), network: true, ignored: 'copy' })
    // 源出了项目（含经符号链接指到项目外）按 PERMISSION_DENIED 拒绝；挂进内核后这个 reason 就是能力错误的码。
    await expect(call({ action: 'create', source: '../elsewhere' }, context)).rejects.toMatchObject({ reason: 'PERMISSION_DENIED' })
    await expect(call({ action: 'create', source: '/etc' }, context)).rejects.toMatchObject({ reason: 'PERMISSION_DENIED' })
    // 名字以 .. 开头的目录在项目之内，照常接受。
    const dotted = await call({ action: 'create', source: '..cache' }, context) as { source: string }
    expect(dotted.source).toBe(join(root, '..cache'))
    expect(calls.map((entry) => Object.keys(entry)[0])).toEqual(['create', 'create', 'create'])
  })

  test('run needs the sandbox id and a command, hands both to the host, and asks before dangerous commands', async () => {
    const calls: Array<Record<string, unknown>> = []
    const context = contextFor({ port: fakePort(calls), confirmed: false })
    // 缺字段由 schema 拦，不再等到执行阶段。
    expect(tool.schema.safeParse({ action: 'run', command: 'ls' }).success).toBe(false)
    expect(tool.schema.safeParse({ action: 'run', sandboxId: 'sb' }).success).toBe(false)
    const ran = await call({ action: 'run', sandboxId: 'sb', command: 'bun scripts/migrate.ts', timeoutMs: 1000 }, context) as { stdout: string }
    expect(ran.stdout).toBe('ran')
    expect(calls[0]).toEqual({ run: { sandboxId: 'sb', command: 'bun scripts/migrate.ts', timeoutMs: 1000, maxOutputChars: undefined } })
    const refused = await call({ action: 'run', sandboxId: 'sb', command: 'rm -rf build' }, context) as { skipped: boolean }
    expect(refused.skipped).toBe(true)
    expect(calls).toHaveLength(1)
  })

  test('apply asks the project mutation gate and the user before writing back; either refusal writes nothing', async () => {
    const declined: Array<Record<string, unknown>> = []
    const notAuthorized = await call({ action: 'apply', sandboxId: 'sb' }, contextFor({ port: fakePort(declined), approved: false })) as { skipped: boolean }
    expect(notAuthorized.skipped).toBe(true)
    const notConfirmed = await call({ action: 'apply', sandboxId: 'sb' }, contextFor({ port: fakePort(declined), confirmed: false })) as { skipped: boolean; message: string }
    expect(notConfirmed).toMatchObject({ skipped: true, message: 'user said no' })
    expect(declined.some((entry) => 'apply' in entry)).toBe(false)

    const calls: Array<Record<string, unknown>> = []
    const applied = await call({ action: 'apply', sandboxId: 'sb', paths: ['src/a.ts'] }, contextFor({ port: fakePort(calls) })) as { modified: string[] }
    expect(applied.modified).toEqual(['src/a.ts'])
    // 落回前要的是不截断、不附文本差量的完整差量；确认之后把差量指纹一起交给宿主。
    expect(calls.at(-2)).toEqual({ diff: { sandboxId: 'sb', maxFiles: Number.MAX_SAFE_INTEGER, textDiffs: false } })
    expect(calls.at(-1)).toEqual({ apply: { sandboxId: 'sb', paths: ['src/a.ts'], fingerprint: 'fp1' } })
    await expect(call({ action: 'apply', sandboxId: 'sb', paths: ['nope.ts'] }, contextFor({ port: fakePort([]) }))).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  test('apply refuses a truncated diff before asking anyone, and confirms the full lists', async () => {
    const calls: Array<Record<string, unknown>> = []
    const asked: string[] = []
    const context = contextFor({ port: fakePort(calls, { truncated: true }) })
    const approval = context.approval as unknown as { awaitConfirmationDecision: (message: string) => Promise<unknown> }
    const original = approval.awaitConfirmationDecision
    approval.awaitConfirmationDecision = async (message: string) => { asked.push(message); return original(message) }
    await expect(call({ action: 'apply', sandboxId: 'sb' }, context)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(asked).toEqual([])
    expect(calls.some((entry) => 'apply' in entry)).toBe(false)

    const many = Array.from({ length: 2100 }, (_, index) => `gen/${index}.ts`)
    const full: string[] = []
    const fullContext = contextFor({ port: fakePort([], { created: many, modified: [], deleted: [] }) })
    const fullApproval = fullContext.approval as unknown as { awaitConfirmationDecision: (message: string) => Promise<unknown> }
    const fullOriginal = fullApproval.awaitConfirmationDecision
    fullApproval.awaitConfirmationDecision = async (message: string) => { full.push(message); return fullOriginal(message) }
    await call({ action: 'apply', sandboxId: 'sb' }, fullContext)
    expect(full[0]).toContain('新增 2100 个')
  })

  test('落回前每条路径都过项目的写授权：有不许写的就在问用户之前整批拒绝', async () => {
    const calls: Array<Record<string, unknown>> = []
    const asked: string[] = []
    const context = contextFor({ port: fakePort(calls), blockedPaths: ['src/a.ts'] })
    const approval = context.approval as unknown as { awaitConfirmationDecision: (message: string) => Promise<unknown> }
    const original = approval.awaitConfirmationDecision
    approval.awaitConfirmationDecision = async (message: string) => { asked.push(message); return original(message) }

    const refusal = await call({ action: 'apply', sandboxId: 'sb' }, context).catch((error: { reason: string; message: string }) => error)
    expect(refusal).toMatchObject({ reason: 'PERMISSION_DENIED' })
    expect((refusal as { message: string }).message).toContain('src/a.ts（GENERATED_FILE）')
    expect((refusal as { suggestedNextAction: string }).suggestedNextAction).toContain('用 paths 点名要落的文件')
    // 问用户之前就拒绝，被拒的一个都不落。
    expect(asked).toEqual([])
    expect(calls.some((entry) => 'apply' in entry)).toBe(false)

    // 把不许写的那条从 paths 里去掉，剩下的照常落回。
    const allowed = await call({ action: 'apply', sandboxId: 'sb', paths: ['src/new.ts'] }, contextFor({ port: fakePort(calls), blockedPaths: ['src/a.ts'] })) as { created: string[] }
    expect(allowed.created).toEqual(['src/new.ts'])
  })

  test('沙箱里跑命令的输出和 project:run 一样过脱敏', async () => {
    const calls: Array<Record<string, unknown>> = []
    const context = contextFor({ port: fakePort(calls, {}), redact: true })
    const port = context.project.sandbox as unknown as { runInSandbox: (options: unknown) => Promise<unknown> }
    port.runInSandbox = async () => ({ command: 'cat .env', cwd: '/tmp', exitCode: 0, stdout: 'TOKEN=sk-live-abcdefghijkl\n', stderr: 'sk-live-abcdefghijkl', success: true })
    const ran = await call({ action: 'run', sandboxId: 'sb', command: 'cat .env' }, context) as { stdout: string; stderr: string }
    expect(ran.stdout).toBe('TOKEN=[REDACTED]\n')
    expect(ran.stderr).toBe('[REDACTED]')
  })

  test('diff and discard pass straight through', async () => {
    const calls: Array<Record<string, unknown>> = []
    const context = contextFor({ port: fakePort(calls) })
    const changes = await call({ action: 'diff', sandboxId: 'sb', maxFiles: 5 }, context) as { deleted: string[] }
    expect(changes.deleted).toEqual(['old.txt'])
    const discarded = await call({ action: 'discard', sandboxId: 'sb' }, context) as { removed: boolean }
    expect(discarded.removed).toBe(true)
    expect(calls).toEqual([{ diff: { sandboxId: 'sb', maxFiles: 5 } }, { discard: 'sb' }])
  })
})
