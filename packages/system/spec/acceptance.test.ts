/**
 * 系统空间的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 *
 * 改动或删除已有用例要在差量报告里点名并说明理由。
 * 这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 * 能力本身（`velar:files`、`velar:images`、`velar:shell`、`velar:sandbox` 的操作）在各自的能力单元里验收；这里验收本机宿主，以及系统空间把它们装起来之后的样子。
 */

import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'
import { codeProgramChecker, createCapabilityPort, createCodeSurfaceSession, nodeSubprocessCodeRunner } from '@velaros-ai/code-surface'

import { systemProcessManager } from '../src/impl/SystemProcessManager.js'
import { createLocalSystemKernel, createSystemSpace } from '../src/index'
import { buildSystemProcessConfinementSpawnSpec } from '../src/utils/confinement.js'
import { assertInsideSandboxBase, sandboxBaseDirectory } from '../src/utils/sandbox.js'

import { fakeChild, solidPng } from './support'

const BaselineDirectory = resolve(import.meta.dir, '../../../baselines/code-surface')
const canConfine = (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'))
  || (process.platform === 'linux' && ['/usr/bin/bwrap', '/usr/local/bin/bwrap'].some((path) => existsSync(path)))

/**
 * 一个真的系统空间：真本地内核、真操作表；审批端口记下每次确认并放行。
 * `onResolve` 在内核每次解析模型给的路径时先被叫到（同步），测试借它在「定改法」与「落盘」之间插一手。
 * 用完调 `dispose`，内核起过的后台进程一并停掉。
 */
function systemSpaceAt(cwd: string, onResolve?: (path: Optional<string>) => void) {
  const kernel = createLocalSystemKernel({ cwd })
  const confirmations: string[] = []
  const approval: ApprovalPort = {
    awaitConfirmation: async (message) => {
      confirmations.push(message)
    },
    awaitConfirmationDecision: async () => ({ approved: true, message: null, autoApproved: false }),
  }
  const host = new Proxy(kernel, {
    get: (target, property) => {
      if (property === 'resolvePath') return (path?: string) => { onResolve?.(path); return target.resolvePath(path) }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const space = createSystemSpace({ host, resolveCall: (signal) => ({ abortSignal: signal ?? new AbortController().signal, approval, sessionId: 'session-1' }) })
  const port = createCapabilityPort(space.operations)
  const program = async (source: string) => {
    const session = createCodeSurfaceSession({ checker: codeProgramChecker, runner: nodeSubprocessCodeRunner, capabilities: port })
    const granted = ['files', 'images', 'shell', 'sandbox'].map((namespace) => ({ namespace, declarations: readFileSync(join(BaselineDirectory, `${namespace}.d.ts`), 'utf8') }))
    const outcome = await session.submit({ program: { source }, granted, timeoutMs: 30_000 })
    if (!outcome.checked) throw new Error(`应当通过检查：${JSON.stringify(outcome)}`)
    return outcome
  }
  return { kernel, space, port, program, confirmations, dispose: () => kernel.dispose() }
}

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

describe('命令输出', () => {
  test('INV-10 输出超长保留末尾且末尾真实；转后台的命令回执里带 taskId', async () => {
    const kernel = createLocalSystemKernel({ cwd: process.cwd() })
    try {
      const long = await kernel.runCommand('fixture', {
        nativeCommand: { file: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(5000) + 'TAIL-END')"] },
        maxOutputChars: 100,
      })
      // 砍头不砍尾：失败现场在尾部
      expect(long.truncated).toBe(true)
      expect(long.stdout.endsWith('TAIL-END')).toBe(true)
      expect(long.stdout.length).toBeLessThanOrEqual(100)

      const started = await kernel.runCommand('fixture', {
        nativeCommand: { file: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'] },
        background: true,
      })
      const taskId = started.backgroundProcess?.taskId
      expect(taskId).toBeTruthy()
      expect((await kernel.listBackgroundTasks({ taskId: taskId! })).map((task) => task.id)).toEqual([taskId!])
      await kernel.terminateBackgroundTask({ taskId: taskId!, force: true })
    } finally {
      await kernel.dispose()
    }
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

describe('演练沙箱', () => {
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
      const failure = await kernel.applySandbox({ sandboxId }).then(() => null, (error: unknown) => error as { code?: string; context?: { executionOutcome?: string } })
      expect(failure?.code).toBe('SYSTEM_SANDBOX_CONFLICT')
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

  test.skipIf(!canConfine)('INV-27 落回只落核对过的那份差量：核对之后镜像又变了就整批不落', async () => {
    const source = await makeSource()
    const kernel = createLocalSystemKernel({ cwd: source })
    let sandboxId = ''
    try {
      const record = await kernel.createSandbox({})
      sandboxId = record.id
      await writeFile(join(record.root, 'b.txt'), 'beta\n')
      // 核对完差量之后镜像里还有命令在写（这里直接写一个新文件）：核对的是一份，镜像里已经是另一份。
      // 落回时拿旧指纹去核对就必须整批不落。
      const confirmed = await kernel.diffSandbox({ sandboxId, textDiffs: false })
      expect(confirmed.created).toEqual(['b.txt'])
      await writeFile(join(record.root, 'c.txt'), 'late\n')

      const failure = await kernel.applySandbox({ sandboxId, fingerprint: confirmed.fingerprint })
        .then(() => null, (error: unknown) => error as { code?: string; context?: { executionOutcome?: string } })
      expect(failure?.context?.executionOutcome).toBe('not-applied')
      expect(failure?.code).toBe('SYSTEM_SANDBOX_CHANGED')
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
        .then(() => null, (error: unknown) => error as { code?: string; context?: { conflicts?: Array<{ path: string; reason: string }> } })
      expect(escaped?.code).toBe('SYSTEM_SANDBOX_CONFLICT')
      expect(escaped?.context?.conflicts?.[0]).toMatchObject({ path: 'ext/evil.txt', reason: 'link' })
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

describe('系统空间：四件能力配上本机端口', () => {
  test('INV-19 读写凭证文件与系统敏感路径不问用户：经符号链接改私钥、读私钥、撤回，一次确认都没有', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-inv19-')))
    const system = systemSpaceAt(root)
    try {
      await writeFile(join(root, 'deploy.pem'), '-----BEGIN PRIVATE KEY-----\nabc\n')
      await symlink(join(root, 'deploy.pem'), join(root, 'notes.txt'))
      const edited = await system.port.invoke({ namespace: 'files', operation: 'edit', input: { files: [{ path: 'notes.txt', newText: 'rotated\n' }] } })
      expect(edited.error).toBeUndefined()
      expect(await readFile(join(root, 'deploy.pem'), 'utf8')).toBe('rotated\n')
      const read = await system.port.invoke({ namespace: 'files', operation: 'read', input: { files: [{ path: 'deploy.pem' }] } })
      expect(read.value).toMatchObject({ files: [{ lines: [[1, 'rotated']] }] })
      const undone = await system.port.invoke({ namespace: 'files', operation: 'undo', input: { changeId: (edited.value as { changeId: string }).changeId } })
      expect(undone.error).toBeUndefined()
      expect(await readFile(join(root, 'deploy.pem'), 'utf8')).toContain('PRIVATE KEY')
      expect(system.confirmations).toEqual([])
    } finally {
      await system.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('INV-20 本机落盘核对计划时的字节：定下改法之后被同尺寸、同修改时间地改掉，也不覆盖', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-inv20-')))
    const plain = join(root, 'plain.txt')
    // 超过 64 KB：这么大的文件落盘前只看「大小 + 修改时间」，两样都没变就不重读（小文件一律重读，拦不到这里）。
    const concurrent = `${'z'.repeat(100 * 1024)}\n`
    const pinned = 1_700_000_000
    // 定第二个文件的改法时，别人把第一个文件改成同样长度的内容，并把修改时间拨回整数秒
    const system = systemSpaceAt(root, (path) => {
      if (path !== 'second.txt') return
      writeFileSync(plain, concurrent)
      utimesSync(plain, pinned, pinned)
    })
    try {
      await writeFile(plain, `${'a'.repeat(100 * 1024)}\n`)
      await utimes(plain, pinned, pinned)
      await writeFile(join(root, 'second.txt'), 'second\n')
      const outcome = await system.port.invoke({ namespace: 'files', operation: 'edit', input: { files: [{ path: 'plain.txt', newText: 'beta\n' }, { path: 'second.txt', newText: 'x\n' }] } })
      expect(outcome.error?.code).toBe('VALIDATION')
      expect(outcome.error?.message).toContain('被别人改了')
      expect(await readFile(plain, 'utf8')).toBe(concurrent)
      expect(await readFile(join(root, 'second.txt'), 'utf8')).toBe('second\n')
    } finally {
      await system.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('INV-31 操作表登记的名字与模型看到的四份声明逐个对上；入参不合法由操作方法自己拦', async () => {
    const system = systemSpaceAt(tmpdir())
    try {
      const registered = system.port.listOperations()
      expect(Object.keys(registered).sort()).toEqual(['files', 'images', 'sandbox', 'shell'])
      for (const [namespace, operations] of Object.entries(registered)) {
        const declarations = readFileSync(join(BaselineDirectory, `${namespace}.d.ts`), 'utf8')
        const declared = [...declarations.matchAll(/export function (\w+)/gu)].map((match) => match[1]).sort()
        expect({ namespace, operations: [...operations].sort() }).toEqual({ namespace, operations: declared })
      }
      // 挂的模块清单就是这四个：随包发布的声明与生成物是同一份，放出的方法就是能调的那些；常驻的是本机文件与命令。
      expect(system.space.modules.map(({ surface }) => surface.namespace).sort()).toEqual(Object.keys(registered).sort())
      for (const { surface } of system.space.modules) {
        expect(surface.specifier).toBe(`velar:${surface.namespace}`)
        expect(surface.declarations).toBe(readFileSync(join(BaselineDirectory, `${surface.namespace}.d.ts`), 'utf8'))
        expect([...surface.methods].sort()).toEqual([...registered[surface.namespace]!].sort())
      }
      expect(system.space.modules.filter((module) => module.resident).map(({ surface }) => surface.namespace)).toEqual(['files', 'shell'])
      // 绕开编译期（模型写 JSON.parse 就是这样）送进一个坏形状：拦它的是那件能力自己
      const outcome = await system.port.invoke({ namespace: 'files', operation: 'read', input: { files: '不是数组' } })
      expect(outcome.value).toBeUndefined()
      expect(outcome.error).toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('files') })
    } finally {
      await system.dispose()
    }
  })

  test.skipIf(process.platform !== 'darwin')('INV-34 本机在 macOS 上用 sips 真压、真裁：超长边的图压到上限以内，裁出来的一块不被放大', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-inv34-')))
    const system = systemSpaceAt(root)
    try {
      await writeFile(join(root, 'wide.png'), solidPng(3000, 2000))
      const whole = await system.port.invoke({ namespace: 'images', operation: 'view', input: { files: [{ path: 'wide.png' }] } })
      expect(whole.value).toMatchObject({ files: [{ width: 3000, height: 2000, sent: { width: 2000, height: 1333 } }] })
      expect(whole.attachments?.[0]?.mediaType).toBe('image/png')
      // 右半边（纯蓝）裁 1000×800：不超长边，不该被放大
      const zoomed = await system.port.invoke({ namespace: 'images', operation: 'view', input: { files: [{ path: 'wide.png', region: { x: 2000, y: 0, width: 1000, height: 800 } }] } })
      expect(zoomed.value).toMatchObject({ files: [{ sent: { width: 1000, height: 800 } }] })
    } finally {
      await system.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  test('INV-35 一段真程序经系统空间用上三件能力：相对路径相对内核的工作目录，命令在本机跑，结果只交出要的', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-inv35-')))
    const system = systemSpaceAt(root)
    try {
      await writeFile(join(root, 'notes.txt'), 'TODO: 补这里\n干净的一行\n')
      const outcome = await system.program(`import { edit, read } from 'velar:files'
import { run } from 'velar:shell'

const [file] = (await read({ files: [{ path: 'notes.txt' }] })).files
if ('error' in file) throw new Error(file.error.message)
const [line, text] = file.lines[0]
await edit({ files: [{ path: 'notes.txt', version: file.version, edits: [{ range: line, text: text.replace('TODO', 'DONE') }] }] })
const listed = await run({ command: 'ls' })
export default { path: file.path, listed: listed.stdout.includes('notes.txt'), cwd: listed.cwd }`)
      expect(outcome.result.failed).toBeUndefined()
      expect(outcome.result.value).toEqual({ path: join(root, 'notes.txt'), listed: true, cwd: root })
      expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('DONE: 补这里\n干净的一行\n')
    } finally {
      await system.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  test('INV-36 撤回一次改动：写回改之前的字节、删掉那次新建的；删之前核对它还是那次写下的内容', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-inv36-')))
    const system = systemSpaceAt(root)
    try {
      await writeFile(join(root, 'kept.txt'), 'one\r\ntwo\r\n')
      const edited = await system.port.invoke({ namespace: 'files', operation: 'edit', input: { files: [
        { path: 'kept.txt', newText: 'uno\ndos\n' },
        { path: 'fresh/new.txt', newText: 'hello\n' },
      ] } })
      expect(edited.error).toBeUndefined()
      // 整份写照原文件的换行风格存：原来是 CRLF 的还是 CRLF
      expect(await readFile(join(root, 'kept.txt'), 'utf8')).toBe('uno\r\ndos\r\n')
      const changeId = (edited.value as { changeId: string }).changeId
      const undone = await system.port.invoke({ namespace: 'files', operation: 'undo', input: { changeId } })
      expect(undone.value).toMatchObject({ files: [{ action: 'restored' }, { action: 'deleted' }] })
      expect(await readFile(join(root, 'kept.txt'), 'utf8')).toBe('one\r\ntwo\r\n')
      expect(existsSync(join(root, 'fresh/new.txt'))).toBe(false)
      // 改动之后别人又动过：整个不撤，一个文件都不动
      const again = await system.port.invoke({ namespace: 'files', operation: 'edit', input: { files: [{ path: 'kept.txt', newText: 'tres\n' }] } })
      await writeFile(join(root, 'kept.txt'), 'someone else\n')
      const refused = await system.port.invoke({ namespace: 'files', operation: 'undo', input: { changeId: (again.value as { changeId: string }).changeId } })
      expect(refused.error?.code).toBe('FILES_UNDO_CONFLICT')
      expect(await readFile(join(root, 'kept.txt'), 'utf8')).toBe('someone else\n')
    } finally {
      await system.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(!canConfine)('INV-35 系统空间的沙箱：镜像任意目录，镜像里的命令写不到外面，落回不问用户', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-inv35-sandbox-')))
    const system = systemSpaceAt(tmpdir())
    try {
      await writeFile(join(root, 'a.txt'), 'alpha\n')
      const outcome = await system.program(`import { apply, create, diff, run } from 'velar:sandbox'

const box = await create({ source: ${JSON.stringify(root)} })
const inside = await run({ id: box.id, command: 'printf beta > b.txt' })
const outside = await run({ id: box.id, command: 'printf x > ${join(root, 'a.txt')}' })
const changes = await diff({ id: box.id })
const applied = await apply({ id: box.id })
export default { inside: inside.success, escaped: outside.success, created: changes.created, applied: applied.created }`)
      expect(outcome.result.failed).toBeUndefined()
      expect(outcome.result.value).toEqual({ inside: true, escaped: false, created: ['b.txt'], applied: ['b.txt'] })
      expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('beta')
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
      expect(system.confirmations).toEqual([])
      for (const record of system.kernel.listSandboxes()) await system.kernel.discardSandbox(record.id)
    } finally {
      await system.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
