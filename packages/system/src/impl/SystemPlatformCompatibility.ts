/**
 * 跨平台兼容层：`SystemPlatformCompatibility` 与按当前进程创建的 `currentSystemPlatform`。
 * 接口见 `interface/provides.ts` 的 `SystemPlatformCompatibilityApi`。不 import 任何 Node 模块，渲染进程也会加载。
 */

import { isEmpty, isPlainObject } from '@velaros-ai/core'

import type { BackgroundShellLaunchOptions, CommandSpec, DefaultAppDataPathOptions, DirectorySymlinkType, EditorCommandDefinition, PathTextSeparator, RuntimePlatform, ShellCommandSpecOptions, SystemPlatformCompatibilityOptions } from '../contract/platform.js'
import type { SystemShellKind } from '../contract/system.js'
import type { SystemPlatformCompatibilityApi } from '../interface/provides.js'
import {
  buildShellCommandSpec,
  buildWindowsExecutableCandidates,
  buildWindowsPowerShellCommandSpec,
  getSystemShellKind,
  isPathTextSeparator,
  isWindowsAbsolutePathText,
  preferredPosixShellPath,
  quotePosixSingle,
  quoteShellArgument,
  readCurrentProcess,
  readPathEnvironmentValue,
  stripWrappingPathSeparators,
  WindowsCommandShellPath,
} from '../utils/platform.js'

const UnicodeSpacesPattern = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g


export class SystemPlatformCompatibility implements SystemPlatformCompatibilityApi {
  private readonly platform: RuntimePlatform
  private readonly env: NodeJS.ProcessEnv

  constructor(options: SystemPlatformCompatibilityOptions = {}) {
    const currentProcess = readCurrentProcess()
    this.platform = options.platform ?? currentProcess?.platform ?? 'linux'
    this.env = options.env ?? currentProcess?.env ?? {}
  }

  public getPlatform(): RuntimePlatform {
    return this.platform
  }

  public isWindows(): boolean {
    return this.platform === 'win32'
  }

  public isMacOS(): boolean {
    return this.platform === 'darwin'
  }

  public isAbsolutePathText(path: string): boolean {
    const normalized = path.trim()
    return normalized.startsWith('/') || isWindowsAbsolutePathText(normalized)
  }

  public isPathLikeCommand(command: string): boolean {
    return this.isAbsolutePathText(command) || command.includes('/') || command.includes('\\')
  }

  public toPortablePathText(path: string): string {
    return path.replace(/\\/g, '/')
  }

  public trimTrailingPathTextSeparators(path: string): string {
    const trimmed = path.trim()
    if (!trimmed) return ''
    let end = trimmed.length
    while (end > 0 && isPathTextSeparator(trimmed[end - 1])) end -= 1
    if (end === 0) return trimmed[0] === '\\' ? '\\' : '/'
    return trimmed.slice(0, end)
  }

  public stripLeadingPathTextSeparators(path: string): string {
    let start = 0
    while (isPathTextSeparator(path[start])) start += 1
    return path.slice(start)
  }

  public normalizePathTextForComparison(path: string): string {
    return this.trimTrailingPathTextSeparators(this.toPortablePathText(path.trim()))
  }

  public splitPathTextSegments(path: string): string[] {
    return this.normalizePathTextForComparison(path).split('/').filter(Boolean)
  }

  public getPathTextBaseName(path: string): string {
    const normalizedPath = this.normalizePathTextForComparison(path)
    const segments = normalizedPath.split('/').filter(Boolean)
    return segments.at(-1) ?? normalizedPath
  }

  public choosePathTextSeparator(path: string): PathTextSeparator {
    return path.includes('\\') && !path.includes('/') ? '\\' : '/'
  }

  public joinPathText(rootPath: string, ...segments: string[]): string {
    const root = this.trimTrailingPathTextSeparators(rootPath)
    const separator = this.choosePathTextSeparator(rootPath)
    const suffix = segments
      .map((segment) => stripWrappingPathSeparators(segment.trim()).replace(/[\\/]+/g, separator))
      .filter(Boolean)
      .join(separator)

    return suffix ? `${root}${separator}${suffix}` : root
  }

  public normalizeUserPathInput(inputPath: string, homeDir?: string): string {
    const normalizedPath = inputPath.replace(UnicodeSpacesPattern, ' ').replace(/^@/, '')
    const normalizedHome = homeDir?.trim()
    if (!normalizedHome) return normalizedPath
    if (normalizedPath === '~') return normalizedHome
    if (/^~[\\/]/.test(normalizedPath))
      return this.joinPathText(normalizedHome, normalizedPath.slice(2))
    return normalizedPath
  }

  public getPathEntries(env: NodeJS.ProcessEnv = this.env): string[] {
    const delimiter = this.isWindows() ? ';' : ':'
    return readPathEnvironmentValue(env)
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
  }

