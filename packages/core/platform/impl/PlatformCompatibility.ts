/**
 * 跨平台兼容层：`PlatformCompatibility`、按当前进程创建的 `currentPlatform` 与工厂 `createPlatform`。接口 `PlatformCompatibilityApi` 在类上方，由 `contract/provides.ts` 登记。
 * 不 import 任何 Node 模块，渲染进程也会加载。
 */

import { isEmpty, isNotNull, isPlainObject } from '@velaros-ai/core'

import type { DefaultAppDataPathOptions, PathTextContainmentOptions, PlatformCompatibilityOptions, ShellCommandSpecOptions } from '../types/options.js'
import type { BackgroundShellLaunchOptions, CommandSpec, DirectorySymlinkType, EditorCommandDefinition, PathTextSeparator, RuntimePlatform, ShellKind } from '../types/platform.js'
import {
  buildShellCommandSpec,
  buildWindowsExecutableCandidates,
  buildWindowsPowerShellCommandSpec,
  getShellKind,
  isPathTextSeparator,
  isWindowsAbsolutePathText,
  preferredPosixShellPath,
  quotePosixSingle,
  quoteShellArgument,
  readCurrentProcess,
  readPathEnvironmentValue,
  splitAbsolutePathText,
  stripWrappingPathSeparators,
  WindowsCommandShellPath,
} from '../utils/platform.js'

/**
 * 跨平台兼容层：同一个问题按平台给出统一答案——路径文本怎么比、shell 怎么调、进程怎么查怎么杀、应用和数据目录在哪。
 *
 * `currentPlatform` 是按当前进程创建的一份，要按别的平台或环境变量回答时用 `createPlatform(options)`。产品壳和本包都用它，不自己再判断平台。
 * 构造时可以指定平台和环境变量，在一台机器上算出另一个平台的答案。只算文本和命令规格，不读写磁盘、不启动进程，渲染进程也能用。
 */
export interface PlatformCompatibilityApi {
  // 平台

  /** 这个实例按哪个平台回答。 */
  getPlatform(): RuntimePlatform
  /** 是否 Windows。 */
  isWindows(): boolean
  /** 是否 macOS。 */
  isMacOS(): boolean

  // 路径文本：只算字符串、不碰磁盘，Windows 与 POSIX 两种写法都认

  /** 是否绝对路径：以 `/` 开头、带盘符（`C:\`）或 UNC（`\\server`）都算。 */
  isAbsolutePathText(path: string): boolean
  /** 命令文本是否像一个路径（绝对路径或含分隔符），而不是要到 PATH 里找的命令名。 */
  isPathLikeCommand(command: string): boolean
  /** 把 `\` 全部换成 `/`。 */
  toPortablePathText(path: string): string
  /** 去掉末尾的分隔符；整串都是分隔符时留下一个。 */
  trimTrailingPathTextSeparators(path: string): string
  /** 去掉开头的分隔符。 */
  stripLeadingPathTextSeparators(path: string): string
  /** 规整成可以直接比较的形式：去掉首尾空白、统一用 `/`、去掉末尾分隔符。 */
  normalizePathTextForComparison(path: string): string
  /** 规整后按 `/` 切成各级名字，空段丢掉。 */
  splitPathTextSegments(path: string): string[]
  /** 取最后一级名字。 */
  getPathTextBaseName(path: string): string
  /** 按路径里已有的写法选分隔符：只出现 `\` 时用 `\`，否则用 `/`。 */
  choosePathTextSeparator(path: string): PathTextSeparator
  /** 拼接路径：沿用根路径的分隔符，各段去掉首尾分隔符后连起来。 */
  joinPathText(rootPath: string, ...segments: string[]): string
  /** 规整用户输入的路径：特殊空格换成普通空格、去掉开头的 `@`、给了 homeDir 时把 `~` 和 `~/…` 展开。 */
  normalizeUserPathInput(inputPath: string, homeDir?: string): string
  /**
   * candidate 是否在 root 之内（含 root 本身）。两边按本实例的平台规整：折叠 `.` 与 `..`、win32 认两种分隔符而其他平台只认 `/`；
   * 大小写按 options（缺省 Windows、macOS 不区分）；任一不是完整的绝对路径返回 false。只算文本，符号链接由调用方先解开。
   */
  isPathTextInside(candidate: string, root: string, options?: PathTextContainmentOptions): boolean
  /** 同 isPathTextInside；在里面时返回相对 root 的路径（各级名字保持 candidate 的写法、用 `/` 连接，root 本身是 `.`），不在返回 null。 */
  relativePathTextInside(candidate: string, root: string, options?: PathTextContainmentOptions): Nullable<string>

