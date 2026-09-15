/**
 * 系统空间的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 *
 * 改动或删除已有用例要在差量报告里点名并说明理由。
 * 这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 */

import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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
import { assertInsideSandboxBase, sandboxBaseDirectory } from '../src/utils/sandbox.js'

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

  test('INV-2 git 全局选项能让只读子命令执行别的程序，一律判非只读；tree -o 写盘', () => {
    expect(systemCommandPolicy.isReadOnly("git -c core.pager='rm -rf x' log")).toBe(false)
    expect(systemCommandPolicy.isReadOnly('git -c diff.external=/tmp/evil diff')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('git -ccore.fsmonitor=/tmp/evil.sh status')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('git --config-env=core.pager=EVIL log')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('git --exec-path=/tmp/evil status')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('git -p log')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('git --paginate log')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('git --no-pager log -1')).toBe(true)
    expect(systemCommandPolicy.isReadOnly('tree -o out.txt')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('tree -H . -o report.html')).toBe(false)
    expect(systemCommandPolicy.isReadOnly('tree -L 2')).toBe(true)
  })

  test('INV-2 git 只认全局选项之后的已知只读子命令，未知形态一律判非只读', () => {
    expect(systemCommandPolicy.isReadOnly('git -C repo status')).toBe(true)
    // 任何 -c 都不算只读：值可能就是要执行的程序，判据不区分 key。
    expect(systemCommandPolicy.isReadOnly('git -c core.fileMode=false log -1')).toBe(false)
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

  // 这些写法都在本机实测过会执行别的程序或写文件（rg --pre rm 把搜到的文件全删了），却曾被判成只读、可并发、可无人值守放行。
  test('INV-2 参数、前缀和环境变量能让白名单命令执行别的程序或写文件，一律判非只读', () => {
    for (const command of [
      'rg --pre rm foo .',
      'rg --hostname-bin=touch foo .',
      'git grep -Otouch foo',
      'git grep --open-files-in-pager=touch foo',
      "git ls-remote --upload-pack='touch x' .",
      "git -C . ls-remote -u 'touch x' .",
      "git ls-remote --exec='touch x' .",
      "env -S'rm -rf x'",
      "env --split-string='rm -rf x'",
      "env -S'rm -rf x' cat file",
      'env time -o /tmp/out cat /etc/hosts',
      'time --output=/tmp/out cat file',
      'LD_PRELOAD=/tmp/evil.so cat file',
      "GIT_EXTERNAL_DIFF='rm -rf x' git diff",
      'env GIT_EXTERNAL_DIFF=x git diff',
      'RIPGREP_CONFIG_PATH=/tmp/rgrc rg foo',
      "sed -n '1w /tmp/out' file",
      "sed 's/a/b/gw /tmp/out' file",
      "sed -e'w /tmp/out' file",
      "sed --expression='w /tmp/out' file",
      "sed 's/.*/touch x/e' file",
      "sed '1e touch x' file",
      'sed -f script.sed file',
      // 方括号里的分隔符各家 sed 切法不一样，认不准就按会写处理。
      "sed 's/[/x/w out]/y/' file",
      'tree -R -H . -L 1',
      'tree -ao out.txt',
    ]) {
      expect({ command, readOnly: systemCommandPolicy.isReadOnly(command) }).toEqual({ command, readOnly: false })
    }
    // 只读的 sed 写法照样判只读，不因为收紧而全部掉出去。
    for (const command of ["sed -n '/start/,/end/p' notes.txt", "sed -E 's/[0-9]+/N/g' notes.txt", "sed '/x/!d' notes.txt", 'sed -n -e 2p -e 4p notes.txt', 'rg -n TODO src', 'git grep -n TODO', 'time -p ls']) {
      expect({ command, readOnly: systemCommandPolicy.isReadOnly(command) }).toEqual({ command, readOnly: true })
    }
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
  test('INV-7 五个有参工具的 schema 都拒绝顶层未知字段，refresh-environment 是唯一例外', () => {
    const minimal: Record<string, Record<string, unknown>> = {
      [SystemToolNames.read]: { files: [{ path: 'x' }] },
      [SystemToolNames.view]: { files: [{ path: 'x' }] },
      [SystemToolNames.edit]: { files: [{ path: 'x', newText: '' }] },
      [SystemToolNames.run]: { command: 'true' },
      [SystemToolNames.listTasks]: {},
    }
    for (const [name, input] of Object.entries(minimal)) {
      expect(systemTools[name as keyof typeof systemTools].schema.safeParse(input).success).toBe(true)
      expect(systemTools[name as keyof typeof systemTools].schema.safeParse({ ...input, unknownField: 1 }).success).toBe(false)
    }
    expect(systemTools[SystemToolNames.refreshEnvironment].schema.safeParse({ unknownField: 1 }).success).toBe(true)
  })

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
    )).rejects.toThrow('系统能力的入参不合法')
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
      'system:sandbox': 'write',
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
      'system:sandbox': 'system-execution',
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
      'system:sandbox',
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
      const messages: string[] = []
      // 用户看确认卡的时候镜像里还有命令在写（这里直接写一个新文件）：确认的是一份，镜像里已经是另一份。
      const context = {
        abortSignal: new AbortController().signal,
        system: kernel,
        approval: {
          requestApproval: async () => ({ approved: true }),
          awaitConfirmation: async (message: string) => {
            messages.push(message)
            await writeFile(join(record.root, 'c.txt'), 'late\n')
          },
        },
      }
      const failure = await systemTools[SystemToolNames.sandbox].execute({ action: 'apply', sandboxId }, context as never)
        .then(() => null, (error: unknown) => error as { context?: { executionOutcome?: string }; cause?: { reason?: string } })
      expect(messages[0]).toContain('新增 1 个')
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