  public buildExecutableCandidates(
    commandName: string,
    env: NodeJS.ProcessEnv = this.env
  ): string[] {
    return this.isWindows()
      ? buildWindowsExecutableCandidates(commandName, env.PATHEXT)
      : [commandName]
  }

  public getShellCommandSpec(command: string, options: ShellCommandSpecOptions = {}): CommandSpec {
    const file = options.shellPath || this.getPreferredShellPath(options.env)
    return buildShellCommandSpec(command, file, options.kind ?? getSystemShellKind(file))
  }

  public getShellKind(shellPath: string): SystemShellKind {
    return getSystemShellKind(shellPath)
  }

  public getPreferredShellPath(env: NodeJS.ProcessEnv = this.env): string {
    if (!this.isWindows()) return preferredPosixShellPath(this.platform, env)
    return Object.entries(env).find(([key]) => key.toUpperCase() === 'VELAROS_SHELL_PATH')?.[1]
      || Object.entries(env).find(([key]) => key.toUpperCase() === 'VELAROS_GIT_BASH')?.[1]
      || WindowsCommandShellPath
  }

  public getInteractiveShellArgs(options: ShellCommandSpecOptions = {}): string[] {
    const kind = options.kind ?? getSystemShellKind(options.shellPath || this.getPreferredShellPath(options.env))
    if (kind === 'git-bash') return ['--noprofile', '--norc', '-i']
    if (kind === 'pwsh' || kind === 'powershell') return ['-NoLogo', '-NoProfile']
    return kind === 'cmd' ? ['/d', '/v:off'] : ['-l']
  }

  public getLoginShellCandidates(env: NodeJS.ProcessEnv = this.env): string[] {
    if (this.isWindows()) return []
    return [env.SHELL, '/bin/zsh', '/bin/bash'].filter(
      (value, index, values): value is string => !!value && values.indexOf(value) === index
    )
  }

  public quoteShellArg(value: string, options: ShellCommandSpecOptions = {}): string {
    return quoteShellArgument(value, options.kind ?? getSystemShellKind(options.shellPath || this.getPreferredShellPath(options.env)))
  }

  public getDefaultInspectableCommands(): string[] {
    const defaults = ['git', 'gh', 'rg', 'python3', 'pip', 'node']
    if (this.isMacOS()) return [...defaults, 'brew']
    if (this.isWindows()) return [...defaults, 'winget', 'choco', 'scoop']
    if (this.platform === 'linux') return [...defaults, 'apt', 'apt-get', 'dnf', 'pacman']
    return defaults
  }

  public shouldUseDetachedProcessGroup(): boolean {
    return !this.isWindows()
  }

  public getProcessKillPid(pid: number): number {
    return this.isWindows() ? pid : -pid
  }

  /** Node 通常把 ESRCH 放在 code 上，少数宿主和测试替身只留下正负 errno 3；统一在这里认，调用方不各自解释进程竞态。 */
  public isProcessMissingError(error: unknown): boolean {
    if (!isPlainObject(error)) return false
    return error.code === 'ESRCH' || error.errno === 3 || error.errno === -3
  }

  public getTerminateCommand(pid: number, force = false, options: ShellCommandSpecOptions = {}): Nullable<string> {
    if (this.isWindows()) {
      const kind = options.kind ?? getSystemShellKind(options.shellPath || this.getPreferredShellPath(options.env))
      return `${kind === 'git-bash' ? 'MSYS_NO_PATHCONV=1 ' : ''}taskkill.exe /PID ${pid} /T${force ? ' /F' : ''}`
    }
    return force ? `kill -KILL ${pid}` : `kill -TERM ${pid}`
  }

  public getFallbackTerminateCommand(command: string): Nullable<string> {
    if (this.isWindows()) return null
    const normalized = command.replace(/\s+/g, ' ').trim().slice(0, 120)
    return normalized ? `pkill -f ${quotePosixSingle(normalized)}` : null
  }

