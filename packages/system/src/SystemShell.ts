import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { win32 } from 'node:path'

import { isPlainObject, isString, Log, optionalWhen, toNullable, toOptional } from '@velaros-ai/core'

import type {
  SystemEnvironmentCommandAvailability,
  SystemShellDescriptor, SystemShellKind, SystemShellRecommendation,
} from './SystemContracts'
import {
  type CommandSpec,
  getSystemShellKind,
  type ShellCommandSpecOptions,
  SystemPlatformCompatibility,
  SystemShellUnavailableError,
} from './SystemPlatformCompatibility'
import { buildSystemOwnedProcessSpec } from './SystemProcessHost'
import { manageSystemProcess } from './SystemProcessLifecycle'

export interface ResolveSystemShellOptions extends ShellCommandSpecOptions {
  /** Injectable filesystem probe for hosts and platform-independent verification. */
  isFile?: (path: string) => boolean
  timeoutMs?: number
  probe?: (shell: ResolvedSystemShell, timeoutMs: number) => Promise<SystemShellProbeResult>
}

export interface ResolvedSystemShell extends SystemShellDescriptor {
  env: NodeJS.ProcessEnv
}

export interface SystemShellProbeResult {
  ready: boolean
  version?: string
  reason?: string
}

const shellNames: Record<SystemShellKind, string> = {
  'git-bash': 'Git Bash', pwsh: 'PowerShell 7', powershell: 'Windows PowerShell',
  cmd: 'CMD', posix: 'POSIX shell',
}
const gitRecommendation: SystemShellRecommendation = {
  code: 'INSTALL_GIT_BASH',
  message: '推荐安装 Git for Windows，以获得 Git Bash 和一致的 Unix 命令工具。',
  url: 'https://git-scm.com/download/win',
}
const log = Log.tag('SystemShell')

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch (error) {
    // 路径缺失或暂不可读时跳过该候选，继续检查其他可用 Shell。
    log.debug('shell candidate unavailable', { path, error })
    return false
  }
}

function readWindowsEnv(env: NodeJS.ProcessEnv, name: string): LooseOptional<string> {
  return Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
}

