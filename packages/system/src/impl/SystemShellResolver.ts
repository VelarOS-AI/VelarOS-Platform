/**
 * shell 选择与自检：`SystemShellResolver` 与整个进程唯一的 `systemShellResolver`。接口见 `contract/commands.ts`。
 * 不出包；只查文件、不跑进程的部分在 `utils/shell.ts`。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { win32 } from 'node:path'

import { isPlainObject, isString, Log, toNullable } from '@velaros-ai/core'

import type { RefreshedWindowsEnvironment, ResolvedSystemShell, SystemShellProbeResult } from '../contract/commands.js'
import type { CommandSpec } from '../contract/platform.js'
import type { SystemEnvironmentCommandAvailability } from '../contract/system.js'
import type { ResolveSystemShellOptions, SystemProcessManagerApi, SystemShellResolverApi } from '../interface/internal.js'
import { buildShellCommandSpec, quoteShellArgument } from '../utils/platform.js'
import { buildSystemOwnedProcessSpec } from '../utils/process.js'
import { detectSystemShells, readWindowsEnv, uniquePaths } from '../utils/shell.js'

import { systemProcessManager } from './SystemProcessManager.js'
import { SystemShellUnavailableError } from './SystemShellUnavailableError.js'

const log = Log.tag('SystemShell')

/** CMD 的内建命令：它们不是文件，`where` 找不到，要直接认。 */
const CmdBuiltins = new Set('assoc break call cd chdir cls color copy date del dir echo endlocal erase exit for ftype goto if md mkdir mklink move path pause popd prompt pushd rd rem ren rename rmdir set setlocal shift start time title type ver verify vol'.split(' '))

class SystemShellResolver implements SystemShellResolverApi {
  private readonly processes: SystemProcessManagerApi

  constructor(processes: SystemProcessManagerApi) {
    this.processes = processes
  }

  public resolve(options: ResolveSystemShellOptions = {}): ResolvedSystemShell {
    const shell = detectSystemShells(options)[0]
    if (!shell) throw new SystemShellUnavailableError()
    return shell
  }

  public async resolveReady(options: ResolveSystemShellOptions = {}): Promise<ResolvedSystemShell> {
    const failures: string[] = []
    for (const shell of detectSystemShells(options)) {
      let health: SystemShellProbeResult
      try { health = await (options.probe ?? ((candidate, timeoutMs) => this.probe(candidate, timeoutMs)))(shell, options.timeoutMs ?? 2_500) }
      catch (error) {
        log.debug('shell readiness probe failed', { shell: shell.shellPath, error })
        health = { ready: false, reason: error instanceof Error ? error.message : 'Shell startup failed.' }
      }
      if (!health.ready) { failures.push(`${shell.name}: ${health.reason || 'unavailable'}`); continue }
      return {
        ...shell, readiness: 'ready', version: toNullable(health.version),
        env: { ...shell.env, VELAROS_SHELL_READINESS: 'ready', VELAROS_SHELL_VERSION: health.version ?? '' },
      }
    }
    throw new SystemShellUnavailableError(failures.join(' '))
  }