  public getProcessTreeKillCommandSpec(pid: number, signal: NodeJS.Signals): Nullable<CommandSpec> {
    if (!this.isWindows() || !Number.isInteger(pid) || pid <= 0) return null
    return {
      file: 'taskkill',
      args: ['/PID', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])],
    }
  }

  public getBackgroundShellLaunchCommand(options: BackgroundShellLaunchOptions): Nullable<string> {
    if (this.isWindows()) return options.command
    const quotedShell = quotePosixSingle(options.shellPath)
    const quotedLogPath = quotePosixSingle(options.logPath)
    const quotedCommand = quotePosixSingle(`exec ${options.command}`)
    return `nohup ${quotedShell} -lc ${quotedCommand} >> ${quotedLogPath} 2>&1 & printf "${options.pidMarker}%s\\n" "$!"`
  }

  public getProcessListCommandSpec(): Nullable<CommandSpec> {
    if (this.isWindows())
      return { file: 'tasklist.exe', args: ['/FO', 'CSV', '/NH'] }
    return {
      file: 'ps',
      args: ['-axo', 'pid=,ppid=,user=,lstart=,stat=,%cpu=,rss=,ucomm=,command='],
    }
  }

  public getOpenPortInspectionCommandSpec(): Nullable<CommandSpec> {
    if (this.isWindows())
      return { file: 'netstat.exe', args: ['-ano', '-p', 'tcp'] }
    return { file: 'lsof', args: ['-nP', '-iTCP', '-sTCP:LISTEN', '-FpcnT'] }
  }

  public getCpuUsageCommandSpec(): Nullable<CommandSpec> {
    if (this.isMacOS()) return { file: 'top', args: ['-l', '1', '-n', '0'] }
    if (this.platform === 'linux') return { file: 'cat', args: ['/proc/stat'] }
    return this.isWindows()
      ? buildWindowsPowerShellCommandSpec(
          "(Get-Counter '\\Processor(_Total)\\% Processor Time').CounterSamples.CookedValue"
        )
      : null
  }

  public getSwapStatsCommandSpec(): Nullable<CommandSpec> {
    if (this.isMacOS()) return { file: 'sysctl', args: ['vm.swapusage'] }
    if (this.platform === 'linux') return { file: 'cat', args: ['/proc/meminfo'] }
    return this.isWindows()
      ? buildWindowsPowerShellCommandSpec(
          '$os = Get-CimInstance Win32_OperatingSystem; $total = [int64]$os.TotalVirtualMemorySize * 1024; $free = [int64]$os.FreeVirtualMemory * 1024; Write-Output ("{0}`t{1}" -f ($total - $free), $total)'
        )
      : null
  }

  public getDiskStatsCommandSpec(): Nullable<CommandSpec> {
    if (this.isWindows())
      return buildWindowsPowerShellCommandSpec(
        '$drive = $env:SystemDrive; if (-not $drive) { $drive = \'C:\' }; $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'$drive\'"; if ($disk) { Write-Output ("{0}`t{1}" -f ([int64]($disk.Size - $disk.FreeSpace)), [int64]$disk.Size) }'
      )
    return { file: 'df', args: ['-kP', '/'] }
  }

  public getOpenExternalFallbackSpec(target: string): CommandSpec {
    if (this.isMacOS()) return { file: 'open', args: [target] }
    if (this.isWindows())
      return {
        file: WindowsCommandShellPath,
        args: ['/c', 'start', '', target],
      }
    return { file: 'xdg-open', args: [target] }
  }

  public getOpenApplicationCommandSpec(
    application: string,
    args: string[] = [],
    targetPath?: string
  ): CommandSpec {
    if (this.isMacOS())
      return {
        file: 'open',
        args: [
          '-a',
          application,
          ...(targetPath ? [targetPath] : []),
          ...(!isEmpty(args) ? ['--args', ...args] : []),
        ],
      }
    if (this.isWindows())
      return {
        file: WindowsCommandShellPath,
        args: ['/c', 'start', '', application, ...(targetPath ? [targetPath] : []), ...args],
      }
    return {
      file: application,
      args: [...(targetPath ? [targetPath] : []), ...args],
    }
  }

  public getOpenPathWithEditorCommandSpec(
    path: string,
    editor: EditorCommandDefinition
  ): Nullable<CommandSpec> {
    if (this.isMacOS() && editor.darwinApplication)
      return {
        file: 'open',
        args: ['-a', editor.darwinApplication, path],
      }
    if (editor.command) return { file: editor.command, args: [path] }
    return null
  }

  public getDefaultAppDataPath(appName: string, options: DefaultAppDataPathOptions = {}): string {
    const env = options.env ?? this.env
    const homeDir = options.homeDir?.trim()

    if (this.isWindows()) {
      const root =
        env.APPDATA?.trim() || (homeDir ? this.joinPathText(homeDir, 'AppData', 'Roaming') : '')
      return root ? this.joinPathText(root, appName) : appName
    }
    if (this.isMacOS())
      return homeDir
        ? this.joinPathText(homeDir, 'Library', 'Application Support', appName)
        : appName
    const root =
      env.XDG_CONFIG_HOME?.trim() || (homeDir ? this.joinPathText(homeDir, '.config') : '')
    return root ? this.joinPathText(root, appName) : appName
  }

  public getDirectorySymlinkType(): DirectorySymlinkType {
    return this.isWindows() ? 'junction' : 'dir'
  }

  public handleAllWindowsClosed(quit: () => void): void {
    if (!this.isMacOS()) quit()
  }
}

/** 按指定的平台与环境变量创建一份兼容层；什么都不指定时和 `currentSystemPlatform` 一样按当前进程回答。 */
export function createSystemPlatform(options: SystemPlatformCompatibilityOptions = {}): SystemPlatformCompatibilityApi {
  return new SystemPlatformCompatibility(options)
}

/** 按当前进程的平台与环境变量创建的一份，产品壳和本包直接用它。 */
export const currentSystemPlatform: SystemPlatformCompatibilityApi = new SystemPlatformCompatibility()