  // 可执行文件与 shell

  /** 读出 PATH 里的各个目录：Windows 按 `;` 切，其他平台按 `:` 切。 */
  getPathEntries(env?: NodeJS.ProcessEnv): string[]
  /** 列出一个命令名可能对应的文件名：Windows 按 PATHEXT 补上 `.EXE`、`.CMD` 等后缀，其他平台就是它自己。 */
  buildExecutableCandidates(commandName: string, env?: NodeJS.ProcessEnv): string[]
  /** 生成「用某个 shell 执行一段命令」的启动规格：按 shell 种类（PowerShell / CMD / Git Bash / POSIX）拼参数，统一 UTF-8 输出。没指定 shell 时用默认 shell。 */
  getShellCommandSpec(command: string, options?: ShellCommandSpecOptions): CommandSpec
  /** 根据 shell 可执行文件的路径判断它是哪种 shell：pwsh、powershell、cmd、git-bash 或 posix。 */
  getShellKind(shellPath: string): ShellKind
  /** 默认用哪个 shell：POSIX 取 SHELL（没有时 macOS 用 zsh、其他用 sh）；Windows 依次看 VELAROS_SHELL_PATH、VELAROS_GIT_BASH，最后是系统的 cmd.exe。 */
  getPreferredShellPath(env?: NodeJS.ProcessEnv): string
  /** 以交互方式启动 shell 时带的参数，终端面板用。 */
  getInteractiveShellArgs(options?: ShellCommandSpecOptions): string[]
  /** 登录 shell 的候选：SHELL、zsh、bash，去重；Windows 返回空列表。 */
  getLoginShellCandidates(env?: NodeJS.ProcessEnv): string[]
  /** 按 shell 的规则给一个参数加引号；CMD 下带换行、`%` 这类无法安全转义的字符时抛错，要求改用原生 argv 执行。 */
  quoteShellArg(value: string, options?: ShellCommandSpecOptions): string
  /** 环境检查默认要看的命令：git、gh、rg、python3、pip、node，再加上本平台的包管理器。 */
  getDefaultInspectableCommands(): string[]

  // 进程

  /** 启动子进程时是否放进独立的进程组：POSIX 是，便于整组终止；Windows 否。 */
  shouldUseDetachedProcessGroup(): boolean
  /** 发信号时用的 pid：POSIX 用负数表示整个进程组，Windows 原样返回。 */
  getProcessKillPid(pid: number): number
  /** 这个错误是否表示「目标进程已经不在了」（ESRCH）；终止进程时据此把竞态当成已经退出。 */
  isProcessMissingError(error: unknown): boolean
  /** 给人看的终止命令：Windows 用 taskkill 终止整棵进程树（force 时加 /F），其他平台用 kill -TERM 或 kill -KILL。 */
  getTerminateCommand(pid: number, force?: boolean, options?: ShellCommandSpecOptions): Nullable<string>
  /** 按命令行文本兜底终止的命令（pkill -f，只取命令前 120 个字符）；Windows 没有，返回 null。 */
  getFallbackTerminateCommand(command: string): Nullable<string>
  /** Windows 上终止整棵进程树的 taskkill 启动规格；不是 Windows 或 pid 不合法时返回 null。 */
  getProcessTreeKillCommandSpec(pid: number, signal: NodeJS.Signals): Nullable<CommandSpec>
  /** 在后台启动一条 shell 命令、把输出追加进日志文件并打印 pid 的命令文本（nohup）；Windows 原样返回命令。 */
  getBackgroundShellLaunchCommand(options: BackgroundShellLaunchOptions): Nullable<string>

  // 读系统信息用的平台命令

  /** 列进程的启动规格：Windows 用 tasklist，其他平台用 ps。 */
  getProcessListCommandSpec(): Nullable<CommandSpec>
  /** 列监听中 TCP 端口的启动规格：Windows 用 netstat，其他平台用 lsof。 */
  getOpenPortInspectionCommandSpec(): Nullable<CommandSpec>
  /** 读 CPU 占用的启动规格：macOS 用 top，Linux 读 /proc/stat，Windows 读性能计数器；其他平台返回 null。 */
  getCpuUsageCommandSpec(): Nullable<CommandSpec>
  /** 读交换区用量的启动规格：macOS 用 sysctl，Linux 读 /proc/meminfo，Windows 读 CIM；其他平台返回 null。 */
  getSwapStatsCommandSpec(): Nullable<CommandSpec>
  /** 读系统盘用量的启动规格：Windows 读 CIM，其他平台用 df。 */
  getDiskStatsCommandSpec(): Nullable<CommandSpec>

