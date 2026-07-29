export type RuntimePlatform = NodeJS.Platform

export interface SystemPlatformCompatibilityOptions {
  env?: NodeJS.ProcessEnv
  platform?: RuntimePlatform
}

export interface ShellCommandSpecOptions extends SystemPlatformCompatibilityOptions {
  shellPath?: string
}

export interface DefaultAppDataPathOptions extends SystemPlatformCompatibilityOptions {
  homeDir?: string
}

export interface CommandSpec {
  file: string
  args: string[]
}

export interface EditorCommandDefinition {
  darwinApplication?: string
  command?: string
}

export interface BackgroundShellLaunchOptions {
  command: string
  logPath: string
  pidMarker: string
  shellPath: string
}

export type PathTextSeparator = '/' | '\\'
export type DirectorySymlinkType = 'dir' | 'junction'

const UnicodeSpacesPattern = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g
const DefaultWindowsExecutableExtensions = ['.EXE', '.CMD', '.BAT', '.COM']

function readCurrentProcess(): {
  platform?: RuntimePlatform
  env?: NodeJS.ProcessEnv
} | null {
  const currentProcess = (
    globalThis as typeof globalThis & {
      process?: { platform?: RuntimePlatform; env?: NodeJS.ProcessEnv }
    }
  ).process

  return currentProcess ?? null
}

/**
 * Cross-platform OS primitives owned by the injected System capability.
 *
 * Product hosts consume this class instead of rediscovering platform behavior
 * or depending on Kernel/Core for concrete operating-system semantics.
 */