function isAbsoluteWindowsPath(path: string): boolean {
  return win32.isAbsolute(path) && (/^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\'))
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (readWindowsEnv(env, 'PATH') ?? '')
    .split(';')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
}

function normalizeWindowsPath(path: string): string {
  return win32.normalize(path.trim().replace(/^"(.*)"$/, '$1'))
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  return paths.filter((path) => {
    const key = normalizeWindowsPath(path).replace(/[\\/]+$/, '').toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function gitRootForBash(shellPath: string, isFile: (path: string) => boolean): LooseOptional<string> {
  if (!isAbsoluteWindowsPath(shellPath) || win32.basename(shellPath).toLowerCase() !== 'bash.exe')
    return undefined
  const binDir = win32.dirname(shellPath)
  if (win32.basename(binDir).toLowerCase() !== 'bin') return undefined
  const parent = win32.dirname(binDir)
  const roots = win32.basename(parent).toLowerCase() === 'usr'
    ? [parent, win32.dirname(parent)] : [parent]
  // Git for Windows 安装目录应同时包含启动器与 MSYS 运行时。
  // 由此排除 Windows 的 WSL bash.exe 和无关的独立 Bash 安装。
  if (!isFile(shellPath)) return undefined
  return roots.find((root) => isFile(win32.join(root, 'git-bash.exe')) &&
    isFile(win32.join(root, 'usr', 'bin', 'msys-2.0.dll')) &&
    ['cmd', 'bin', 'mingw64\\bin', 'mingw32\\bin']
      .some((directory) => isFile(win32.join(root, directory, 'git.exe'))))
}

function gitBashCandidates(env: NodeJS.ProcessEnv, isFile: (path: string) => boolean): string[] {
  const programRoots = [
    readWindowsEnv(env, 'ProgramW6432'),
    readWindowsEnv(env, 'ProgramFiles'),
    readWindowsEnv(env, 'ProgramFiles(x86)'),
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].filter((path): path is string => !!path && isAbsoluteWindowsPath(path))
  const roots = programRoots.map((path) => win32.join(path, 'Git'))
  const localAppData = readWindowsEnv(env, 'LOCALAPPDATA')
  if (localAppData && isAbsoluteWindowsPath(localAppData)) {
    roots.push(win32.join(localAppData, 'Programs', 'Git'), win32.join(localAppData, 'Git'))
  }
  const candidates = roots.map((root) => win32.join(root, 'bin', 'bash.exe'))
  for (const entry of pathEntries(env)) {
    if (!isAbsoluteWindowsPath(entry)) continue
    candidates.push(win32.join(entry, 'bash.exe'))
    if (isFile(win32.join(entry, 'git.exe'))) {
      // Git 可以通过 cmd、bin、mingw64/bin 或 mingw32/bin 目录加入 PATH。
      candidates.push(
        win32.join(entry, '..', 'bin', 'bash.exe'),
        win32.join(entry, '..', '..', 'bin', 'bash.exe')
      )
    }
  }
  return uniquePaths(candidates)
}

function gitBashEnvironment(
  env: NodeJS.ProcessEnv,
  shellPath: string,
  root: string,
  isFile: (path: string) => boolean
): NodeJS.ProcessEnv {
  const result = { ...env }
  const replacedKeys = new Set([
    'PATH', 'LANG', 'LC_ALL', 'SHELL', 'VELAROS_GIT_BASH', 'BASH_ENV', 'ENV',
    'PYTHONIOENCODING', 'PYTHONUTF8',
    'MSYS_NO_PATHCONV', 'MSYS2_ARG_CONV_EXCL', 'MSYS2_ENV_CONV_EXCL',
  ])
  for (const key of Object.keys(result)) {
    if (replacedKeys.has(key.toUpperCase())) delete result[key]
  }
  const gitPath = [win32.join(root, 'usr', 'bin')]
  for (const arch of ['mingw64', 'mingw32']) {
    if (isFile(win32.join(root, arch, 'bin', 'git.exe'))) gitPath.push(win32.join(root, arch, 'bin'))
  }
  gitPath.push(win32.join(root, 'bin'), win32.join(root, 'cmd'))
  return {
    ...result,
    PATH: uniquePaths([...gitPath, ...pathEntries(env)]).join(';'),
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    SHELL: shellPath,
  }
}

function windowsCandidates(env: NodeJS.ProcessEnv, isFile: (path: string) => boolean): string[] {
  const configuredGit = readWindowsEnv(env, 'VELAROS_GIT_BASH')?.trim()
  const candidates = [
    ...(configuredGit ? [normalizeWindowsPath(configuredGit)] : []),
    ...gitBashCandidates(env, isFile),
  ]
  const programFiles = readWindowsEnv(env, 'ProgramFiles') || 'C:\\Program Files'
  candidates.push(win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'))
  for (const entry of pathEntries(env)) {
    if (isAbsoluteWindowsPath(entry)) candidates.push(win32.join(entry, 'pwsh.exe'))
  }
  const windowsRoot = readWindowsEnv(env, 'SystemRoot') || readWindowsEnv(env, 'WINDIR') || 'C:\\Windows'
  candidates.push(win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  candidates.push(win32.join(windowsRoot, 'System32', 'cmd.exe'))
  return uniquePaths(candidates)
}

function describeShell(shellPath: string, env: NodeJS.ProcessEnv, isFile: (path: string) => boolean): ResolvedSystemShell {
  const kind = getSystemShellKind(shellPath)
  const gitRoot = kind === 'git-bash' ? gitRootForBash(shellPath, isFile) : undefined
  const shellEnv = gitRoot ? gitBashEnvironment(env, shellPath, gitRoot, isFile) : { ...env }
  if (kind !== 'posix') {
    for (const key of Object.keys(shellEnv)) {
      if (['PYTHONUTF8', 'PYTHONIOENCODING'].includes(key.toUpperCase())) delete shellEnv[key]
    }
    shellEnv.PYTHONUTF8 = '1'
    shellEnv.PYTHONIOENCODING = 'utf-8'
  }
  // Windows 环境变量键不区分大小写，每个受管键只发布一种拼写。
  for (const key of Object.keys(shellEnv)) {
    if (['VELAROS_SHELL_KIND', 'VELAROS_SHELL_PATH', 'VELAROS_SHELL_READINESS', 'VELAROS_SHELL_VERSION']
      .includes(key.toUpperCase())) delete shellEnv[key]
  }
  shellEnv.VELAROS_SHELL_KIND = kind
  shellEnv.VELAROS_SHELL_PATH = shellPath
  shellEnv.VELAROS_SHELL_READINESS = 'detected'
  const args = kind === 'cmd' ? ['/d', '/s', '/v:off', '/c']
    : kind === 'git-bash' ? ['--noprofile', '--norc', '-c']
      : kind === 'posix' ? ['-lc']
        : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']
  return {
    kind, name: shellNames[kind], shellPath, args, env: shellEnv, readiness: 'detected', version: null,
    recommendation: kind === 'cmd' || kind === 'pwsh' || kind === 'powershell' ? { ...gitRecommendation } : null,
  }
}

function detectSystemShells(options: ResolveSystemShellOptions): ResolvedSystemShell[] {
  const env = options.env ?? process.env
  const platform = new SystemPlatformCompatibility({ platform: options.platform, env })
  const isFile = options.isFile ?? isRegularFile
  if (!platform.isWindows()) return [describeShell(options.shellPath || platform.getPreferredShellPath(env), env, isFile)]
  const selected = options.shellPath || readWindowsEnv(env, 'VELAROS_SHELL_PATH')
  const candidates = selected ? [normalizeWindowsPath(selected)] : windowsCandidates(env, isFile)
  const result: ResolvedSystemShell[] = []
  for (const candidate of candidates) {
    if (!isAbsoluteWindowsPath(candidate) || !isFile(candidate)) continue
    const kind = getSystemShellKind(candidate)
    if (kind === 'posix' || (options.kind && kind !== options.kind)) continue
    if (kind === 'git-bash' && !gitRootForBash(candidate, isFile)) continue
    result.push(describeShell(candidate, env, isFile))
  }
  return result
}

/** Synchronous filesystem discovery for UI snapshots; execution should use readiness first. */
export function resolveSystemShell(options: ResolveSystemShellOptions = {}): ResolvedSystemShell {
  const shell = detectSystemShells(options)[0]
  if (!shell) throw new SystemShellUnavailableError()
  return shell
}

async function captureProbe(spec: CommandSpec, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{
  exitCode: Nullable<number>; stdout: string; stderr: string; timedOut: boolean
}> {
  const ownedSpec = buildSystemOwnedProcessSpec(spec, { env })
  const child = spawn(ownedSpec.spec.file, ownedSpec.spec.args, {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    detached: process.platform !== 'win32',
    windowsVerbatimArguments: ownedSpec.ownership.backend === 'process-tree' && spec.windowsVerbatimArguments,
  })
  const managed = manageSystemProcess(child, {
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

async function probeSystemShell(shell: ResolvedSystemShell, timeoutMs: number): Promise<SystemShellProbeResult> {
  const marker = 'VELAROS_SHELL_READY_中文'
  const command = shell.kind === 'cmd' ? `echo ${marker} & ver`
    : shell.kind === 'pwsh' || shell.kind === 'powershell'
      ? `Write-Output '${marker}'; Write-Output $PSVersionTable.PSVersion.ToString()`
      : `printf '${marker}\\n%s\\n' "\${BASH_VERSION:-posix}"`
  const spec = new SystemPlatformCompatibility().getShellCommandSpec(command, shell)
  const result = await captureProbe(spec, shell.env, timeoutMs)
  const ready = result.exitCode === 0 && result.stdout.includes(marker) && !result.timedOut
  return {
    ready,
    ...(ready ? { version: result.stdout.split(/\r?\n/).find((line) => !!line.trim() && !line.includes(marker))?.trim() } : {}),
    ...(!ready ? { reason: result.timedOut ? 'Shell readiness probe timed out.' : result.stderr || 'Shell UTF-8 readiness probe failed.' } : {}),
  }
}

/** Only preflight probes may fall through candidates; user commands are executed exactly once. */
export async function resolveSystemShellReady(options: ResolveSystemShellOptions = {}): Promise<ResolvedSystemShell> {
  const failures: string[] = []
  for (const shell of detectSystemShells(options)) {
    let health: SystemShellProbeResult
    try { health = await (options.probe ?? probeSystemShell)(shell, options.timeoutMs ?? 2_500) }
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

/** Probe using the selected shell's real lookup semantics, including builtins and batch entries. */
export async function resolveSystemCommand(name: string, shell: ResolvedSystemShell): Promise<SystemEnvironmentCommandAvailability> {
  const cmdBuiltins = new Set('assoc break call cd chdir cls color copy date del dir echo endlocal erase exit for ftype goto if md mkdir mklink move path pause popd prompt pushd rd rem ren rename rmdir set setlocal shift start time title type ver verify vol'.split(' '))
  if (shell.kind === 'cmd' && cmdBuiltins.has(name.trim().toLowerCase())) return { name, available: true, path: name.trim(), kind: 'builtin' }
  const platform = new SystemPlatformCompatibility()
  const quoted = platform.quoteShellArg(name.replace(/\\/g, shell.kind === 'git-bash' ? '/' : '\\'), shell)
  // @arch-guard:suspend code-style/require-chinese-comments 理由：下方字符串是发送给各 Shell 的命令，不是说明文案。
  const command = shell.kind === 'cmd' ? `where ${quoted}`
    : shell.kind === 'pwsh' || shell.kind === 'powershell'
      ? `$c = Get-Command -Name ${quoted} -ErrorAction SilentlyContinue; if ($null -eq $c) { exit 1 }; if ($c.Path) { Write-Output $c.Path } else { Write-Output $c.Name }`
      : shell.kind === 'git-bash'
        ? `p=$(command -v ${quoted}) || exit $?; case "$p" in /*) cygpath -w -- "$p" ;; *) printf '%s\\n' "$p" ;; esac`
        : `command -v ${quoted}`
  const result = await captureProbe(platform.getShellCommandSpec(command, shell), shell.env, 2_500)
  const path = result.exitCode === 0 ? result.stdout.trim().split(/\r?\n/)[0] || null : null
  return {
    name, available: !!path, path,
    kind: !path ? null : /\.(?:cmd|bat)$/i.test(path) ? 'batch'
      : /\.(?:exe|com)$/i.test(path) ? 'native' : !/[\\/]/.test(path) ? 'builtin' : 'script',
  }
}

const cmdMetaCharacters = /([()\][%!^"`<>&|;, *?])/g

function escapeCmdArgument(value: string, doubleEscape: boolean): string {
  // Adapted from cross-spawn (MIT): github.com/moxystudio/node-cross-spawn/blob/master/lib/util/escape.js
  const quoted = `"${value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1')}"`
  const escaped = quoted.replace(cmdMetaCharacters, '^$1')
  return doubleEscape ? escaped.replace(cmdMetaCharacters, '^$1') : escaped
}

/** Native argv bypasses MSYS path rewriting; batch entrypoints explicitly use their required interpreter. */
export function buildSystemNativeCommandSpec(
  input: { file: string; args: string[]; env?: NodeJS.ProcessEnv },
  shell: ResolvedSystemShell
): CommandSpec & { env: NodeJS.ProcessEnv } {
  const env = { ...shell.env }
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (shell.kind !== 'posix') for (const previous of Object.keys(env)) {
      if (previous.toUpperCase() === key.toUpperCase()) delete env[previous]
    }
    env[key] = value
  }
  const file = shell.kind !== 'posix' && !win32.extname(input.file) && isRegularFile(`${input.file}.cmd`)
    ? `${input.file}.cmd` : input.file
  if (/\.(?:bat|cmd)$/i.test(file) && shell.kind !== 'posix') {
    const root = readWindowsEnv(env, 'SystemRoot') || 'C:\\Windows'
    const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file)
    const command = [win32.normalize(file).replace(cmdMetaCharacters, '^$1'),
      ...input.args.map((value) => escapeCmdArgument(value, doubleEscape))].join(' ')
    return {
      file: win32.join(root, 'System32', 'cmd.exe'),
      args: ['/d', '/s', '/v:off', '/c', `"chcp 65001 >nul & ${command}"`],
      env, windowsVerbatimArguments: true,
    }
  }
  if (/\.ps1$/i.test(file) && (shell.kind === 'pwsh' || shell.kind === 'powershell')) {
    const compatibility = new SystemPlatformCompatibility()
    const command = `& ${[file, ...input.args].map((arg) => compatibility.quoteShellArg(arg, shell)).join(' ')}`
    return { ...compatibility.getShellCommandSpec(command, shell), env }
  }
  if (shell.kind === 'git-bash' && isRegularFile(file) && !/\.(?:exe|com)$/i.test(file)) return {
      file: shell.shellPath, args: ['--noprofile', '--norc', file.replace(/\\/g, '/'), ...input.args],
      env: { ...env, MSYS2_ARG_CONV_EXCL: '*' },
    }
  return { file, args: [...input.args], env }
}

/** Canonical review text for host-generated native invocations. */
export function describeSystemNativeCommand(input: { file: string; args: string[] }): string {
  return [input.file, ...input.args].map((value) => JSON.stringify(value)).join(' ')
}

export interface RefreshedWindowsEnvironment {
  env: NodeJS.ProcessEnv
  revision: string
  refreshed: boolean
  reason?: string
}

/** Refresh the Windows user/machine environment without blocking the Electron main thread. */
export async function refreshWindowsEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<RefreshedWindowsEnvironment> {
  const result = { ...env }
  for (const key of Object.keys(result)) {
    if (key.toUpperCase().startsWith('VELAROS_SHELL_')) delete result[key]
  }
  let refreshed = platform !== 'win32'
  let reason: LooseOptional<string>
  if (platform === 'win32') {
    const root = readWindowsEnv(env, 'SystemRoot') || 'C:\\Windows'
    const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ` +
      `@{machine=[Environment]::GetEnvironmentVariables('Machine');user=[Environment]::GetEnvironmentVariables('User')} | ConvertTo-Json -Compress`
    const captured = await captureProbe({
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
        reason = error instanceof Error ? error.message : 'Invalid Windows environment snapshot.'
      }
    } else reason = captured.timedOut ? 'Windows environment refresh timed out.' : captured.stderr || 'Windows environment refresh is unavailable.'
  }
  const revision = createHash('sha256').update(JSON.stringify(Object.entries(result).sort())).digest('hex').slice(0, 16)
  return { env: result, revision, refreshed, reason: toOptional(optionalWhen(!!reason, reason)) }
}
