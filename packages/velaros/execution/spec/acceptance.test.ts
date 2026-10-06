/**
 * shell 能力的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 * 本机实现（`./local` 入口：本机宿主、受约束执行器）的承诺也在这里验收，用的是真宿主、真进程（INV-11～INV-16）。
 */
import { existsSync } from 'node:fs'
import { mkdtemp, realpath } from 'node:fs/promises'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { shellProcessManager } from '../impl/local/ShellProcessManager'
import type { ShellProcessConfinementEvidence } from '../index'
import {
  shellCommandApproval,
  ShellCommandOperationKind,
  shellCommandPolicy,
  ShellErrorCodes,
} from '../index'
import { createConfinedShellRunner, createLocalShellHost, createShellEnvironment } from '../local'
import { buildConfinedSpawnSpec } from '../utils/confinement'

import { canConfine, fakeChild } from './support'

describe('只读与危险判定', () => {
  test('INV-1 白名单命令一旦带写盘参数，整条掉出只读', () => {
    expect(shellCommandPolicy.isReadOnly('find . -name "*.ts"')).toBe(true)
    expect(shellCommandPolicy.isReadOnly('sed -n 1,20p file.txt')).toBe(true)
    // 白名单是「无人值守自动放行」与「可并发执行」两道判定的底；这几种写盘形态必须掉出来。
    expect(shellCommandPolicy.isReadOnly('find . -name "*.tmp" -delete')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('find . -type f -exec rm {} ;')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('sed -i s/a/b/ file.txt')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('sed --in-place=.bak s/a/b/ file.txt')).toBe(false)
  })

  test('INV-1 git 全局选项能让只读子命令执行别的程序，一律判非只读；tree -o 写盘', () => {
    expect(shellCommandPolicy.isReadOnly("git -c core.pager='rm -rf x' log")).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git -c diff.external=/tmp/evil diff')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git -ccore.fsmonitor=/tmp/evil.sh status')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git --config-env=core.pager=EVIL log')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git --exec-path=/tmp/evil status')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git -p log')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git --paginate log')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git --no-pager log -1')).toBe(true)
    expect(shellCommandPolicy.isReadOnly('tree -o out.txt')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('tree -H . -o report.html')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('tree -L 2')).toBe(true)
  })

  test('INV-1 git 只认全局选项之后的已知只读子命令，未知形态一律判非只读', () => {
    expect(shellCommandPolicy.isReadOnly('git -C repo status')).toBe(true)
    // 任何 -c 都不算只读：值可能就是要执行的程序，判据不区分 key。
    expect(shellCommandPolicy.isReadOnly('git -c core.fileMode=false log -1')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git --git-dir repo/.git status')).toBe(true)
    expect(shellCommandPolicy.isReadOnly('git --git-dir=repo/.git status')).toBe(true)
    expect(shellCommandPolicy.isReadOnly('git -C --output=repo status')).toBe(true)
    expect(shellCommandPolicy.isReadOnly('git -C repo checkout main')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git --git-dir=repo/.git clean -fd')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git branch -D obsolete')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git config --set core.fileMode false')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git diff --output=changes.patch')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git log --output history.txt')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git show --output=commit.txt HEAD')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git --future-option status')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git future-command')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git -C')).toBe(false)
  })

  // 这些写法都在本机实测过会执行别的程序或写文件（rg --pre rm 把搜到的文件全删了），却曾被判成只读、可并发、可无人值守放行。
  test('INV-1 参数、前缀和环境变量能让白名单命令执行别的程序或写文件，一律判非只读', () => {
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
      expect({ command, readOnly: shellCommandPolicy.isReadOnly(command) }).toEqual({
        command,
        readOnly: false,
      })
    }
    // 只读的 sed 写法照样判只读，不因为收紧而全部掉出去。
    for (const command of [
      "sed -n '/start/,/end/p' notes.txt",
      "sed -E 's/[0-9]+/N/g' notes.txt",
      "sed '/x/!d' notes.txt",
      'sed -n -e 2p -e 4p notes.txt',
      'rg -n TODO src',
      'git grep -n TODO',
      'time -p ls',
    ]) {
      expect({ command, readOnly: shellCommandPolicy.isReadOnly(command) }).toEqual({
        command,
        readOnly: true,
      })
    }
  })

  // 删整个文件夹恢复不了，不论带不带 -f 都要确认；删单个文件是日常操作，不打扰用户。
  test('INV-2 递归删除一律判危险并说明删的是整个文件夹，删单个文件不打扰', () => {
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
      'rm ./directory -Recurse',
    ]) {
      const plan = shellCommandPolicy.analyze(command)
      expect(plan.isDangerous).toBe(true)
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
      expect(shellCommandPolicy.analyze(command).isDangerous).toBe(false)
    }
  })

  test('INV-2 Windows 的递归删除形态同样判危险，单文件删除是日常操作', () => {
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
      const plan = shellCommandPolicy.analyze(command)
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
      expect(shellCommandPolicy.analyze(command).isDangerous).toBe(false)
    }
    expect(shellCommandPolicy.analyze('Remove-Item HKLM:\\Software\\Demo').isDangerous).toBe(true)
  })
})