  public async resolveCommand(name: string, shell: ResolvedSystemShell): Promise<SystemEnvironmentCommandAvailability> {
    if (shell.kind === 'cmd' && CmdBuiltins.has(name.trim().toLowerCase())) return { name, available: true, path: name.trim(), kind: 'builtin' }
    const quoted = quoteShellArgument(name.replace(/\\/g, shell.kind === 'git-bash' ? '/' : '\\'), shell.kind)
    // @arch-guard:suspend code-style/require-chinese-comments 理由：下方字符串是发送给各 Shell 的命令，不是说明文案。
    const command = shell.kind === 'cmd' ? `where ${quoted}`
      : shell.kind === 'pwsh' || shell.kind === 'powershell'
        ? `$c = Get-Command -Name ${quoted} -ErrorAction SilentlyContinue; if ($null -eq $c) { exit 1 }; if ($c.Path) { Write-Output $c.Path } else { Write-Output $c.Name }`
        : shell.kind === 'git-bash'
          ? `p=$(command -v ${quoted}) || exit $?; case "$p" in /*) cygpath -w -- "$p" ;; *) printf '%s\\n' "$p" ;; esac`
          : `command -v ${quoted}`
    const result = await this.capture(buildShellCommandSpec(command, shell.shellPath, shell.kind), shell.env, 2_500)
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
      }, env, 3_000)
      if (captured.exitCode === 0) {
        try {
          const source = JSON.parse(captured.stdout) as { machine: Record<string, string>; user: Record<string, string> }
          if (!isPlainObject(source.machine) || !isPlainObject(source.user)) throw new Error('Invalid Windows environment snapshot.')
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
          reason = error instanceof Error && error.message ? error.message : 'Invalid Windows environment snapshot.'
        }
      } else reason = captured.timedOut ? 'Windows environment refresh timed out.' : captured.stderr || 'Windows environment refresh is unavailable.'
    }
    const revision = createHash('sha256').update(JSON.stringify(Object.entries(result).sort())).digest('hex').slice(0, 16)
    return { env: result, revision, refreshed, reason }
  }

  /** 默认的就绪自检：让 shell 打印一个带中文的标记和自己的版本，标记原样回来才算能用。 */
  private async probe(shell: ResolvedSystemShell, timeoutMs: number): Promise<SystemShellProbeResult> {
    const marker = 'VelarOS-shell-ready-中文'
    const command = shell.kind === 'cmd' ? `echo ${marker} & ver`
      : shell.kind === 'pwsh' || shell.kind === 'powershell'
        ? `Write-Output '${marker}'; Write-Output $PSVersionTable.PSVersion.ToString()`
        : `printf '${marker}\\n%s\\n' "\${BASH_VERSION:-posix}"`
    const result = await this.capture(buildShellCommandSpec(command, shell.shellPath, shell.kind), shell.env, timeoutMs)
    const ready = result.exitCode === 0 && result.stdout.includes(marker) && !result.timedOut
    if (ready) return {
      ready,
      version: result.stdout.split(/\r?\n/).find((line) => !!line.trim() && !line.includes(marker))?.trim(),
    }
    return {
      ready,
      reason: result.timedOut ? 'Shell readiness probe timed out.' : result.stderr || 'Shell UTF-8 readiness probe failed.',
    }
  }

  /** 以受管子进程跑一条短命令，限时采集输出（stdout 最多 64K、stderr 最多 8K 字符）；清理没做完时退出码按未知处理。 */
  private async capture(spec: CommandSpec, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{
    exitCode: Nullable<number>; stdout: string; stderr: string; timedOut: boolean
  }> {
    const ownedSpec = buildSystemOwnedProcessSpec(spec, { env })
    const child = spawn(ownedSpec.spec.file, ownedSpec.spec.args, {
      env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      detached: process.platform !== 'win32',
      windowsVerbatimArguments: ownedSpec.ownership.backend === 'process-tree' && spec.windowsVerbatimArguments,
    })
    const managed = this.processes.manage(child, {
      timeoutMs, drainTimeoutMs: 250, terminateGraceMs: 100, terminationDeadlineMs: 1_000,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (value: string) => { stdout = (stdout + value).slice(0, 65_536) })
    child.stderr.on('data', (value: string) => { stderr = (stderr + value).slice(0, 8_192) })
    const result = await managed.completion
    return {
      exitCode: result.cleanupIncomplete ? null : result.exitCode,
      stdout, stderr: result.spawnError?.message ?? stderr,
      timedOut: result.timedOut || result.cleanupIncomplete,
    }
  }
}

/** 整个进程只有一份的 shell 选择器。 */
export const systemShellResolver: SystemShellResolverApi = new SystemShellResolver(systemProcessManager)
