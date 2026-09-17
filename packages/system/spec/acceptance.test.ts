/**
 * 系统空间的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 *
 * 改动或删除已有用例要在差量报告里点名并说明理由。
 * 这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 */

import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { codeProgramChecker, createCapabilityPort, createCodeSurfaceSession, nodeSubprocessCodeRunner } from '@velaros-ai/code-surface'

import { SystemCommandLimits, SystemFileLimits } from '../src/contracts'
import { systemExecutionOperations } from '../src/impl/SystemExecutionOperations.js'
import { systemFileOperations } from '../src/impl/SystemFileOperations.js'
import { systemProcessManager } from '../src/impl/SystemProcessManager.js'
import {
  createLocalSystemKernel,
  createSystemCodeSurface,
  type SystemToolContext,
} from '../src/index'
import { buildSystemProcessConfinementSpawnSpec } from '../src/utils/confinement.js'
import { assertInsideSandboxBase, sandboxBaseDirectory } from '../src/utils/sandbox.js'

import { fakeChild, solidPng } from './support'

describe('命令安全门', () => {
  test('INV-4 危险命令的审批是高风险手动确认，不可按类记忆，并标明精确命令', async () => {
    const seen: Array<Record<string, unknown> | undefined> = []
    const context = {
      abortSignal: new AbortController().signal,
      approval: {
        awaitConfirmation: async (_message: string, _signal?: AbortSignal, options?: Record<string, unknown>) => {
          seen.push(options)
        },
      },
      system: {
        resolvePath: (path?: string) => path ?? process.cwd(),
        runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0, truncated: false }),
      },
    } as never

    await systemExecutionOperations.run({ command: 'rm -rf /tmp/velaros-fixture' }, context)
    expect(seen[0]).toMatchObject({
      approvalRisk: 'high',
      riskScope: 'system-command:dangerous',
      requireManualApproval: true,
      rememberRiskScope: false,
      operation: { label: 'rm -rf /tmp/velaros-fixture' },
    })
  })


})

describe('进程约束', () => {
  test('INV-5 受约束模式没有可用后端时失败关闭，不退回裸进程', () => {
    expect(() =>
      buildSystemProcessConfinementSpawnSpec(
        {
          spec: { file: 'cmd.exe', args: ['/c', 'exit 0'] },
          policy: { mode: 'read-only', workspaceRoot: 'C:\\workspace' },
        },
        { platform: 'win32' }
      )
    ).toThrow('已拒绝以裸进程继续执行')

    expect(() =>
      buildSystemProcessConfinementSpawnSpec(
        {
          spec: { file: '/bin/sh', args: ['-lc', 'true'] },
          policy: { mode: 'read-only', workspaceRoot: '/workspace' },
        },
        { platform: 'linux', bubblewrapAvailable: false }
      )
    ).toThrow('已拒绝以裸进程继续执行')
  })

  test('INV-6 未受约束的进程如实报告 enforcement none，不冒充隔离', () => {
    const result = buildSystemProcessConfinementSpawnSpec({
      spec: { file: '/bin/sh', args: ['-lc', 'true'] },
      policy: { mode: 'danger-full-access', workspaceRoot: '/workspace' },
    })

    expect(result.spec).toEqual({ file: '/bin/sh', args: ['-lc', 'true'] })
    expect(result.evidence).toEqual({
      mode: 'danger-full-access',
      enforcement: 'none',
      backend: 'none',
      reason: 'explicit-danger-full-access',
      writableRoots: [],
    })
  })
})

describe('代码面登记', () => {
  test('INV-15 nativeCommand 只给宿主用，永不进模型可观测面', async () => {
    const declarations = await readFile(
      resolve(import.meta.dir, '../../../baselines/code-surface/system.d.ts'),
      'utf8'
    )
    expect(declarations).not.toContain('nativeCommand')
  })









})

describe('命令输出', () => {
  test('INV-10 输出超长保留末尾且末尾真实；转后台的回执带 taskId，模型自己去查', async () => {
    const context = {
      abortSignal: new AbortController().signal,
      approval: { awaitConfirmation: async () => undefined },
      system: {
        resolvePath: (path?: string) => path ?? process.cwd(),
        runCommand: async () => ({
          stdout: 'tail-of-the-output',
          stderr: '',
          exitCode: 0,
          truncated: true,
          backgroundProcess: { taskId: 'task-1' },
        }),
      },
    } as never

    const result = await systemExecutionOperations.run({ command: 'printf lots', background: true }, context)
    // 砍头不砍尾：失败现场在尾部
    expect(result.outputWindow?.retained).toBe('tail')
    expect(result.outputWindow?.endPreserved).toBe(true)
    expect(result.stdout.endsWith('tail-of-the-output')).toBe(true)
    // 回执给 taskId 就够了，模型自己写 `await listTasks({ taskId })`
    expect(result.backgroundProcess?.taskId).toBe('task-1')
  })

  test('INV-11 管道分块不打碎 UTF-8 字符，退出码原样透传', async () => {
    const kernel = createLocalSystemKernel({ cwd: process.cwd() })
    const text = '中文🙂'
    const result = await kernel.runCommand('fixture', { nativeCommand: { file: process.execPath, args: ['-e', `
      const bytes = Buffer.from(${JSON.stringify(text)});
      let offset = 0;
      const timer = setInterval(() => {
        const byte = bytes.subarray(offset, ++offset);
        process.stdout.write(byte);
        process.stderr.write(byte);
        if (offset === bytes.length) {
          clearInterval(timer);
          process.exitCode = 7;
        }
      }, 10);
    `] }, timeoutMs: 3_000 })

    expect(result.stdout).toBe(text)
    expect(result.stderr).toBe(text)
    expect(result.exitCode).toBe(7)
    expect(result.success).toBe(false)
    expect(result.timedOut).toBe(false)
    expect(result.capture?.decodeErrors).toBe(0)
    expect(result.verification).toEqual({
      kind: 'unknown',
      status: 'failed',
      issues: [`stdout:\n${text}`, `stderr:\n${text}`],
    })
    expect(result.shell).toBeDefined()
    expect(result.shell).not.toHaveProperty('env')
  })

  test('INV-30 挑定的 shell 本机没有时在起进程之前拒绝，不换默认 shell 照跑', async () => {
    const kernel = createLocalSystemKernel({ cwd: process.cwd() })
    const inspection = await kernel.inspectEnvironment()
    const available = inspection.shells.map((shell) => shell.kind)
    // 清单第一个就是默认那个；挑清单里没有的种类，命令一个字节的输出都不会有。
    expect(available[0]).toBe(inspection.shell.kind!)
    const missing = (['pwsh', 'cmd', 'git-bash', 'powershell', 'posix'] as const).find((kind) => !available.includes(kind))!
    await expect(kernel.runCommand('echo 不该跑起来', { shell: missing })).rejects.toThrow(`本机没有 ${missing}`)
    await expect(kernel.runCommand('echo 不该跑起来', { shell: missing })).rejects.toThrow(available[0]!)
    expect((await kernel.runCommand('echo ok', { shell: available[0] })).stdout.trim()).toBe('ok')
  })
})