describe('危险命令的审批请求', () => {
  test('INV-3 高风险、必须用户亲自点、不可记忆；操作身份只看去掉首尾空白的命令、工作目录和前后台，跨入口一致', () => {
    const plan = shellCommandPolicy.analyze('rm -rf ./dist')
    const first = shellCommandApproval.dangerous({
      command: 'rm -rf ./dist',
      plan,
      cwd: '/repo',
      background: false,
      scopeLabel: '当前项目',
      riskScope: 'project-command:dangerous',
    })
    const second = shellCommandApproval.dangerous({
      command: '  rm -rf ./dist  ',
      plan,
      cwd: '/repo',
      background: false,
      scopeLabel: '系统运行环境',
      riskScope: 'system-command:dangerous',
    })
    expect(first.options).toMatchObject({
      approvalRisk: 'high',
      requireManualApproval: true,
      rememberRiskScope: false,
      riskScope: 'project-command:dangerous',
      operation: { label: 'rm -rf ./dist', target: '/repo' },
    })
    expect(first.options.operation?.key.startsWith(`${ShellCommandOperationKind}:`)).toBe(true)
    expect(second.options.operation?.key).toBe(first.options.operation?.key)
    expect(
      shellCommandApproval.dangerous({
        command: 'rm -rf ./dist',
        plan,
        cwd: '/other',
        background: false,
        scopeLabel: '当前项目',
        riskScope: 'x',
      }).options.operation?.key
    ).not.toBe(first.options.operation?.key)
    expect(
      shellCommandApproval.dangerous({
        command: 'rm -rf ./dist',
        plan,
        cwd: '/repo',
        background: true,
        scopeLabel: '当前项目',
        riskScope: 'x',
      }).options.operation?.key
    ).not.toBe(first.options.operation?.key)
    // 确认卡只有一行：在哪、是哪一类，加上命令的第一行；很长的命令截断，不摊开正文。
    expect(first.message).toBe('在当前项目递归删除：rm -rf ./dist')
    const long = shellCommandApproval.dangerous({
      command: `rm -rf ./${'a'.repeat(300)}\nsecond line`,
      plan,
      cwd: '/repo',
      background: false,
      scopeLabel: '当前项目',
      riskScope: 'x',
    })
    expect(long.message.split('\n')).toHaveLength(1)
    expect(long.message.endsWith('…')).toBe(true)
  })
})

function thrownBy(call: () => unknown): { code?: string; message?: string } {
  try {
    call()
  } catch (error) {
    return error as { code?: string; message?: string }
  }
  throw new Error('应当抛错，却没有')
}

/** 在系统临时目录下建一个空目录，交回解开符号链接之后的路径。 */
async function scratch(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)))
}