export class SystemPlatformCompatibility {
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
    return normalized.startsWith('/') || this.isWindowsAbsolutePathText(normalized)
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
    if (/^[\\/]+$/.test(trimmed)) return trimmed[0] === '\\' ? '\\' : '/'
    return trimmed.replace(/[\\/]+$/g, '')
  }

  public stripLeadingPathTextSeparators(path: string): string {
    return path.replace(/^[\\/]+/g, '')
  }

  public stripWrappingPathTextSeparators(path: string): string {
    return path.replace(/^[\\/]+|[\\/]+$/g, '')
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
      .map((segment) =>
        this.stripWrappingPathTextSeparators(segment.trim()).replace(/[\\/]+/g, separator)
      )
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
    return this.getPathEnvironmentValue(env)
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
  }

  public buildExecutableCandidates(
    commandName: string,
    env: NodeJS.ProcessEnv = this.env
  ): string[] {
    return this.isWindows()
      ? this.buildWindowsExecutableCandidates(commandName, env.PATHEXT)
      : [commandName]
  }

  public getShellCommandSpec(command: string, options: ShellCommandSpecOptions = {}): CommandSpec {
    if (this.isWindows())
      return {
        file: this.getWindowsCommandShell(options.env),
        args: ['/d', '/s', '/c', command],
      }

    return {
      file: options.shellPath || this.getPreferredPosixShellPath(options.env),
      args: ['-lc', command],
    }
  }

  public getPreferredShellPath(env: NodeJS.ProcessEnv = this.env): string {
    return this.isWindows()
      ? this.getWindowsCommandShell(env)
      : this.getPreferredPosixShellPath(env)
  }

  public getInteractiveShellArgs(): string[] {
    return this.isWindows() ? [] : ['-l']
  }

  public getLoginShellCandidates(env: NodeJS.ProcessEnv = this.env): string[] {
    if (this.isWindows()) return []
    return [env.SHELL, '/bin/zsh', '/bin/bash'].filter(
      (value, index, values): value is string => !!value && values.indexOf(value) === index
    )
  }

  public getPreferredPosixShellPath(env: NodeJS.ProcessEnv = this.env): string {
    return env.SHELL || (this.isMacOS() ? '/bin/zsh' : '/bin/sh')
  }

  public shouldUseDetachedProcessGroup(): boolean {
    return !this.isWindows()
  }

  public getProcessKillPid(pid: number): number {
    return this.isWindows() ? pid : -pid
  }

  public getDirectorySymlinkType(): DirectorySymlinkType {
    return this.isWindows() ? 'junction' : 'dir'
  }

  public getElectronExecutableName(): string {
    return this.isWindows() ? 'electron.cmd' : 'electron'
  }

  public getOpenExternalFallbackSpec(
    target: string,
    env: NodeJS.ProcessEnv = this.env
  ): CommandSpec {
    if (this.isMacOS()) return { file: 'open', args: [target] }
    if (this.isWindows())
      return {
        file: this.getWindowsCommandShell(env),
        args: ['/c', 'start', '', target],
      }
    return { file: 'xdg-open', args: [target] }
  }

  public getOpenApplicationCommandSpec(
    application: string,
    args: string[] = [],
    targetPath?: string,
    env: NodeJS.ProcessEnv = this.env
  ): CommandSpec {
    if (this.isMacOS())
      return {
        file: 'open',
        args: [
          '-a',
          application,
          ...(targetPath ? [targetPath] : []),
          ...(args.length > 0 ? ['--args', ...args] : []),
        ],
      }
    if (this.isWindows())
      return {
        file: this.getWindowsCommandShell(env),
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
  ): CommandSpec | null {
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

  public quoteShellArg(value: string): string {
    return this.isWindows() ? `"${value.replace(/"/g, '""')}"` : this.quotePosixSingle(value)
  }

  public getDefaultInspectableCommands(): string[] {
    const defaults = ['git', 'gh', 'rg', 'python3', 'pip', 'node']
    if (this.isMacOS()) return [...defaults, 'brew']
    if (this.isWindows()) return [...defaults, 'winget', 'choco', 'scoop']
    if (this.platform === 'linux') return [...defaults, 'apt', 'apt-get', 'dnf', 'pacman']
    return defaults
  }

  public handleAllWindowsClosed(quit: () => void): void {
    if (!this.isMacOS()) quit()
  }

  public getDarwinApplicationSearchPaths(applicationName: string, homeDir: string): string[] {
    if (!this.isMacOS()) return []
    const bundleName = `${applicationName}.app`
    return [
      this.joinPathText('/Applications', bundleName),
      this.joinPathText(homeDir, 'Applications', bundleName),
      this.joinPathText('/System/Applications', bundleName),
      this.joinPathText('/System/Applications/Utilities', bundleName),
    ]
  }

  public getDarwinApplicationMetadataSearchSpec(bundleName: string): CommandSpec | null {
    return this.isMacOS() ? { file: '/usr/bin/mdfind', args: ['-name', bundleName] } : null
  }

  public getBackgroundShellLaunchCommand(options: BackgroundShellLaunchOptions): string | null {
    if (this.isWindows()) return options.command
    const quotedShell = this.quotePosixSingle(options.shellPath)
    const quotedLogPath = this.quotePosixSingle(options.logPath)
    const quotedCommand = this.quotePosixSingle(`exec ${options.command}`)
    return `nohup ${quotedShell} -lc ${quotedCommand} >> ${quotedLogPath} 2>&1 & printf "${options.pidMarker}%s\\n" "$!"`
  }

  public getTerminateCommand(pid: number, force = false): string | null {
    if (this.isWindows()) return `taskkill /PID ${pid} /T${force ? ' /F' : ''}`
    return force ? `kill -KILL ${pid}` : `kill -TERM ${pid}`
  }

  public getProcessTreeKillCommandSpec(pid: number, signal: NodeJS.Signals): CommandSpec | null {
    if (!this.isWindows() || !Number.isInteger(pid) || pid <= 0) return null
    return {
      file: 'taskkill',
      args: ['/PID', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])],
    }
  }

  public getFallbackTerminateCommand(command: string): string | null {
    if (this.isWindows()) return null
    const normalized = command.replace(/\s+/g, ' ').trim().slice(0, 120)
    return normalized ? `pkill -f ${this.quotePosixSingle(normalized)}` : null
  }

  public getOpenPortInspectionCommandSpec(): CommandSpec | null {
    if (this.isWindows())
      return this.getWindowsPowerShellCommandSpec(
        'Get-NetTCPConnection -State Listen | ForEach-Object { $processName = \'\'; try { $process = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($process) { $processName = $process.ProcessName } } catch {}; Write-Output ("{0}`t{1}`t{2}`t{3}`t{4}" -f $_.OwningProcess, $processName, $_.LocalAddress, $_.LocalPort, $_.State) }'
      )
    return { file: 'lsof', args: ['-nP', '-iTCP', '-sTCP:LISTEN', '-FpcnT'] }
  }

  public getProcessListCommandSpec(): CommandSpec | null {
    if (this.isWindows())
      return this.getWindowsPowerShellCommandSpec(
        "$cpuByPid = @{}; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { if ($_.IDProcess -gt 0) { $cpuByPid[[int]$_.IDProcess] = [double]$_.PercentProcessorTime } }; Get-CimInstance Win32_Process | ForEach-Object { $owner = $_.GetOwner(); $user = if ($owner -and $owner.User) { if ($owner.Domain) { \"$($owner.Domain)\\$($owner.User)\" } else { $owner.User } } else { '' }; $start = if ($_.CreationDate) { [System.Management.ManagementDateTimeConverter]::ToDateTime($_.CreationDate).ToString('o') } else { '' }; $command = if ($_.CommandLine) { ($_.CommandLine -replace \"[`r`n]+\", ' ').Trim() } else { $_.Name }; $state = if ($_.ExecutionState) { [string]$_.ExecutionState } else { 'Running' }; $cpu = if ($cpuByPid.ContainsKey([int]$_.ProcessId)) { $cpuByPid[[int]$_.ProcessId] } else { 0 }; $workingSetKb = [int64](($_.WorkingSetSize) / 1024); Write-Output (\"{0}`t{1}`t{2}`t{3}`t{4}`t{5}`t{6}`t{7}`t{8}\" -f $_.ProcessId, $_.ParentProcessId, $user, $start, $state, $cpu, $workingSetKb, $_.Name, $command) }"
      )
    return {
      file: 'ps',
      args: ['-axo', 'pid=,ppid=,user=,lstart=,stat=,%cpu=,rss=,ucomm=,command='],
    }
  }

  public getProcessStartTimeCommandSpec(pid: number): CommandSpec | null {
    if (!Number.isInteger(pid) || pid <= 0) return null
    if (this.isWindows())
      return this.getWindowsPowerShellCommandSpec(
        `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($process -and $process.CreationDate) { [System.Management.ManagementDateTimeConverter]::ToDateTime($process.CreationDate).ToString('o') }`
      )
    return { file: 'ps', args: ['-p', String(pid), '-o', 'lstart='] }
  }

  public getCpuUsageCommandSpec(): CommandSpec | null {
    if (this.isMacOS()) return { file: 'top', args: ['-l', '1', '-n', '0'] }
    if (this.platform === 'linux') return { file: 'cat', args: ['/proc/stat'] }
    return this.isWindows()
      ? this.getWindowsPowerShellCommandSpec(
          "(Get-Counter '\\Processor(_Total)\\% Processor Time').CounterSamples.CookedValue"
        )
      : null
  }

  public getDarwinCpuUsageCommandSpec(): CommandSpec | null {
    return this.isMacOS() ? this.getCpuUsageCommandSpec() : null
  }

  public getSwapStatsCommandSpec(): CommandSpec | null {
    if (this.isMacOS()) return { file: 'sysctl', args: ['vm.swapusage'] }
    if (this.platform === 'linux') return { file: 'cat', args: ['/proc/meminfo'] }
    return this.isWindows()
      ? this.getWindowsPowerShellCommandSpec(
          '$os = Get-CimInstance Win32_OperatingSystem; $total = [int64]$os.TotalVirtualMemorySize * 1024; $free = [int64]$os.FreeVirtualMemory * 1024; Write-Output ("{0}`t{1}" -f ($total - $free), $total)'
        )
      : null
  }

  public getDiskStatsCommandSpec(): CommandSpec | null {
    if (this.isWindows())
      return this.getWindowsPowerShellCommandSpec(
        '$drive = $env:SystemDrive; if (-not $drive) { $drive = \'C:\' }; $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'$drive\'"; if ($disk) { Write-Output ("{0}`t{1}" -f ([int64]($disk.Size - $disk.FreeSpace)), [int64]$disk.Size) }'
      )
    return { file: 'df', args: ['-kP', '/'] }
  }

  private isWindowsAbsolutePathText(path: string): boolean {
    const normalized = path.trim()
    return normalized.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(normalized)
  }

  private getPathEnvironmentValue(env: NodeJS.ProcessEnv): string {
    return env.PATH ?? env.Path ?? env.path ?? ''
  }

  private getWindowsPathExts(pathExtValue?: string): string[] {
    return (pathExtValue?.trim() || DefaultWindowsExecutableExtensions.join(';'))
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => (value.startsWith('.') ? value : `.${value}`))
  }

  private buildWindowsExecutableCandidates(commandName: string, pathExtValue?: string): string[] {
    const pathExts = this.getWindowsPathExts(pathExtValue)
    const loweredCommand = commandName.toLowerCase()
    if (pathExts.some((ext) => loweredCommand.endsWith(ext.toLowerCase()))) return [commandName]
    return Array.from(new Set([commandName, ...pathExts.map((ext) => `${commandName}${ext}`)]))
  }

  private getWindowsCommandShell(env: NodeJS.ProcessEnv = this.env): string {
    return env.ComSpec ?? env.COMSPEC ?? 'cmd.exe'
  }

  private getWindowsPowerShellCommandSpec(command: string): CommandSpec {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    }
  }

  private quotePosixSingle(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`
  }
}

/**
 * Compatibility helper bound to the current process platform and environment.
 *
 * @deprecated Construct `SystemPlatformCompatibility` with explicit host
 * options when deterministic behavior or multi-host composition is required.
 */
export const systemPlatformCompatibility = new SystemPlatformCompatibility()
