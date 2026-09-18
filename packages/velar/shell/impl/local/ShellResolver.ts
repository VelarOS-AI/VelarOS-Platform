/**
 * shell 选择与自检：`ShellResolver` 与整个进程唯一的 `shellResolver`。接口 `ShellResolverApi` 在本文件的类上方。
 * 不出包；只查文件、不跑进程的部分在 `utils/shell.ts`。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { win32 } from 'node:path'

import { isPlainObject, isString, Log, toNullable } from '@velaros-ai/core'
import { currentPlatform } from '@velaros-ai/platform'
import type { CommandSpec } from '@velaros-ai/platform/contracts'

import type { RefreshedWindowsEnvironment, ResolvedShell, ResolveShellOptions,ShellProbeResult } from '../../types/local.js'
import type { ShellCommandAvailability } from '../../types/shell-command.js'
import { buildOwnedProcessSpec } from '../../utils/process.js'
import { detectAvailableShells, readWindowsEnv, uniquePaths } from '../../utils/shells.js'
import { ShellTuning } from '../../utils/tuning.js'

import type { ShellProcessManagerApi } from './ShellProcessManager.js'
import { shellProcessManager } from './ShellProcessManager.js'
import { ShellUnavailableError } from './ShellUnavailableError.js'

const log = Log.tag('ShellResolver')

/**
 * shell 选择与自检：在本机找能用的 shell、试跑确认它真能工作、按它的查找规则判断命令在不在、在 Windows 上刷新环境变量。
 *
 * 实现是 `ShellResolver`，整个进程只有一份（`shellResolver`），不出包。
 * Windows 上按 Git Bash、PowerShell 7、Windows PowerShell、CMD 的顺序找；其他平台用 SHELL。
 */
export interface ShellResolverApi {
  /** 只查文件、不试跑，同步返回第一个候选 shell，给界面展示用。一个都找不到时抛 ShellUnavailableError。 */
  resolve(options?: ResolveShellOptions): ResolvedShell
  /**
   * 执行命令前用这个：按候选顺序逐个试跑一小段 UTF-8 输出，返回第一个真能工作的 shell，环境变量里标上 ready 和版本。
   * 只有这个自检会换下一个候选；用户的命令只执行一次，不会因为失败换 shell 重跑。全部失败时抛 ShellUnavailableError，附上每个候选的原因。
   */
  resolveReady(options?: ResolveShellOptions): Promise<ResolvedShell>
  /** 按这个 shell 自己的查找规则判断一个命令在不在、在哪、是什么（内建命令、批处理、原生程序或脚本）。 */
  resolveCommand(name: string, shell: ResolvedShell): Promise<ShellCommandAvailability>
  /**
   * Windows 上重新读取用户和系统环境变量（用户装完软件不用重启应用），合并 PATH 并展开 %VAR%，返回新环境和它的指纹 revision。
   * 其他平台原样返回；读取失败时 refreshed 为 false 并给出原因。返回的环境里去掉了本包自己写的 VELAROS_SHELL_* 标记；
   * 宿主设的 VELAROS_SHELL_PATH 也不在其中，写回宿主进程时由 replaceEnvironment 照留。
   */
  refreshWindowsEnvironment(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): Promise<RefreshedWindowsEnvironment>
}

class ShellResolver implements ShellResolverApi {
  /** CMD 的内建命令：它们不是文件，`where` 找不到，要直接认。 */
  private static readonly CmdBuiltins: ReadonlySet<string> = new Set('assoc break call cd chdir cls color copy date del dir echo endlocal erase exit for ftype goto if md mkdir mklink move path pause popd prompt pushd rd rem ren rename rmdir set setlocal shift start time title type ver verify vol'.split(' '))

  private readonly processes: ShellProcessManagerApi

  constructor(processes: ShellProcessManagerApi) {
    this.processes = processes
  }

  public resolve(options: ResolveShellOptions = {}): ResolvedShell {
    const shell = detectAvailableShells(options)[0]
    if (!shell) throw new ShellUnavailableError()
    return shell
  }