  // 打开文件与应用、目录约定

  /** 用系统默认方式打开一个路径或网址的启动规格：macOS 用 open，Windows 用 start，Linux 用 xdg-open。 */
  getOpenExternalFallbackSpec(target: string): CommandSpec
  /** 启动一个应用的启动规格，可带要打开的路径和启动参数。 */
  getOpenApplicationCommandSpec(application: string, args?: string[], targetPath?: string): CommandSpec
  /** 用指定编辑器打开路径的启动规格：macOS 优先按应用名打开，否则用编辑器命令；两样都没有时返回 null。 */
  getOpenPathWithEditorCommandSpec(path: string, editor: EditorCommandDefinition): Nullable<CommandSpec>
  /** 应用数据目录的默认位置：Windows 在 APPDATA，macOS 在 ~/Library/Application Support，Linux 在 XDG_CONFIG_HOME 或 ~/.config。 */
  getDefaultAppDataPath(appName: string, options?: DefaultAppDataPathOptions): string
  /** 目录符号链接用哪种类型：Windows 用 junction（不需要管理员权限），其他平台用 dir。 */
  getDirectorySymlinkType(): DirectorySymlinkType
  /** 所有窗口都关掉之后怎么办：macOS 保持应用运行，其他平台调用 quit 退出。 */
  handleAllWindowsClosed(quit: () => void): void
}

export class PlatformCompatibility implements PlatformCompatibilityApi {
  /** 各种 Unicode 空格（不换行空格、窄空格、全角空格等）：规整用户输入的路径时换成普通空格。 */
  private static readonly UnicodeSpacesPattern = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

  private readonly platform: RuntimePlatform
  private readonly env: NodeJS.ProcessEnv

  constructor(options: PlatformCompatibilityOptions = {}) {
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

  public isPathTextInside(candidate: string, root: string, options?: PathTextContainmentOptions): boolean {
    return isNotNull(this.relativePathTextInside(candidate, root, options))
  }

  public relativePathTextInside(candidate: string, root: string, options?: PathTextContainmentOptions): Nullable<string> {
    const target = splitAbsolutePathText(candidate, this.platform)
    const base = splitAbsolutePathText(root, this.platform)
    if (!target || !base || target.segments.length < base.segments.length) return null
    const caseSensitive = options?.caseSensitive ?? !(this.platform === 'win32' || this.platform === 'darwin')
    const same = (left: string, right: string): boolean => (caseSensitive ? left === right : left.toLowerCase() === right.toLowerCase())
    if (!same(target.root, base.root) || base.segments.some((segment, index) => !same(segment, target.segments[index]))) return null
    const rest = target.segments.slice(base.segments.length)
    return isEmpty(rest) ? '.' : rest.join('/')
  }

  public normalizeUserPathInput(inputPath: string, homeDir?: string): string {
    const normalizedPath = inputPath.replace(PlatformCompatibility.UnicodeSpacesPattern, ' ').replace(/^@/, '')
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
    return buildShellCommandSpec(command, file, options.kind ?? getShellKind(file))
  }

  public getShellKind(shellPath: string): ShellKind {
    return getShellKind(shellPath)
  }

  public getPreferredShellPath(env: NodeJS.ProcessEnv = this.env): string {
    if (!this.isWindows()) return preferredPosixShellPath(this.platform, env)
    return Object.entries(env).find(([key]) => key.toUpperCase() === 'VELAROS_SHELL_PATH')?.[1]
      || Object.entries(env).find(([key]) => key.toUpperCase() === 'VELAROS_GIT_BASH')?.[1]
      || WindowsCommandShellPath
  }

  public getInteractiveShellArgs(options: ShellCommandSpecOptions = {}): string[] {
    const kind = options.kind ?? getShellKind(options.shellPath || this.getPreferredShellPath(options.env))
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
    return quoteShellArgument(value, options.kind ?? getShellKind(options.shellPath || this.getPreferredShellPath(options.env)))
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
      const kind = options.kind ?? getShellKind(options.shellPath || this.getPreferredShellPath(options.env))
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

/** 按指定的平台与环境变量创建一份兼容层；什么都不指定时和 `currentPlatform` 一样按当前进程回答。 */
export function createPlatform(options: PlatformCompatibilityOptions = {}): PlatformCompatibilityApi {
  return new PlatformCompatibility(options)
}

/** 按当前进程的平台与环境变量创建的一份，产品壳和本包直接用它。 */
export const currentPlatform: PlatformCompatibilityApi = new PlatformCompatibility()
