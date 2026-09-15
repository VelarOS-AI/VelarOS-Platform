/**
 * 系统空间的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 *
 * 改动或删除已有用例要在差量报告里点名并说明理由。
 * 这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 */

import { lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { SystemCommandResult } from '../src/exports/contracts'
import {
  createLocalSystemKernel,
  createSystemBundledModDefinition,
  createSystemKernelModule,
  SystemCapability,
  type SystemCapabilityService,
  systemCommandPolicy,
  SystemToolCategoryByName,
  type SystemToolContext,
  SystemToolNames,
  systemTools,
} from '../src/exports/index'
import { systemProcessManager } from '../src/impl/SystemProcessManager.js'
import { buildSystemProcessConfinementSpawnSpec } from '../src/utils/confinement.js'

import { captureService, fakeChild } from './support'

describe('命令安全门', () => {

  test('INV-2 白名单命令一旦带写盘参数，整条掉出只读', () => {
    expect(systemCommandPolicy.isReadOnly('find . -name "*.ts"')).toBe(true)
    expect(systemCommandPolicy.isReadOnly('sed -n 1,20p file.txt')).toBe(true)
    // 白名单是「无人值守自动放行」与「可并发执行」两道判定的底；这几种写盘形态必须掉出来。
    expect(systemCommandPolicy.isReadOnly('find . -name "*.tmp" -delete')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('find . -type f -exec rm {} ;')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('sed -i s/a/b/ file.txt')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('sed --in-place=.bak s/a/b/ file.txt')).toBe(false)
  })

  test('INV-2 git 只认全局选项之后的已知只读子命令，未知形态一律判非只读', () => {
    expect(systemCommandPolicy.isReadOnly('git -C repo status')).toBe(true)
    expect(systemCommandPolicy.isReadOnly('git -c core.fileMode=false log -1')).toBe(true)
    expect(systemCommandPolicy.isReadOnly('git --git-dir repo/.git status')).toBe(true)
    expect(systemCommandPolicy.isReadOnly('git --git-dir=repo/.git status')).toBe(true)
    expect(systemCommandPolicy.isReadOnly('git -C --output=repo status')).toBe(true)
    expect(systemCommandPolicy.isReadOnly('git -C repo checkout main')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('git --git-dir=repo/.git clean -fd')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('git branch -D obsolete')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('git config --set core.fileMode false')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('git diff --output=changes.patch')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('git log --output history.txt')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('git show --output=commit.txt HEAD')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('git --future-option status')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('git future-command')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('git -C')).toBe(false)
    expect(systemTools[SystemToolNames.run].isConcurrencySafe?.({
      command: 'git -C repo checkout main',
      parallel: true,
    })).toBe(false)
  })

  // 删整个文件夹恢复不了，不论带不带 -f 都要确认；删单个文件是日常操作，不打扰用户。
  test('INV-3 递归删除一律判危险并说明删的是整个文件夹，删单个文件不打扰', () => {
    for (const command of [
      'rm -r ./directory',
      'rm -R ./directory',
      'rm --recursive ./directory',
      'rm --rec ./directory',
      'rm -r -f ./victim',
      'rm -f -r ./victim',
      'rm --recursive --force ./victim',
      'rm -r --force ./victim',
      'RM -RF /',
      '/bin/RM -Rf /',
      'RM --RECURSIVE --FORCE /',
      'sudo rm -r /tmp/cache',
      'ls | xargs rm -r',
      'git rm -rf ./directory',
      'rm ./directory -Recurse',
    ]) {
      const plan = systemCommandPolicy.analyze(command)
      expect(plan.isDangerous).toBe(true)
      expect(plan.shouldRequestConfirmation).toBe(true)
      expect(plan.dangerousReason).toContain('递归删除整个文件夹')
    }

    for (const command of [
      'rm ./file',
      'rm -f ./file',
      'rm -v src/f.ts',
      'rm docs/s.md',
      'rm ./file -Force',
      'git rm -r --cached ./directory',
      'git rm -r ./directory',
    ]) {
      expect(systemCommandPolicy.analyze(command).isDangerous).toBe(false)
    }
  })

  test('INV-3 Windows 的递归删除形态同样判危险，单文件删除是日常操作', () => {
    for (const command of [
      'Remove-Item -Recurse -Force build',
      'Remove-Item build -Recurse',
      'Remove-Item build -Recurse:$true',
      'ri build -r',
      'rd /s /q build',
      'RMDIR /S build',
      'rmdir/s/q build',
      'del /s /q *.tmp',
    ]) {
      const plan = systemCommandPolicy.analyze(command)
      expect(plan.isDangerous).toBe(true)
      expect(plan.dangerousReason).toContain('递归删除整个文件夹')
    }

    for (const command of [
      'Remove-Item .\\notes.txt',
      'Remove-Item .\\notes.txt -Force',
      'del /f notes.txt',
      'del docs/s.md',
      'rd build',
      'git branch --del -r origin/obsolete',
    ]) {
      expect(systemCommandPolicy.analyze(command).isDangerous).toBe(false)
    }
    expect(systemCommandPolicy.analyze('Remove-Item HKLM:\\Software\\Demo').isDangerous).toBe(true)
  })

  test('INV-4 危险命令的审批是高风险手动确认，不可按类记忆，并标明精确命令', async () => {
    const seen: Array<Record<string, unknown> | undefined> = []
    const context = {
      abortSignal: new AbortController().signal,
      approval: {
        awaitConfirmation: async (
          _message: string,
          _signal?: AbortSignal,
          options?: Record<string, unknown>
        ) => {
          seen.push(options)
        },
      },
      system: {
        resolvePath: (path?: string) => path ?? process.cwd(),
        runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0, truncated: false }),
      },
    } as never

    await systemTools[SystemToolNames.run].execute({ command: 'rm -rf /tmp/velaros-fixture' }, context)
    expect(seen[0]).toMatchObject({
      approvalRisk: 'high',
      riskScope: 'system-command:dangerous',
      requireManualApproval: true,
      rememberRiskScope: false,
      operation: { label: 'rm -rf /tmp/velaros-fixture' },
    })

    await systemTools[SystemToolNames.run].execute({ command: 'npm run dev' }, context)
    // 长驻服务只是体验型确认：低风险、可按类记忆，语义不变。
    expect(seen[1]).toEqual({ approvalRisk: 'low' })
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

describe('工具面', () => {
  test('INV-7 wire 面用严格 schema，未知字段在解析宿主上下文之前就被拒绝', async () => {
    let service: SystemCapabilityService | undefined
    let resolverCalls = 0
    const module = createSystemKernelModule({
      resolveContext: (_scope, signal) => {
        resolverCalls += 1
        return {
          abortSignal: signal,
          system: { listBackgroundTasks: async () => [] },
        } as unknown as SystemToolContext
      },
    })
    await module.activate(captureService((_tokenId, registered) => {
      service = registered as SystemCapabilityService
    }))

    await expect(service?.invoke(
      'system:list-tasks',
      undefined,
      { unexpected: true },
      new AbortController().signal,
    )).rejects.toThrow('System capability input is invalid')
    expect(resolverCalls).toBe(0)
  })

  test('INV-8 只发布 canonical 的 system: 工具', () => {
    expect(Object.keys(systemTools).toSorted()).toEqual(Object.values(SystemToolNames).toSorted())
    expect(Object.keys(systemTools).every((name) => name.startsWith('system:'))).toBe(true)
  })

  test('INV-8 不发布项目发现或诊断快捷工具', () => {
    expect(Object.hasOwn(systemTools, 'discover_projects')).toBe(false)
    expect(Object.hasOwn(systemTools, 'diagnose_dev_runtime')).toBe(false)
    expect(Object.hasOwn(systemTools, 'get_system_overview')).toBe(false)
  })

  test('INV-9 每个工具声明权威的副作用种类', () => {
    const expectedEffects = {
      'system:read': 'read',
      'system:view': 'read',
      'system:edit': 'write',
      'system:run': 'execute',
      'system:refresh-environment': 'write',
      'system:list-tasks': 'read',
    } as const

    expect(Object.keys(systemTools)).toEqual(Object.keys(expectedEffects))
    for (const [name, effectKind] of Object.entries(expectedEffects)) {
      const tool = systemTools[name as keyof typeof systemTools]
      expect(tool.capabilities?.effectKind).toBe(effectKind)
      expect(tool.readOnly).toBe(effectKind === 'read')
      expect(tool.capabilities?.reason).toBeTruthy()
      if (effectKind !== 'read') expect(tool.capabilities?.writeScopes?.length).toBeGreaterThan(0)
    }
  })

  test('INV-9 一个工具只属于一个职责类别', () => {
    expect(SystemToolCategoryByName).toEqual({
      'system:read': 'system-files',
      'system:view': 'system-files',
      'system:edit': 'system-files',
      'system:run': 'system-execution',
      'system:refresh-environment': 'system-execution',
      'system:list-tasks': 'system-execution',
    })
  })

  test('INV-13 常驻工具只有读看改跑四个，其余按需装入', () => {
    const tools = createSystemBundledModDefinition().manifest.contributes.tools
    // 读—看—改—跑常驻，找文件也走 run；后台任务 / 环境刷新是排障场景，走 tooling:map 按名换入。
    expect(
      tools.flatMap((tool) => (tool.residentInSpaces?.includes('system') ? [tool.name] : [])),
    ).toEqual([
      'system:read',
      'system:view',
      'system:edit',
      'system:run',
    ])
  })

  test('INV-14 内核模块注册精确的工具集合，权限清单不含通配', async () => {
    let service: SystemCapabilityService | undefined
    const module = createSystemKernelModule()
    await module.activate(captureService((tokenId, registered) => {
      expect(tokenId).toBe(SystemCapability.id)
      service = registered as SystemCapabilityService
    }))

    expect(module.manifest.id).toBe('velaros.system')
    expect(Object.keys(service?.tools ?? {})).toEqual([
      'system:read',
      'system:view',
      'system:edit',
      'system:run',
      'system:refresh-environment',
      'system:list-tasks',
    ])
    expect(service?.getOperationMetadata('system:list-tasks')).toBeUndefined()
    expect(service?.tools['system:edit']?.description).toContain('oldText')
    expect(service?.tools['system:run']?.description).toContain('复制、移动、删除、归档、解压')
    expect(service?.tools['system:run']?.description).toContain('Git Bash/POSIX')
    expect(module.manifest.permissions).not.toContain('*')
  })

  test('INV-15 nativeCommand 只供宿主使用，不出现在 system:run 的模型 schema 里', () => {
    const schema = systemTools[SystemToolNames.run].schema as { shape?: Record<string, unknown> }
    expect(schema.shape).toBeDefined()
    expect(Object.keys(schema.shape ?? {})).not.toContain('nativeCommand')
  })
})

describe('命令输出', () => {
  test('INV-10 截断输出保留真实末尾，并给出可执行的召回续接', async () => {
    let service: SystemCapabilityService | undefined
    const commandResult: SystemCommandResult = {
      command: 'printf lots',
      cwd: '/tmp',
      exitCode: 0,
      signal: null,
      stdout: 'last line\n',
      stderr: '',
      logPath: '/tmp/vela-system-command-123.log',
      durationMs: 10,
      timedOut: false,
      aborted: false,
      truncated: true,
      success: true,
      verification: { kind: 'unknown', status: 'unknown', issues: [] },
    }
    const module = createSystemKernelModule({
      resolveContext: (_scope, signal) =>
        ({
          abortSignal: signal,
          system: {
            runCommand: async () => commandResult,
            resolvePath: (path?: string) => path ?? process.cwd(),
          },
          approval: { awaitConfirmation: async () => undefined },
        }) as unknown as SystemToolContext,
    })
    await module.activate(captureService((_tokenId, registered) => {
      service = registered as SystemCapabilityService
    }))

    const result = (await service?.invoke(
      'system:run',
      undefined,
      { command: 'printf lots', maxOutputChars: 100 },
      new AbortController().signal,
    )) as SystemCommandResult

    expect(result.outputWindow).toEqual({
      retained: 'tail',
      complete: false,
      endPreserved: true,
    })
    expect(result.outputContinuation).toEqual({
      kind: 'session-terminal-log',
      query: 'vela-system-command-123.log',
      tool: 'context:recall',
      args: { query: 'vela-system-command-123.log', kind: 'terminal' },
    })
  })

  test('INV-10 后台命令的状态续接指向 system:list-tasks，不交给内核 job 工具', async () => {
    let service: SystemCapabilityService | undefined
    const commandResult: SystemCommandResult = {
      command: 'printf ready',
      cwd: '/tmp',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: 5,
      timedOut: false,
      aborted: false,
      truncated: false,
      success: true,
      backgroundProcess: {
        taskId: 'task-background-123',
        sessionId: 'session-1',
        pid: 123,
        logPath: '/tmp/vela-system-command-background.log',
        ports: [],
        reason: null,
        terminateCommand: null,
        forceTerminateCommand: null,
        fallbackTerminateCommand: null,
        requested: true,
        autoStarted: false,
      },
      verification: { kind: 'unknown', status: 'unknown', issues: [] },
    }
    const module = createSystemKernelModule({
      resolveContext: (_scope, signal) =>
        ({
          abortSignal: signal,
          system: {
            runCommand: async () => commandResult,
            resolvePath: (path?: string) => path ?? process.cwd(),
          },
          approval: { awaitConfirmation: async () => undefined },
        }) as unknown as SystemToolContext,
    })
    await module.activate(captureService((_tokenId, registered) => {
      service = registered as SystemCapabilityService
    }))

    const result = (await service?.invoke(
      'system:run',
      undefined,
      { command: 'printf ready', background: true },
      new AbortController().signal,
    )) as SystemCommandResult

    expect(result.outputWindow).toEqual({
      retained: 'tail',
      complete: false,
      endPreserved: true,
    })
    expect(result.outputContinuation).toEqual({
      kind: 'session-terminal-log',
      query: 'vela-system-command-background.log',
      tool: 'context:recall',
      args: { query: 'vela-system-command-background.log', kind: 'terminal' },
    })
    expect(result.backgroundProcess?.statusContinuation).toEqual({
      tool: 'system:list-tasks',
      args: { taskId: 'task-background-123' },
    })
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
  const edit = systemTools[SystemToolNames.edit]
  const read = systemTools[SystemToolNames.read]
  const failureOf = async (call: Promise<unknown>): Promise<{ code: string; outcome: unknown; problems: Array<Record<string, unknown>> }> => {
    try {
      await call
    } catch (error) {
      const failure = error as { code: string; context?: { executionOutcome?: unknown }; cause?: { details?: { problems?: Array<Record<string, unknown>> } } }
      return { code: failure.code, outcome: failure.context?.executionOutcome, problems: failure.cause?.details?.problems ?? [] }
    }
    throw new Error('expected the call to fail')
  }

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

  test('INV-20 一批全成或全不成：定不下来或核对后被改，什么都不写并按 not-applied 报告', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-inv20-'))
    try {
      const a = join(root, 'a.txt')
      const b = join(root, 'b.txt')
      await writeFile(a, 'alpha\n')
      await writeFile(b, 'beta\n')
      const unresolved = await failureOf(edit.execute({ files: [
        { path: a, edits: [{ range: { offset: 0, end: 6 }, oldText: 'nope', newText: 'x' }] },
        { path: b, newText: 'never\n' },
      ] }, approving))
      expect(unresolved.outcome).toBe('not-applied')
      expect(unresolved.problems).toEqual([expect.objectContaining({ file: 0, edit: 0, reason: 'not-found' })])
      expect(await readFile(a, 'utf8')).toBe('alpha\n')
      expect(await readFile(b, 'utf8')).toBe('beta\n')
      const before = await read.execute({ files: [{ path: a }] }, approving) as { files: Array<{ version: string; range: { offset: number; end: number } }> }
      await writeFile(a, 'changed outside\n')
      const stale = await failureOf(edit.execute({ files: [
        { path: a, version: before.files[0]!.version, edits: [{ range: before.files[0]!.range, newText: 'x' }] },
        { path: b, newText: 'never\n' },
      ] }, approving))
      expect(stale.outcome).toBe('not-applied')
      expect(stale.problems[0]).toMatchObject({ file: 0, reason: 'stale' })
      expect(await readFile(b, 'utf8')).toBe('beta\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('INV-21 文本改动无损：二进制文件不许整个覆盖，符号链接写到它指向的文件而链接不变', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-inv21-'))
    try {
      const png = join(root, 'logo.png')
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3])
      await writeFile(png, bytes)
      const refused = await failureOf(edit.execute({ files: [{ path: png, newText: 'oops\n' }] }, approving))
      expect(refused.outcome).toBe('not-applied')
      expect(refused.problems[0]).toMatchObject({ file: 0, reason: 'invalid' })
      expect(Buffer.from(await readFile(png)).equals(bytes)).toBe(true)

      const real = join(root, 'real.conf')
      await writeFile(real, 'Host a\n')
      const link = join(root, 'link.conf')
      await symlink(real, link)
      const result = await edit.execute({ files: [{ path: link, edits: [{ range: { offset: 0, end: 7 }, oldText: 'Host a', newText: 'Host b' }] }] }, approving) as { files: Array<{ path: string; target?: string; action: string }> }
      expect(result.files[0]).toMatchObject({ path: link, action: 'replaced', target: await realpath(real) })
      expect((await lstat(link)).isSymbolicLink()).toBe(true)
      expect(await readFile(real, 'utf8')).toBe('Host b\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('INV-22 一次 read 最多 20 万字符，预算用完后的文件不读盘也不问用户', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-inv22-'))
    try {
      const big = join(root, 'big.txt')
      await writeFile(big, `${'a'.repeat(200_000)  }tail`)
      const key = join(root, 'id_rsa')
      await writeFile(key, 'secret\n')
      const result = await read.execute({ files: [{ path: big }, { path: key }] }, denying) as { files: Array<Record<string, unknown>>; note?: string }
      expect(result.files[0]).toMatchObject({ hasMore: true, totalChars: 200_004 })
      expect(result.files[1]).toMatchObject({ path: key, error: { code: 'VALIDATION' } })
      expect(result.files[1]).not.toHaveProperty('version')
      expect(result.note).toContain('从第 2 个文件起没有读')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