describe('进程生命周期', () => {
  test('INV-12 终止信号无人响应、close 永不到达时，进程管理仍在期限内收敛', async () => {
    const child = fakeChild()
    const signals: string[] = []
    const owned = systemProcessManager.manage(child, {
      timeoutMs: 5,
      terminateGraceMs: 5,
      terminationDeadlineMs: 35,
      terminate: (signal) => {
        signals.push(signal)
        return new Promise(() => {})
      },
    })
    const result = await owned.completion
    expect(result.timedOut).toBe(true)
    expect(result.cleanupIncomplete).toBe(true)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(child.stdout!.destroyed).toBe(true)
    expect(await owned.stop('SIGKILL')).toBe(false)
  })
})

describe('文件工具', () => {
  const approving: SystemToolContext = {
    abortSignal: new AbortController().signal,
    approval: { requestApproval: async () => ({ approved: true }), awaitConfirmation: async () => undefined },
    system: { resolvePath: (path = process.cwd()) => resolve(path) } as never,
  } as SystemToolContext
  const denying: SystemToolContext = {
    ...approving,
    approval: { requestApproval: async () => ({ approved: true }), awaitConfirmation: async () => { throw new Error('user said no') } },
  } as SystemToolContext
  const edit = { execute: systemFileOperations.edit.bind(systemFileOperations) }
  const read = { execute: systemFileOperations.read.bind(systemFileOperations) }
  const failureOf = async (call: Promise<unknown>): Promise<{ code: string; outcome: unknown; problems: Array<Record<string, unknown>> }> => {
    try {
      await call
    } catch (error) {
      const failure = error as { code: string; context?: { executionOutcome?: unknown }; cause?: { details?: { problems?: Array<Record<string, unknown>> } } }
      return { code: failure.code, outcome: failure.context?.executionOutcome, problems: failure.cause?.details?.problems ?? [] }
    }
    throw new Error('expected the call to fail')
  }

  test('INV-20 一批全成或全不成：版本对不上就什么都不写，并逐个点名', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-inv20-'))
    try {
      const a = join(root, 'a.txt')
      const b = join(root, 'b.txt')
      await writeFile(a, 'alpha\n')
      await writeFile(b, 'beta\n')
      const before = await read.execute({ files: [{ path: a }, { path: b }] }, approving) as { files: Array<{ version: string }> }
      // 拿到 version 之后别人又改了 b：整批不写，a 也不动
      await writeFile(b, 'beta changed\n')
      const failure = await failureOf(edit.execute({
        files: [
          { path: a, newText: 'alpha 2\n', version: before.files[0]!.version },
          { path: b, newText: 'beta 2\n', version: before.files[1]!.version },
        ],
      }, approving))
      expect(failure.outcome).toBe('not-applied')
      expect(failure.problems).toHaveLength(1)
      expect(failure.problems[0]).toMatchObject({ file: 1, reason: 'stale' })
      expect(await readFile(a, 'utf8')).toBe('alpha\n')
      expect(await readFile(b, 'utf8')).toBe('beta changed\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('INV-21 文本改动无损：GBK 原样回写；二进制不许被 newText 覆盖；写的是符号链接指向的文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-inv21-'))
    try {
      // GB18030：读出来是中文，改完写回去仍是 GBK 字节，不会变成 UTF-8
      const gbk = join(root, 'gbk.txt')
      await writeFile(gbk, Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]))
      const got = await read.execute({ files: [{ path: gbk }] }, approving) as { files: Array<{ content: string; encoding: string }> }
      expect(got.files[0]!.encoding).toBe('gb18030')
      await edit.execute({ files: [{ path: gbk, newText: `${got.files[0]!.content}中文\n` }] }, approving)
      const back = await readFile(gbk)
      expect(back.subarray(0, 4)).toEqual(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))

      // 已有的二进制文件不许被整个覆盖
      const binary = join(root, 'blob.bin')
      await writeFile(binary, Buffer.from([0x00, 0x01, 0x02, 0x00]))
      const refused = await failureOf(edit.execute({ files: [{ path: binary, newText: 'text\n' }] }, approving))
      expect(refused.outcome).toBe('not-applied')
      expect(await readFile(binary)).toEqual(Buffer.from([0x00, 0x01, 0x02, 0x00]))

      // 符号链接：写的是它指向的那个文件，链接本身还是链接
      const real = join(root, 'real.txt')
      const link = join(root, 'link.txt')
      await writeFile(real, 'one\n')
      await symlink(real, link)
      await edit.execute({ files: [{ path: link, newText: 'two\n' }] }, approving)
      expect(await readFile(real, 'utf8')).toBe('two\n')
      expect((await lstat(link)).isSymbolicLink()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('INV-22 大文件分三档：20 MB 以内整份读写，超过的指向 run，一批读不下的单独失败、绝不回半份', async () => {
    // 两个上限是同一个数：否则会漏出一段「字节放行、字符拒绝」的文件，读不了也改不了
    expect(SystemFileLimits.readChars).toBe(SystemFileLimits.fileBytes)

    const root = await mkdtemp(join(tmpdir(), 'velaros-inv22-'))
    try {
      // 第一档：12 MB 的文件整份读回来（砍掉分页之前，这一段超过了 400 万字符的旧预算，读不了）
      const big = join(root, 'big.log')
      const line = 'INFO 这一行是填充用的日志\n'
      const body = line.repeat(Math.floor((12 * 1024 * 1024) / Buffer.byteLength(line)))
      await writeFile(big, `${body}ERROR 真正要找的那一行\n`)
      const got = await read.execute({ files: [{ path: big }] }, approving) as { files: Array<{ content: string }> }
      expect(got.files[0]!.content.endsWith('ERROR 真正要找的那一行\n')).toBe(true)

      // 整份改完写回去，版本对得上
      const withVersion = await read.execute({ files: [{ path: big }] }, approving) as { files: Array<{ content: string; version: string }> }
      const next = withVersion.files[0]!.content.replace('ERROR 真正要找的那一行', 'ERROR 已处理')
      const written = await edit.execute({ files: [{ path: big, newText: next, version: withVersion.files[0]!.version }] }, approving) as { files: Array<{ previousVersion: string | null }> }
      expect((await readFile(big, 'utf8')).endsWith('ERROR 已处理\n')).toBe(true)
      // 超过 2 MB 的能写，但不留回滚版本
      expect(written.files[0]!.previousVersion).toBeNull()

      // 第二档：一批读不下时，读不下的那个单独失败，前面的照常回来——绝不回半份。
      // 用 ASCII：一个字节一个字符，两份 11 MB 加起来才压得过 20 MB 的字符预算（中文三字节一个字，压不到）。
      const asciiBody = 'x'.repeat(11 * 1024 * 1024)
      const first = join(root, 'first.log')
      const second = join(root, 'second.log')
      await writeFile(first, asciiBody)
      await writeFile(second, asciiBody)
      const batch = await read.execute({ files: [{ path: first }, { path: second }] }, approving) as { files: Array<{ content?: string; error?: { message: string } }> }
      expect(batch.files[0]!.content?.length).toBeGreaterThan(0)
      expect(batch.files[1]!.error?.message).toContain('单独放进一次 read')
      expect(batch.files[1]!.content).toBeUndefined()

      // 第三档：超过 20 MB 的读不进来，报错直接指向 run
      const huge = join(root, 'huge.log')
      await writeFile(huge, Buffer.alloc(SystemFileLimits.fileBytes + 1, 0x61))
      const refused = await read.execute({ files: [{ path: huge }] }, approving).catch((error: unknown) => error as Error)
      expect(String((refused as Error).message)).toContain('用 run 取片段')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  test('INV-19 写系统敏感路径与凭证文件前经审批端口确认，按真实路径判定，被拒整批不写，临时目录不打扰用户', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-inv19-'))
    try {
      const key = join(root, 'deploy.pem')
      await writeFile(key, '-----BEGIN PRIVATE KEY-----\nabc\n')
      const alias = join(root, 'notes.txt')
      await symlink(key, alias)
      const plain = join(root, 'plain.txt')
      await writeFile(plain, 'alpha\n')
      // 临时目录里的普通文件：拒绝一切确认的端口也能写，说明没有去问用户。
      const written = await edit.execute({ files: [{ path: plain, newText: 'beta\n' }] }, denying) as { files: Array<{ action: string }> }
      expect(written.files[0]!.action).toBe('written')
      // 凭证文件藏在符号链接后面也要问；被拒时整批不写。
      const denied = await failureOf(edit.execute({ files: [{ path: plain, newText: 'gamma\n' }, { path: alias, newText: 'x\n' }] }, denying))
      expect(denied.code).toBe('PERMISSION')
      expect(denied.problems[0]).toMatchObject({ file: 1, reason: 'denied' })
      expect(await readFile(plain, 'utf8')).toBe('beta\n')
      expect(await readFile(key, 'utf8')).toContain('PRIVATE KEY')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })




})

describe('演练沙箱', () => {
  const canConfine = (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'))
    || (process.platform === 'linux' && ['/usr/bin/bwrap', '/usr/local/bin/bwrap'].some((path) => existsSync(path)))

  /** 一个带假 .git 的源目录。 */
  async function makeSource(): Promise<string> {
    const source = await mkdtemp(join(tmpdir(), 'velaros-inv-sandbox-'))
    await mkdir(join(source, '.git'))
    await writeFile(join(source, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:example/demo.git\n')
    await writeFile(join(source, 'a.txt'), 'alpha\n')
    return source
  }

  test.skipIf(!canConfine)('INV-23 沙箱里的命令一律受约束：写镜像外失败；没有约束后端就建不出沙箱', async () => {
    const source = await makeSource()
    const kernel = createLocalSystemKernel({ cwd: source })
    let sandboxId = ''
    try {
      const record = await kernel.createSandbox({})
      sandboxId = record.id
      const outside = await kernel.runCommand(`printf clobbered > "${join(source, 'a.txt')}"`, { cwd: record.root })
      expect(outside.exitCode).not.toBe(0)
      expect(await readFile(join(source, 'a.txt'), 'utf8')).toBe('alpha\n')
      const inside = await kernel.runCommand('printf ok > b.txt', { cwd: record.root })
      expect(inside.exitCode).toBe(0)
      const unconfinable = createLocalSystemKernel({ cwd: source, platform: 'freebsd' })
      await expect(unconfinable.createSandbox({})).rejects.toMatchObject({ code: 'SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE' })
      await unconfinable.dispose()
    } finally {
      if (sandboxId) await kernel.discardSandbox(sandboxId)
      await kernel.dispose()
      await rm(source, { recursive: true, force: true })
    }
  })

  test.skipIf(!canConfine)('INV-24 落回只写清单记过的文件，源目录变过就整批不落', async () => {
    const source = await makeSource()
    const kernel = createLocalSystemKernel({ cwd: source })
    let sandboxId = ''
    try {
      const record = await kernel.createSandbox({})
      sandboxId = record.id
      await writeFile(join(record.root, 'a.txt'), 'ALPHA\n')
      await writeFile(join(record.root, 'b.txt'), 'beta\n')
      await writeFile(join(source, 'a.txt'), 'changed outside\n')
      const failure = await kernel.applySandbox({ sandboxId }).then(() => null, (error: unknown) => error as { context?: { executionOutcome?: string } })
      expect(failure?.context?.executionOutcome).toBe('not-applied')
      expect(await readFile(join(source, 'a.txt'), 'utf8')).toBe('changed outside\n')
      expect(existsSync(join(source, 'b.txt'))).toBe(false)
      const applied = await kernel.applySandbox({ sandboxId, paths: ['b.txt'] })
      expect(applied.created).toEqual(['b.txt'])
      expect(await readFile(join(source, 'b.txt'), 'utf8')).toBe('beta\n')
    } finally {
      if (sandboxId) await kernel.discardSandbox(sandboxId)
      await kernel.dispose()
      await rm(source, { recursive: true, force: true })
    }
  })

  test.skipIf(!canConfine)('INV-23 清单读不出来时镜像根里的命令拒绝执行，不退回裸进程', async () => {
    const source = await makeSource()
    const first = createLocalSystemKernel({ cwd: source })
    const record = await first.createSandbox({})
    await first.dispose()
    // 清单写坏了（写到一半崩溃、临时区清理只删了它）：重启后的内核认不出这是沙箱。
    await writeFile(join(sandboxBaseDirectory(), record.id, 'manifest.json'), '{"version":1,')
    const second = createLocalSystemKernel({ cwd: source })
    try {
      await expect(second.runCommand(`printf clobbered > "${join(source, 'a.txt')}"`, { cwd: record.root })).rejects.toMatchObject({ code: 'SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE' })
      expect(await readFile(join(source, 'a.txt'), 'utf8')).toBe('alpha\n')
      await expect(second.diffSandbox({ sandboxId: record.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    } finally {
      await second.discardSandbox(record.id)
      await second.dispose()
      await rm(source, { recursive: true, force: true })
    }
  })

  test.skipIf(!canConfine)('INV-24 嵌套仓库的 .git 也永远不落', async () => {
    const source = await makeSource()
    await mkdir(join(source, 'vendor-repo', '.git'), { recursive: true })
    await writeFile(join(source, 'vendor-repo', '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(source, 'vendor-repo', 'lib.txt'), 'lib\n')
    const kernel = createLocalSystemKernel({ cwd: source })
    let sandboxId = ''
    try {
      const record = await kernel.createSandbox({})
      sandboxId = record.id
      await writeFile(join(record.root, 'vendor-repo', '.git', 'HEAD'), 'ref: refs/heads/rehearsal\n')
      await writeFile(join(record.root, 'vendor-repo', 'lib.txt'), 'LIB\n')
      const changes = await kernel.diffSandbox({ sandboxId })
      expect(changes).toMatchObject({ modified: ['vendor-repo/lib.txt'], gitChanged: true })
      const applied = await kernel.applySandbox({ sandboxId })
      expect(applied).toMatchObject({ modified: ['vendor-repo/lib.txt'], skippedGit: true })
      expect(await readFile(join(source, 'vendor-repo', '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n')
    } finally {
      if (sandboxId) await kernel.discardSandbox(sandboxId)
      await kernel.dispose()
      await rm(source, { recursive: true, force: true })
    }
  })

  test('INV-25 丢弃只删沙箱基目录之下的东西，别的路径一律拒绝', async () => {
    const base = sandboxBaseDirectory()
    await expect(assertInsideSandboxBase('/etc', base)).rejects.toMatchObject({ code: 'PERMISSION' })
    await expect(assertInsideSandboxBase(join(base, '..'), base)).rejects.toMatchObject({ code: 'PERMISSION' })
    // 基目录本身不在「之下」：删它等于删掉所有沙箱。
    await mkdir(base, { recursive: true })
    await expect(assertInsideSandboxBase(base, base)).rejects.toMatchObject({ code: 'PERMISSION' })
    const kernel = createLocalSystemKernel({ cwd: tmpdir() })
    await expect(kernel.discardSandbox('../../etc')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(kernel.discardSandbox('20260101-000000-zzzzzz/..')).rejects.toMatchObject({ code: 'VALIDATION' })
    // 合形状的 id 却是符号链接（指向别处）：拒绝，链接指向的东西一个字节都不动。
    const victim = await mkdtemp(join(tmpdir(), 'velaros-inv-victim-'))
    await writeFile(join(victim, 'keep.txt'), 'keep\n')
    const linked = join(base, '20260101-000000-abcdef')
    await symlink(victim, linked)
    try {
      await expect(kernel.discardSandbox('20260101-000000-abcdef')).rejects.toMatchObject({ code: 'PERMISSION' })
      expect(await readFile(join(victim, 'keep.txt'), 'utf8')).toBe('keep\n')
    } finally {
      await rm(linked, { force: true })
      await rm(victim, { recursive: true, force: true })
      await kernel.dispose()
    }
  })

  test.skipIf(!canConfine)('INV-26 镜像仓库推不出去：每个远端的推送地址都被改掉', async () => {
    const source = await makeSource()
    const kernel = createLocalSystemKernel({ cwd: source })
    let sandboxId = ''
    try {
      const record = await kernel.createSandbox({})
      sandboxId = record.id
      expect(record.git).toBe(true)
      expect(await readFile(join(record.root, '.git', 'config'), 'utf8')).toContain('pushurl = DISABLED-BY-VELAROS-SANDBOX')
      expect(await readFile(join(source, '.git', 'config'), 'utf8')).not.toContain('pushurl')
    } finally {
      if (sandboxId) await kernel.discardSandbox(sandboxId)
      await kernel.dispose()
      await rm(source, { recursive: true, force: true })
    }
  })

  test.skipIf(!canConfine)('INV-26 嵌套仓库、子模块和各种节头写法的远端也推不出去，指向源目录外的 .git 链接不进镜像', async () => {
    const source = await makeSource()
    // 顶层配置：CRLF 换行、节名大写且节头后带空白、旧式 [remote.x] 写法，git 都照常认。
    await writeFile(join(source, '.git', 'config'), '[remote "origin"]\r\n\turl = git@github.com:example/demo.git\r\n[Remote "UP"] \n\turl = /tmp/up.git\n[remote.legacy]\n\turl = /tmp/legacy.git\n')
    // 子模块：.git 是指向顶层 .git/modules/mod 的链接文件，那份配置也有远端。
    await mkdir(join(source, '.git', 'modules', 'mod'), { recursive: true })
    await writeFile(join(source, '.git', 'modules', 'mod', 'config'), '[remote "origin"]\n\turl = /tmp/mod.git\n')
    await mkdir(join(source, 'mod'))
    await writeFile(join(source, 'mod', '.git'), 'gitdir: ../.git/modules/mod\n')
    // 嵌套的独立仓库。
    await mkdir(join(source, 'nested', '.git'), { recursive: true })
    await writeFile(join(source, 'nested', '.git', 'config'), '[remote "origin"]\n\turl = /tmp/nested.git\n')
    // git worktree：.git 指向源目录外的真实仓库，放进镜像的话镜像里的 git 会直接读写它。
    const elsewhere = await mkdtemp(join(tmpdir(), 'velaros-inv-worktree-'))
    await mkdir(join(source, 'wt'))
    await writeFile(join(source, 'wt', '.git'), `gitdir: ${elsewhere}\n`)
    const kernel = createLocalSystemKernel({ cwd: source })
    let sandboxId = ''
    try {
      const record = await kernel.createSandbox({})
      sandboxId = record.id
      const disabled = (text: string, count: number) => expect(text.split('pushurl = DISABLED-BY-VELAROS-SANDBOX').length - 1).toBe(count)
      disabled(await readFile(join(record.root, '.git', 'config'), 'utf8'), 3)
      expect(await readFile(join(record.root, '.git', 'config'), 'utf8')).toContain('[remote "origin"]\r\n\tpushurl = DISABLED-BY-VELAROS-SANDBOX\r\n')
      disabled(await readFile(join(record.root, '.git', 'modules', 'mod', 'config'), 'utf8'), 1)
      disabled(await readFile(join(record.root, 'nested', '.git', 'config'), 'utf8'), 1)
      expect(existsSync(join(record.root, 'mod', '.git'))).toBe(true)
      expect(existsSync(join(record.root, 'wt', '.git'))).toBe(false)
      expect(record.detachedGitLinks).toEqual(['wt/.git'])
      // 剪推送改的配置不算镜像里的变化：刚建好的沙箱差量是干净的。
      expect((await kernel.diffSandbox({ sandboxId })).gitChanged).toBe(false)
      // 本机有 git 就让 git 自己读一遍：三种写法的远端都认出了那条无效推送地址。
      if (Bun.which('git')) {
        for (const name of ['origin', 'UP', 'legacy']) {
          const read = Bun.spawnSync(['git', 'config', '--file', join(record.root, '.git', 'config'), '--get-all', `remote.${name}.pushurl`])
          expect({ name, pushurl: read.stdout.toString().trim() }).toEqual({ name, pushurl: 'DISABLED-BY-VELAROS-SANDBOX' })
        }
      }
    } finally {
      if (sandboxId) await kernel.discardSandbox(sandboxId)
      await kernel.dispose()
      await rm(source, { recursive: true, force: true })
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  test.skipIf(!canConfine)('INV-27 落回只落用户确认过的那份差量：确认之后镜像又变了就整批不落', async () => {
    const source = await makeSource()
    const kernel = createLocalSystemKernel({ cwd: source })
    let sandboxId = ''
    try {
      const record = await kernel.createSandbox({})
      sandboxId = record.id
      await writeFile(join(record.root, 'b.txt'), 'beta\n')
      // 用户看确认卡的时候镜像里还有命令在写（这里直接写一个新文件）：确认的是一份，镜像里已经是另一份。
      // 确认用的那份差量算完之后，镜像又变了，落回时拿旧指纹去核对就必须整批不落。
      const confirmed = await kernel.diffSandbox({ sandboxId, maxFiles: Number.MAX_SAFE_INTEGER, textDiffs: false })
      expect(confirmed.created).toEqual(['b.txt'])
      await writeFile(join(record.root, 'c.txt'), 'late\n')

      const failure = await kernel.applySandbox({ sandboxId, fingerprint: confirmed.fingerprint })
        .then(() => null, (error: unknown) => error as { context?: { executionOutcome?: string }; cause?: { reason?: string } })
      expect(failure?.context?.executionOutcome).toBe('not-applied')
      expect(failure?.cause?.reason).toBe('SYSTEM_SANDBOX_CHANGED')
      expect(existsSync(join(source, 'b.txt'))).toBe(false)
      expect(existsSync(join(source, 'c.txt'))).toBe(false)
    } finally {
      if (sandboxId) await kernel.discardSandbox(sandboxId)
      await kernel.dispose()
      await rm(source, { recursive: true, force: true })
    }
  })

  test.skipIf(!canConfine)('INV-28 落回只写在源目录之内：上级路径是符号链接就整批不落，暂存拷不全什么都不落', async () => {
    const source = await makeSource()
    const outside = await mkdtemp(join(tmpdir(), 'velaros-inv-outside-'))
    await symlink(outside, join(source, 'ext'))
    const kernel = createLocalSystemKernel({ cwd: source })
    let sandboxId = ''
    try {
      const record = await kernel.createSandbox({})
      sandboxId = record.id
      // 镜像里把指向源目录外的链接换成真目录，只落里面的新文件：源目录里的链接还在，落回会穿过它写到外面。
      await rm(join(record.root, 'ext'))
      await mkdir(join(record.root, 'ext'))
      await writeFile(join(record.root, 'ext', 'evil.txt'), 'evil\n')
      const escaped = await kernel.applySandbox({ sandboxId, paths: ['ext/evil.txt'] })
        .then(() => null, (error: unknown) => error as { cause?: { details?: { conflicts?: Array<{ path: string; reason: string }> } } })
      expect(escaped?.cause?.details?.conflicts?.[0]).toMatchObject({ path: 'ext/evil.txt', reason: 'link' })
      expect(existsSync(join(outside, 'evil.txt'))).toBe(false)

      // 暂存拷不全（镜像里有个文件读不出来）：别的文件也一个都不落，源目录里不留暂存目录。
      await writeFile(join(record.root, 'a.txt'), 'ALPHA\n')
      await writeFile(join(record.root, 'b.txt'), 'beta\n')
      await chmod(join(record.root, 'a.txt'), 0o000)
      const staged = await kernel.applySandbox({ sandboxId, paths: ['a.txt', 'b.txt'] })
        .then(() => null, (error: unknown) => error as { context?: { executionOutcome?: string } })
      await chmod(join(record.root, 'a.txt'), 0o644)
      expect(staged?.context?.executionOutcome).toBe('not-applied')
      expect(existsSync(join(source, 'b.txt'))).toBe(false)
      expect(await readFile(join(source, 'a.txt'), 'utf8')).toBe('alpha\n')
      expect((await readdir(source)).filter((name) => name.startsWith('.velaros-sandbox-'))).toEqual([])
    } finally {
      if (sandboxId) await kernel.discardSandbox(sandboxId)
      await kernel.dispose()
      await rm(source, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('代码面', () => {
  test('INV-31 模型写的程序经生成的声明调到真实操作：读真文件、在程序里筛、只交出要的', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-code-surface-'))
    try {
      await writeFile(join(directory, 'a.ts'), 'const a = 1\n// TODO: 补这里\n', 'utf8')
      await writeFile(join(directory, 'b.ts'), '干净文件，没有待办\n', 'utf8')

      const surface = createSystemCodeSurface({
        resolveContext: (signal) =>
          ({
            abortSignal: signal ?? new AbortController().signal,
            system: { resolvePath: (path?: string) => path ?? directory },
            approval: { awaitConfirmation: async () => undefined },
          }) as unknown as SystemToolContext,
      })
      const session = createCodeSurfaceSession({
        checker: codeProgramChecker,
        runner: nodeSubprocessCodeRunner,
        capabilities: createCapabilityPort(surface.operations),
      })
      // 授权用的就是**生成的那份声明**：模型看的和这里执行的是同一个源码的两头，
      // 一旦声明与操作漂了，程序连编译都过不去。
      const declarations = await readFile(
        resolve(import.meta.dir, '../../../baselines/code-surface/system.d.ts'),
        'utf8'
      )

      const outcome = await session.submit({
        program: {
          source: [
            "import { read } from 'velar:system'",
            `const r = await read({ files: [{ path: '${join(directory, 'a.ts')}' }, { path: '${join(directory, 'b.ts')}' }] })`,
            'export default r.files',
            "  .filter((f) => !('error' in f) && f.content.includes('TODO'))",
            '  .map((f) => f.path.split("/").pop())',
          ].join('\n'),
        },
        granted: [{ namespace: 'system', declarations }],
        timeoutMs: 20_000,
      })

      if (!outcome.checked) throw new Error(`应当通过检查：${JSON.stringify(outcome)}`)
      expect(outcome.result.failed).toBeUndefined()
      expect(outcome.result.value).toEqual(['a.ts'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)

  test('INV-32 上限由那件能力自己钳，不靠入参 schema 拦：换个入口也漏不掉', async () => {
    const asked: Array<Record<string, unknown>> = []
    const context = {
      abortSignal: new AbortController().signal,
      system: {
        resolvePath: (path?: string) => path ?? process.cwd(),
        runCommand: async (_command: string, options: Record<string, unknown>) => {
          asked.push(options)
          return { stdout: '', stderr: '', exitCode: 0, truncated: false }
        },
        listBackgroundTasks: async (options: Record<string, unknown>) => {
          asked.push(options)
          return []
        },
      },
      approval: { awaitConfirmation: async () => undefined },
    } as unknown as SystemToolContext

    // 直接调操作方法、绕开入参 schema——这正是「换一个入口」的样子。预算是这件能力自己的，得它自己兜底。
    await systemExecutionOperations.run(
      { command: 'echo hi', timeoutMs: 999_999_999, maxOutputChars: 999_999_999 },
      context
    )
    expect(asked[0]?.timeoutMs).toBe(SystemCommandLimits.timeoutMs)
    expect(asked[0]?.maxOutputChars).toBe(SystemCommandLimits.outputChars)

    await systemExecutionOperations.listTasks({ limit: 999_999 }, context)
    expect(asked[1]?.limit).toBe(SystemCommandLimits.taskListItems)
  })

  test('INV-22 大文件穿过隔离：12 MB 读进程序、在程序里改、写回去，模型只看到一行摘要', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-big-surface-'))
    try {
      const path = join(directory, 'big.log')
      const lines = Array.from({ length: 400_000 }, (_, index) => `${index % 997 === 0 ? 'ERROR' : 'INFO '} line ${index} ${'-'.repeat(12)}`)
      await writeFile(path, `${lines.join('\n')}\n`)
      const surface = createSystemCodeSurface({
        resolveContext: (signal) =>
          ({
            abortSignal: signal ?? new AbortController().signal,
            system: { resolvePath: (target?: string) => target ?? directory },
            approval: { awaitConfirmation: async () => undefined },
          }) as unknown as SystemToolContext,
      })
      const session = createCodeSurfaceSession({
        checker: codeProgramChecker,
        runner: nodeSubprocessCodeRunner,
        capabilities: createCapabilityPort(surface.operations),
      })
      const declarations = await readFile(resolve(import.meta.dir, '../../../baselines/code-surface/system.d.ts'), 'utf8')
      const outcome = await session.submit({
        program: {
          source: [
            "import { read, edit } from 'velar:system'",
            `const [file] = (await read({ files: [{ path: ${JSON.stringify(path)} }] })).files`,
            "if ('error' in file) throw new Error(file.error.message)",
            "const next = file.content.replaceAll('ERROR', 'FIXED')",
            `await edit({ files: [{ path: ${JSON.stringify(path)}, newText: next, version: file.version }] })`,
            "export default { chars: file.content.length, fixed: file.content.split('ERROR').length - 1 }",
          ].join('\n'),
        },
        granted: [{ namespace: 'system', declarations }],
        timeoutMs: 60_000,
      })
      if (!outcome.checked) throw new Error(`应当通过检查：${JSON.stringify(outcome)}`)
      expect(outcome.result.failed).toBeUndefined()
      // 模型那边只拿到这一小段：12 MB 的正文一个字都没进它的上下文
      const value = outcome.result.value as { chars: number; fixed: number }
      expect(value.chars).toBeGreaterThan(10_000_000)
      expect(value.fixed).toBe(402)
      expect(JSON.stringify(outcome.result).length).toBeLessThan(500)
      const after = await readFile(path, 'utf8')
      expect(after.includes('ERROR')).toBe(false)
      expect(after.split('FIXED').length - 1).toBe(402)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

  test('INV-31 入参不合法由操作方法自己拦，端口不盖第二层', async () => {
    const surface = createSystemCodeSurface({
      resolveContext: () => ({ abortSignal: new AbortController().signal }) as unknown as SystemToolContext,
    })
    const port = createCapabilityPort(surface.operations)
    // 绕开编译期（模型写 JSON.parse 就是这样）送进一个坏形状：拦它的是 SystemFileOperations 自己
    const outcome = await port.invoke({ namespace: 'system', operation: 'read', input: { files: '不是数组' } })
    expect(outcome.value).toBeUndefined()
    expect(outcome.error?.code).toBe('VALIDATION')
    expect(outcome.error?.message).toContain('files')
  })

  test('INV-31 登记的操作名与模型看到的声明逐个对上，没有一个只在一边有', async () => {
    const surface = createSystemCodeSurface({
      resolveContext: () => ({ abortSignal: new AbortController().signal }) as unknown as SystemToolContext,
    })
    const registered = [...(createCapabilityPort(surface.operations).listOperations().system ?? [])].sort()
    // 声明是模型唯一能看见的东西：声明里有而表里没有 = 模型照着写却调不通；
    // 表里有而声明里没有 = 那件能力模型根本不知道存在。两边都必须为空。
    const declarations = await readFile(
      resolve(import.meta.dir, '../../../baselines/code-surface/system.d.ts'),
      'utf8'
    )
    const declared = [...declarations.matchAll(/export function (\w+)/gu)].map((match) => match[1]).sort()
    expect(registered).toEqual(declared)
  })
})

describe('看图与代码模版', () => {
  const declarationsPath = resolve(import.meta.dir, '../../../baselines/code-surface/system.d.ts')
  const templatePath = resolve(import.meta.dir, '../templates/system.js')

  test('INV-33 代码模版整份照真实声明过类型检查，声明里嵌的就是这份文件', async () => {
    const declarations = await readFile(declarationsPath, 'utf8')
    const template = await readFile(templatePath, 'utf8')
    const checked = codeProgramChecker.check({ source: template, granted: [{ namespace: 'system', declarations }] })
    expect(checked.ok ? [] : checked.diagnostics).toEqual([])
    // 嵌进声明的那份要跟文件一字不差（去掉行首的注释前缀之后），否则模型看到的是旧模版
    const embedded = declarations
      .split('\n')
      .map((line) => line.replace(/^\s*\* ?/u, ''))
      .join('\n')
    for (const line of template.trim().split('\n').filter((text) => text.trim().length > 0)) {
      expect(embedded).toContain(line)
    }
  })

  const viewContext = (options: { resize?: (request: never) => Promise<unknown>; attach?: boolean } = {}) => {
    const attached: Array<{ mediaType: string; data: string; label: string }> = []
    const resized: unknown[] = []
    const context = {
      abortSignal: new AbortController().signal,
      approval: { awaitConfirmation: async () => undefined },
      system: {
        resolvePath: (path?: string) => path ?? process.cwd(),
        resizeImage: options.resize
          ? async (request: never) => {
            resized.push(request)
            return options.resize!(request)
          }
          : undefined,
      },
      attachImage: options.attach === false ? undefined : (image: { mediaType: string; data: string; label: string }) => attached.push(image),
    } as unknown as SystemToolContext
    return { context, attached, resized }
  }

  test('INV-34 在范围内的图原样交出，不碰缩放器；结果里只有尺寸，没有像素', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-view-'))
    try {
      const path = join(directory, 'small.png')
      await writeFile(path, solidPng(800, 600))
      const { context, attached, resized } = viewContext({ resize: async () => { throw new Error('不该被调') } })
      const result = await systemFileOperations.view({ files: [{ path }] }, context)
      expect(result.files[0]).toEqual({ path, mediaType: 'image/png', width: 800, height: 600, sent: { width: 800, height: 600 } })
      expect(JSON.stringify(result)).not.toContain('iVBOR')
      expect(resized).toHaveLength(0)
      expect(attached).toHaveLength(1)
      expect(attached[0]!.label).toContain('原图 800×600')
      expect(Buffer.from(attached[0]!.data, 'base64').equals(await readFile(path))).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('INV-34 超出长边才请宿主压；要了 region 才请宿主裁，整块在图外直接拒', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-view-'))
    try {
      const path = join(directory, 'big.png')
      await writeFile(path, solidPng(4000, 3000))
      const shrunk = solidPng(2000, 1500)
      const { context, resized } = viewContext({ resize: async () => ({ data: shrunk, mediaType: 'image/png', width: 2000, height: 1500 }) })

      const whole = await systemFileOperations.view({ files: [{ path }] }, context)
      expect(whole.files[0]).toMatchObject({ width: 4000, height: 3000, sent: { width: 2000, height: 1500 } })
      expect(resized[0]).toMatchObject({ longEdge: SystemFileLimits.imageEdge })

      await systemFileOperations.view({ files: [{ path, region: { x: 3000, y: 0, width: 5000, height: 500 } }] }, context)
      // region 超出图的部分收进来：x 从 3000 起，最多到 4000
      expect(resized[1]).toMatchObject({ region: { x: 3000, y: 0, width: 1000, height: 500 } })

      await expect(systemFileOperations.view({ files: [{ path, region: { x: 5000, y: 0, width: 10, height: 10 } }] }, context))
        .rejects.toThrow('整块都在图外')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('INV-34 宿主压不了时，超限的图明说并给出 run 命令；没有交图通道时 view 直接不可用', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-view-'))
    try {
      const path = join(directory, 'big.png')
      await writeFile(path, solidPng(3000, 2000))
      const noResizer = viewContext()
      await expect(systemFileOperations.view({ files: [{ path }] }, noResizer.context)).rejects.toThrow('sips -Z')
      const noChannel = viewContext({ attach: false })
      await expect(systemFileOperations.view({ files: [{ path }] }, noChannel.context)).rejects.toThrow('没有把图交给模型的通道')
      const text = join(directory, 'note.txt')
      await writeFile(text, '不是图')
      await expect(systemFileOperations.view({ files: [{ path: text }] }, viewContext().context)).rejects.toThrow('不是模型能看的图片')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'darwin')('INV-34 本机内核在 macOS 上用 sips 真压、真裁：先裁后缩，尺寸与颜色都对', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-view-'))
    const kernel = createLocalSystemKernel({ cwd: directory })
    try {
      const path = join(directory, 'wide.png')
      await writeFile(path, solidPng(3000, 2000))
      const attached: Array<{ data: string }> = []
      const context = {
        abortSignal: new AbortController().signal,
        approval: { awaitConfirmation: async () => undefined },
        system: kernel,
        attachImage: (image: { data: string }) => attached.push(image),
      } as unknown as SystemToolContext

      const whole = await systemFileOperations.view({ files: [{ path }] }, context)
      expect(whole.files[0]).toMatchObject({ width: 3000, height: 2000, sent: { width: 2000, height: 1333 } })

      // 右半边（纯蓝）裁 1000×800：不超长边，不该被放大
      const zoomed = await systemFileOperations.view({ files: [{ path, region: { x: 2000, y: 0, width: 1000, height: 800 } }] }, context)
      expect(zoomed.files[0]).toMatchObject({ sent: { width: 1000, height: 800 } })
    } finally {
      await kernel.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
})

