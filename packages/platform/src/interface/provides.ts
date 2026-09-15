/**
 * 产品面：本包交给外面的两件能力，每件一个接口。实现在 impl/，外面只拿到接口、看不到类；这里的每个接口都必须从根入口导出。
 */

import type { DefaultAppDataPathOptions, ShellCommandSpecOptions, VelarOSSharedResourceStoreOptions } from '../contract/options.js'
import type { BackgroundShellLaunchOptions, CommandSpec, DirectorySymlinkType, EditorCommandDefinition, PathTextSeparator, RuntimePlatform, ShellKind } from '../contract/platform.js'

// ── 跨平台兼容层 ────────────────────────────────────────────────

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

// ── 共享资源目录 ────────────────────────────────────────────────

/**
 * VelarOS 产品家族共享资源目录：各产品共用的数据、可重新下载的资源、账号会话放在哪，实例是 `velarosSharedResources`。
 * 只算路径，不建目录、不写盘；只在 Node 里用。
 */
export interface VelarOSSharedResourcesApi {
  /** 共享数据的根目录：按平台放在用户数据目录下的 VelarOS 目录；环境变量 VELAROS_SHARED_DATA_ROOT 可以覆盖。 */
  dataRoot(options?: VelarOSSharedResourceStoreOptions): string
  /** 共享资源目录：「共享数据根/shared/resources」，只放可以重新下载的安装产物。 */
  resourcesRoot(options?: VelarOSSharedResourceStoreOptions): string
  /** 共享账号会话目录：「共享数据根/shared/account/v1」。 */
  accountRoot(options?: VelarOSSharedResourceStoreOptions): string
}