  public async resolveReady(options: ResolveShellOptions = {}): Promise<ResolvedShell> {
    const failures: string[] = []
    for (const shell of detectAvailableShells(options)) {
      let health: ShellProbeResult
      try { health = await (options.probe ?? ((candidate, timeoutMs) => this.probe(candidate, timeoutMs)))(shell, options.timeoutMs ?? ShellTuning.shell.probeTimeoutMs) }
      catch (error) {
        log.debug('shell readiness probe failed', { shell: shell.shellPath, error })
        health = { ready: false, reason: error instanceof Error ? error.message : 'shell 启动失败。' }
      }
      if (!health.ready) { failures.push(`${shell.name}: ${health.reason || 'unavailable'}`); continue }
      return {
        ...shell, readiness: 'ready', version: toNullable(health.version),
        env: { ...shell.env, VELAROS_SHELL_READINESS: 'ready', VELAROS_SHELL_VERSION: health.version ?? '' },
      }
    }
    throw new ShellUnavailableError(failures.join(' '))
  }

  public async resolveCommand(name: string, shell: ResolvedShell): Promise<ShellCommandAvailability> {
    if (shell.kind === 'cmd' && ShellResolver.CmdBuiltins.has(name.trim().toLowerCase())) return { name, available: true, path: name.trim(), kind: 'builtin' }
    const quoted = currentPlatform.quoteShellArg(name.replace(/\\/g, shell.kind === 'git-bash' ? '/' : '\\'), { kind: shell.kind })
    // @arch-guard:suspend code-style/require-chinese-comments 理由：下方字符串是发送给各 Shell 的命令，不是说明文案。
    const command = shell.kind === 'cmd' ? `where ${quoted}`
      : shell.kind === 'pwsh' || shell.kind === 'powershell'
        ? `$c = Get-Command -Name ${quoted} -ErrorAction SilentlyContinue; if ($null -eq $c) { exit 1 }; if ($c.Path) { Write-Output $c.Path } else { Write-Output $c.Name }`
        : shell.kind === 'git-bash'
          ? `p=$(command -v ${quoted}) || exit $?; case "$p" in /*) cygpath -w -- "$p" ;; *) printf '%s\\n' "$p" ;; esac`
          : `command -v ${quoted}`
    const result = await this.capture(currentPlatform.getShellCommandSpec(command, { shellPath: shell.shellPath, kind: shell.kind }), shell.env, ShellTuning.shell.probeTimeoutMs)
    const path = result.exitCode === 0 ? result.stdout.trim().split(/\r?\n/)[0] || null : null
    return {
      name, available: !!path, path,
      kind: !path ? null : /\.(?:cmd|bat)$/i.test(path) ? 'batch'
        : /\.(?:exe|com)$/i.test(path) ? 'native' : !/[\\/]/.test(path) ? 'builtin' : 'script',
    }
  }