describe('本机宿主：进程约束', () => {
  test('INV-11 受约束模式没有可用后端时失败关闭：拒绝执行、报 SHELL_CONFINEMENT_UNAVAILABLE，不交回没包约束的启动规格', () => {
    // Windows 没有内置后端、Linux 没有 bubblewrap：都拒绝，不退回裸进程。
    const windows = thrownBy(() =>
      buildConfinedSpawnSpec(
        {
          spec: { file: 'cmd.exe', args: ['/c', 'exit 0'] },
          policy: { mode: 'read-only', workspaceRoot: 'C:\\workspace' },
        },
        { platform: 'win32' }
      )
    )
    const linux = thrownBy(() =>
      buildConfinedSpawnSpec(
        {
          spec: { file: '/bin/sh', args: ['-lc', 'true'] },
          policy: { mode: 'read-only', workspaceRoot: '/workspace' },
        },
        { platform: 'linux', bubblewrapAvailable: false }
      )
    )
    for (const failure of [windows, linux]) {
      expect(failure).toMatchObject({
        code: ShellErrorCodes.processConfinementUnavailable,
        message: expect.stringContaining('已拒绝以裸进程继续执行'),
      })
    }
  })

  test.skipIf(process.platform === 'win32')(
    'INV-11 本机宿主与受约束执行器在没有后端的平台上一条命令都不跑：宿主拒绝执行，执行器建的时候就拒绝',
    async () => {
      const root = await scratch('velaros-shell-inv11-')
      // 按一个没有内置约束后端的平台跑：宿主要受约束地跑命令，就一个字节都不执行。
      const host = createLocalShellHost({
        cwd: root,
        platform: 'freebsd',
        processConfinement: { mode: 'workspace-write' },
      })
      try {
        await expect(host.runCommand('printf x > marker.txt')).rejects.toMatchObject({
          code: ShellErrorCodes.processConfinementUnavailable,
        })
        expect(existsSync(join(root, 'marker.txt'))).toBe(false)
        // 受约束执行器（演练沙箱的每个镜像根一个）建的时候先探测后端：没有就拒绝，不给调用方留一个会裸跑的执行器。
        expect(
          thrownBy(() =>
            createConfinedShellRunner({ root, tempDir: root, network: false, platform: 'freebsd' })
          )
        ).toMatchObject({ code: ShellErrorCodes.processConfinementUnavailable })
      } finally {
        await host.dispose()
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  test('INV-12 约束证据如实上报：不约束就写 enforcement none、backend none，不冒充隔离；用户确认过的危险命令也不改写约束事实', async () => {
    const unconfined: ShellProcessConfinementEvidence = {
      mode: 'danger-full-access',
      enforcement: 'none',
      backend: 'none',
      reason: 'explicit-danger-full-access',
      writableRoots: [],
    }
    const result = buildConfinedSpawnSpec({
      spec: { file: '/bin/sh', args: ['-lc', 'true'] },
      policy: { mode: 'danger-full-access', workspaceRoot: '/workspace' },
    })
    expect(result.spec).toEqual({ file: '/bin/sh', args: ['-lc', 'true'] })
    expect(result.evidence).toEqual(unconfined)
    // 本机宿主缺省不约束，回执照实写 none；审批（allowDangerous 为真）是另一件事，约束事实不跟着变。
    const host = createLocalShellHost({ cwd: process.cwd() })
    try {
      expect((await host.runCommand('true')).confinement).toEqual(unconfined)
      expect((await host.runCommand('true', {}, true)).confinement).toEqual(unconfined)
    } finally {
      await host.dispose()
    }
  })

  test.skipIf(!canConfine)(
    'INV-12 受约束的宿主报真实的后端与覆盖面：macOS 的 sandbox-exec 只拦得住文件写，报 partial，不冒充 full',
    async () => {
      const root = await scratch('velaros-shell-inv12-')
      const host = createLocalShellHost({
        cwd: root,
        processConfinement: { mode: 'workspace-write' },
      })
      try {
        const result = await host.runCommand('printf ok > inside.txt')
        expect(result.exitCode).toBe(0)
        expect(result.confinement).toMatchObject(
          process.platform === 'darwin'
            ? {
                mode: 'workspace-write',
                backend: 'seatbelt',
                enforcement: 'partial',
                reason: 'enforced-file-writes-only',
              }
            : { mode: 'workspace-write', backend: 'bubblewrap', enforcement: 'full' }
        )
        expect(result.confinement?.writableRoots).toContain(root)
      } finally {
        await host.dispose()
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})

describe('本机宿主：命令输出', () => {
  test('INV-13 输出超长只留末尾且末尾真实、truncated 为真；转后台的命令回执里带 taskId，按它查得到那条任务', async () => {
    const host = createLocalShellHost({ cwd: process.cwd() })
    try {
      const long = await host.runCommand('fixture', {
        nativeCommand: {
          file: process.execPath,
          args: ['-e', "process.stdout.write('x'.repeat(5000) + 'TAIL-END')"],
        },
        maxOutputChars: 100,
      })
      // 砍头不砍尾：失败现场在尾部。
      expect(long.truncated).toBe(true)
      expect(long.stdout.endsWith('TAIL-END')).toBe(true)
      expect(long.stdout.length).toBeLessThanOrEqual(100)

      const started = await host.runCommand('fixture', {
        nativeCommand: { file: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'] },
        background: true,
      })
      const taskId = started.backgroundProcess?.taskId
      expect(taskId).toBeTruthy()
      expect((await host.listBackgroundTasks({ taskId: taskId! })).map((task) => task.id)).toEqual([
        taskId!,
      ])
      await host.terminateBackgroundTask({ taskId: taskId!, force: true })
    } finally {
      await host.dispose()
    }
  })

  test('INV-14 管道分块不打碎 UTF-8 字符，退出码原样透传，shell 描述符里不带 env', async () => {
    const host = createLocalShellHost({ cwd: process.cwd() })
    const text = '中文🙂'
    try {
      const result = await host.runCommand('fixture', {
        nativeCommand: {
          file: process.execPath,
          args: [
            '-e',
            `
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
      `,
          ],
        },
        timeoutMs: 3_000,
      })

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
    } finally {
      await host.dispose()
    }
  })
})

describe('本机宿主：进程生命周期', () => {
  test('INV-15 终止信号无人响应、close 永不到达时，进程管理仍在期限内收敛，并如实标记清理未完成', async () => {
    const child = fakeChild()
    const signals: string[] = []
    const owned = shellProcessManager.manage(child, {
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

describe('本机宿主：shell 的选择', () => {
  test('INV-16 挑定的 shell 本机没有时在起进程之前拒绝，报错点名可用的与默认的那个，不换默认 shell 照跑', async () => {
    const host = createLocalShellHost({ cwd: process.cwd() })
    try {
      const inspection = await host.inspectEnvironment()
      const available = inspection.shells.map((shell) => shell.kind)
      // 清单第一个就是默认那个；挑清单里没有的种类，命令一个字节的输出都不会有。
      expect(available[0]).toBe(inspection.shell.kind!)
      const missing = (['pwsh', 'cmd', 'git-bash', 'powershell', 'posix'] as const).find(
        (kind) => !available.includes(kind)
      )!
      await expect(host.runCommand('echo 不该跑起来', { shell: missing })).rejects.toMatchObject({
        code: 'VALIDATION',
      })
      await expect(host.runCommand('echo 不该跑起来', { shell: missing })).rejects.toThrow(
        `本机没有 ${missing}`
      )
      await expect(host.runCommand('echo 不该跑起来', { shell: missing })).rejects.toThrow(
        available[0]!
      )
      expect((await host.runCommand('echo ok', { shell: available[0] })).stdout.trim()).toBe('ok')
    } finally {
      await host.dispose()
    }
  })
})

// 宿主环境只经本机 API 注入；不会成为模型输入或修改整个进程的环境。
test.skipIf(process.platform === 'win32')(
  'INV-17 共享登录环境用于原生命令和体检，刷新生效且借用者释放不关闭环境',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shell-environment-owner-'))
    const script = join(directory, 'login-shell')
    await writeFile(script, '#!/bin/sh\nprintf "startup banner=ignored\\n"\nexec /bin/sh "$@"\n')
    await chmod(script, 0o700)
    let value = 'first'
    const environment = createShellEnvironment({
      env: () => ({ ...process.env, SHELL: script, SHARED_ENV_VALUE: value }),
    })
    const host = createLocalShellHost({ cwd: directory, environment })
    try {
      const first = await environment.getEnvironment()
      expect(first.SHARED_ENV_VALUE).toBe('first')
      expect(first['startup banner']).toBeUndefined()
      first.SHARED_ENV_VALUE = 'caller mutation'
      const run = () =>
        host.runCommand('read environment', {
          nativeCommand: {
            file: process.execPath,
            args: ['-e', 'process.stdout.write(process.env.SHARED_ENV_VALUE)'],
          },
        })
      expect((await run()).stdout).toBe('first')
      const inspection = await host.inspectEnvironment()
      expect(inspection.shell.path).toBe(script)
      value = 'second'
      const refreshed = await host.refreshShellEnvironment()
      expect(refreshed.revision).toBe('1')
      expect((await run()).stdout).toBe('second')
      await host.dispose()
      expect((await environment.getEnvironment()).SHARED_ENV_VALUE).toBe('second')
    } finally {
      await host.dispose()
      await environment.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  }
)

for (const stdin of ['', '中文🙂\nsecond line\n']) {
  test(`INV-18 foreground stdin preserves UTF-8 and sends EOF (${stdin.length} chars)`, async () => {
    const host = createLocalShellHost({ cwd: process.cwd() })
    try {
      const result = await host.runCommand('stdin fixture', {
        nativeCommand: {
          file: process.execPath,
          args: [
            '-e',
            "process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{process.stdout.write(text);process.exitCode=7})",
          ],
        },
        stdin,
        timeoutMs: 5_000,
      })
      expect(result.stdout).toBe(stdin)
      expect(result.exitCode).toBe(7)
      expect(result.cleanupIncomplete).toBe(false)
      expect(result.capture?.decodeErrors).toBe(0)
    } finally {
      await host.dispose()
    }
  })
}

test('INV-18 native environment deletion is per-command and leaves the borrowed snapshot intact', async () => {
  const environment = createShellEnvironment({
    env: () => ({ ...process.env, CLI_KEEP: 'initial', CLI_REMOVE: 'remove-me' }),
  })
  const host = createLocalShellHost({ cwd: process.cwd(), environment })
  try {
    const result = await host.runCommand('environment fixture', {
      nativeCommand: {
        file: process.execPath,
        args: [
          '-e',
          "process.stdout.write(JSON.stringify({keep:process.env.CLI_KEEP,removed:Object.hasOwn(process.env,'CLI_REMOVE')}))",
        ],
        env: { CLI_KEEP: 'updated', CLI_REMOVE: undefined },
      },
    })
    expect(JSON.parse(result.stdout)).toEqual({ keep: 'updated', removed: false })
    expect((await environment.getEnvironment()).CLI_REMOVE).toBe('remove-me')
    expect((await environment.getEnvironment()).CLI_KEEP).toBe('initial')
    await expect(
      host.runCommand('must not spawn', { background: true, stdin: '' })
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await host.listBackgroundTasks()).toEqual([])
  } finally {
    await host.dispose()
    await environment.dispose()
  }
})

test('INV-18 a child closing stdin early and an unread input timeout both settle through process ownership', async () => {
  const host = createLocalShellHost({ cwd: process.cwd() })
  try {
    const early = await host.runCommand('early exit', {
      nativeCommand: { file: process.execPath, args: ['-e', 'process.exit(0)'] },
      stdin: 'x'.repeat(2_000_000),
      timeoutMs: 5_000,
    })
    expect(early.exitCode).toBe(0)
    expect(early.cleanupIncomplete).toBe(false)
    const timeout = await host.runCommand('unread input', {
      nativeCommand: { file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] },
      stdin: 'x'.repeat(2_000_000),
      timeoutMs: 50,
    })
    expect(timeout.timedOut).toBe(true)
    expect(timeout.cleanupIncomplete).toBe(false)
  } finally {
    await host.dispose()
  }
})