  public async refreshWindowsEnvironment(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
  ): Promise<RefreshedWindowsEnvironment> {
    const result = { ...env }
    for (const key of Object.keys(result)) {
      if (key.toUpperCase().startsWith('VELAROS_SHELL_')) delete result[key]
    }
    let refreshed = platform !== 'win32'
    // 刷新失败的原因，只在失败时有值，且一定是非空文本。
    let reason: Optional<string>
    if (platform === 'win32') {
      const root = readWindowsEnv(env, 'SystemRoot') || 'C:\\Windows'
      const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ` +
        `@{machine=[Environment]::GetEnvironmentVariables('Machine');user=[Environment]::GetEnvironmentVariables('User')} | ConvertTo-Json -Compress`
      const captured = await this.capture({
        file: win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      }, env, ShellTuning.shell.environmentRefreshTimeoutMs)
      if (captured.exitCode === 0) {
        try {
          const source = JSON.parse(captured.stdout) as { machine: Record<string, string>; user: Record<string, string> }
          if (!isPlainObject(source.machine) || !isPlainObject(source.user)) throw new Error('读到的 Windows 环境变量快照格式不对。')
          const merged = { ...source.machine, ...source.user }
          const machinePath = readWindowsEnv(source.machine, 'PATH') ?? ''
          const userPath = readWindowsEnv(source.user, 'PATH') ?? ''
          for (const [key, value] of Object.entries(merged)) {
            if (!isString(value) || key.toUpperCase().startsWith('VELAROS_')
              || ['TEMP', 'TMP', 'SYSTEMROOT', 'SYSTEMDRIVE', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].includes(key.toUpperCase())) continue
            for (const previous of Object.keys(result)) if (previous.toUpperCase() === key.toUpperCase()) delete result[previous]
            result[key] = value
          }
          for (const key of Object.keys(result)) if (key.toUpperCase() === 'PATH') delete result[key]
          const expandedUserPath = userPath.replace(/%PATH%/ig, machinePath)
          result.PATH = uniquePaths([
            machinePath, expandedUserPath, readWindowsEnv(env, 'PATH') ?? '',
          ].filter(Boolean).join(';').split(';')).join(';')
          for (const key of Object.keys(result)) {
            let value = result[key]
            for (let pass = 0; isString(value) && pass < 8; pass++) {
              const expanded = value.replace(/%([^%]+)%/g, (match, name: string) =>
                name.toUpperCase() === key.toUpperCase() ? match : readWindowsEnv(result, name) ?? match)
              if (expanded === value) break
              value = expanded
            }
            result[key] = value
          }
          refreshed = true
        } catch (error) {
          log.warn('windows environment refresh failed', { error })
          reason = error instanceof Error && error.message ? error.message : '读到的 Windows 环境变量快照格式不对。'
        }
      } else reason = captured.timedOut ? '重读 Windows 环境变量超时。' : captured.stderr || '这台机器上没法重读 Windows 环境变量。'
    }
    const revision = createHash('sha256').update(JSON.stringify(Object.entries(result).sort())).digest('hex').slice(0, 16)
    return { env: result, revision, refreshed, reason }
  }

  /** 默认的就绪自检：让 shell 打印一个带中文的标记和自己的版本，标记原样回来才算能用。 */
  private async probe(shell: ResolvedShell, timeoutMs: number): Promise<ShellProbeResult> {
    const marker = 'VelarOS-shell-ready-中文'
    const command = shell.kind === 'cmd' ? `echo ${marker} & ver`
      : shell.kind === 'pwsh' || shell.kind === 'powershell'
        ? `Write-Output '${marker}'; Write-Output $PSVersionTable.PSVersion.ToString()`
        : `printf '${marker}\\n%s\\n' "\${BASH_VERSION:-posix}"`
    const result = await this.capture(currentPlatform.getShellCommandSpec(command, { shellPath: shell.shellPath, kind: shell.kind }), shell.env, timeoutMs)
    const ready = result.exitCode === 0 && result.stdout.includes(marker) && !result.timedOut
    if (ready) return {
      ready,
      version: result.stdout.split(/\r?\n/).find((line) => !!line.trim() && !line.includes(marker))?.trim(),
    }
    return {
      ready,
      reason: result.timedOut ? 'shell 自检超时。' : result.stderr || 'shell 的 UTF-8 自检没通过。',
    }
  }

  /** 以受管子进程跑一条短命令，限时采集输出（stdout 最多 64K、stderr 最多 8K 字符）；清理没做完时退出码按未知处理。 */
  private async capture(spec: CommandSpec, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{
    exitCode: Nullable<number>; stdout: string; stderr: string; timedOut: boolean
  }> {
    const ownedSpec = buildOwnedProcessSpec(spec, { env })
    const child = spawn(ownedSpec.spec.file, ownedSpec.spec.args, {
      env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      detached: process.platform !== 'win32',
      windowsVerbatimArguments: ownedSpec.ownership.backend === 'process-tree' && spec.windowsVerbatimArguments,
    })
    const managed = this.processes.manage(child, {
      timeoutMs,
      drainTimeoutMs: ShellTuning.shell.captureDrainTimeoutMs,
      terminateGraceMs: ShellTuning.shell.captureTerminateGraceMs,
      terminationDeadlineMs: ShellTuning.shell.captureTerminationDeadlineMs,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (value: string) => { stdout = (stdout + value).slice(0, ShellTuning.shell.captureStdoutChars) })
    child.stderr.on('data', (value: string) => { stderr = (stderr + value).slice(0, ShellTuning.shell.captureStderrChars) })
    const result = await managed.completion
    return {
      exitCode: result.cleanupIncomplete ? null : result.exitCode,
      stdout, stderr: result.spawnError?.message ?? stderr,
      timedOut: result.timedOut || result.cleanupIncomplete,
    }
  }
}

/** 整个进程只有一份的 shell 选择器。 */
export const shellResolver: ShellResolverApi = new ShellResolver(shellProcessManager)
