/**
 * 产品面：本包交给外面的整件能力，每一件是一个接口。对外入口导出的值，类型只能是这里的接口或上游包的接口。
 * 实现都在 impl/，外面只拿到接口、看不到类；这里的每个接口都必须从根入口导出。
 */

import type { AgentModManifest, ToolCategoryDefinition } from '@velaros-ai/agent/protocol'
import type { ToolPermission } from '@velaros-ai/agent/protocol'
import type { ToolContractRuntimeSpec } from '@velaros-ai/agent/tool-contract'
import type { KernelCallableCapabilityService } from '@velaros-ai/kernel/contracts/abi'

import type { SystemCommandExecutionPlan } from '../contract/commands.js'
import type { VelarOSSharedResourceStoreOptions } from '../contract/platform.js'
import type { BackgroundShellLaunchOptions, CommandSpec, DefaultAppDataPathOptions, DirectorySymlinkType, EditorCommandDefinition, PathTextSeparator, RuntimePlatform, ShellCommandSpecOptions } from '../contract/platform.js'
import type { SystemBackgroundTaskTerminateRequest, SystemBackgroundTaskTerminateResult, SystemGlobalSearchOptions, SystemGlobalSearchResult, SystemOpenPortInfo, SystemOpenPortQueryOptions, SystemProcessInfo, SystemProcessQueryOptions } from '../contract/system.js'
import type { SystemModId, SystemShellKind, SystemToolCategoryId, SystemToolName } from '../contract/system.js'
import type { SystemCommandRunQueryOptions, SystemCommandRunRecord, SystemEnvironmentInspection, SystemMetricsSnapshot } from '../contract/system.js'

import type { SystemToolContext, SystemToolSystemApi } from './requires.js'

// ── 工具 ────────────────────────────────────────────────────────

/** 一个系统工具的运行时规格：模型看到的信息面、入参 schema、权限、能力声明和 execute；上下文固定是宿主注入的 `SystemToolContext`。 */
export type VelaTool<TInput extends Record<string, unknown> = Record<string, unknown>> =
  ToolContractRuntimeSpec<TInput, SystemToolContext, unknown, ToolPermission>

/**
 * 系统空间的六个模型面工具，按工具名索引，实例是 `systemTools`。
 * 集合层面不区分各工具的入参类型：宿主拿模型给的入参先用该工具的 schema 严格校验，再调它的 execute。
 */

export type SystemToolCollection = Readonly<Record<SystemToolName, VelaTool<any>>>

/**
 * 系统空间作为官方内置 mod 的定义，由 `createSystemBundledModDefinition()` 创建。
 * 产品壳的 mod 加载器按它把系统空间挂进来：清单声明工具、类别和空间，绑定里是六个工具与两个类别的实物。
 */
export interface SystemBundledModDefinition {
  /** mod 身份，固定是 `velaros.system`。 */
  readonly id: typeof SystemModId
  /** 加载器用的定位串，形如 `bundled:velaros.system`。 */
  readonly specifier: string
  /** 内置 mod 默认启用。 */
  readonly defaultEnabled: true
  /** mod 清单：版本、发布者、需要的能力轴，以及贡献的工具、工具类别和系统空间。 */
  readonly manifest: AgentModManifest
  /** 清单里声明的东西对应的实物。 */
  readonly bindings: {
    /** 六个工具。 */
    readonly tools: SystemToolCollection
    /** 两个工具类别：文件、执行。 */
    readonly toolCategories: Readonly<Record<SystemToolCategoryId, ToolCategoryDefinition>>
  }
}

/**
 * 系统能力服务：本包作为内核模块激活后登记的服务，身份令牌是 `SystemCapability`。
 * 宿主通过内核按工具名调用系统工具；每次调用先用 schema 严格解析入参，再向宿主解析一次上下文。
 */
export interface SystemCapabilityService extends KernelCallableCapabilityService {
  /** 六个工具的只读视图，给只想读工具说明的宿主用。 */
  readonly tools: SystemToolCollection
}

// ── 本地内核 ────────────────────────────────────────────────────

/**
 * 本地内核：宿主端口 `ctx.system` 在本机上的实现，产品壳创建一个交给工具用。
 *
 * 实现是 `LocalSystemKernel`，只做转接：命令与后台任务交给命令执行器，搜索交给全局搜索，
 * 进程、端口、指标跑平台命令读出来。相对路径都相对构造时给的 cwd，`~` 展开到家目录。
 * 宿主端口本身的方法见 `requires.ts` 的 `SystemToolSystemApi`；这里另给产品壳八个方法：环境检查、指标、运行记录、释放，
 * 以及全局搜索、进程、端口、终止后台任务。后四个工具不再用（模型改用 `system:run` 跑系统命令），宿主自己的界面还要。由 `createLocalSystemKernel(options)` 创建。
 */
export interface LocalSystemKernelApi extends SystemToolSystemApi {
  /** 环境检查：操作系统、经过自检的 shell 和它的 PATH，以及给定的每个命令在不在、在哪。 */
  inspectEnvironment(commands?: string[]): Promise<SystemEnvironmentInspection>
  /** 系统指标快照：CPU、内存、交换区、系统盘、负载各自的用量和告警级别，外加占用最高的 5 个进程；读不到的项为 null。 */
  getSystemMetrics(): Promise<SystemMetricsSnapshot>
  /** 命令执行记录。本地内核不留记录，总是返回空列表；留给会记录的宿主去实现。 */
  listCommandRuns(options?: SystemCommandRunQueryOptions): SystemCommandRunRecord[]
  /** 释放：停掉这个内核启动过、还没退出的全部后台进程。 */
  dispose(): Promise<void>
  /** 在一棵目录树里按路径名或文件内容搜索，跳过隐藏项、依赖目录、gitignore 忽略项和受保护目录，最多 limit 条。 */
  globalSearch(options: SystemGlobalSearchOptions, abortSignal?: AbortSignal): Promise<SystemGlobalSearchResult>
  /** 列出本机进程（名称、命令行、用户、CPU、内存），可按 pid、名字、命令行片段、用户、资源占用筛选，最多 limit 条（默认 50）。 */
  listProcesses(options?: SystemProcessQueryOptions): Promise<SystemProcessInfo[]>
  /** 列出正在监听的 TCP 端口和占用它们的进程，可按端口、端口范围、进程筛选，最多 limit 条（默认 50）。 */
  listOpenPorts(options?: SystemOpenPortQueryOptions): Promise<SystemOpenPortInfo[]>
  /** 终止一个后台任务：核对任务存在、属于请求里的会话、进程确实是自己启动的那个，再发信号并等它退出；返回终止前后的状态。 */
  terminateBackgroundTask(request: SystemBackgroundTaskTerminateRequest): Promise<SystemBackgroundTaskTerminateResult>
}

// ── 命令策略 ────────────────────────────────────────────────────

/**
 * 执行前给 shell 命令分类的判定，实例是 `systemCommandPolicy`。`system:run` 用的就是这一份，宿主做审批界面、无人值守放行时也用它，保证判定一致。
 *
 * 只读判定是白名单加整体否决：命令名不在只读名单、或出现重定向、子 shell、后台符、换行，整条判非只读。
 * 危险判定是黑名单：递归删除、丢弃未提交改动的 Git 操作、mkfs、dd、shutdown、sudo 等；漏判只是少弹一次确认，真正的授权门在宿主的审批端口。
 */
export interface SystemCommandPolicyApi {
  /** 给一条命令做执行前分类：是否只读、是否危险及原因、是否该转入后台及原因、是否要用户确认，以及命令里可能占用的端口。 */
  analyze(command: string): SystemCommandExecutionPlan
  /** 这条命令是否在任何参数组合下都不写东西；判成只读的命令才允许和别的命令并发执行。 */
  isReadOnly(command: string): boolean
}

// ── 跨平台兼容层 ────────────────────────────────────────────────

/**
 * 跨平台兼容层：同一个问题按平台给出统一答案——路径文本怎么比、shell 怎么调、进程怎么查怎么杀、应用和数据目录在哪。
 *
 * `currentSystemPlatform` 是按当前进程创建的一份，要按别的平台或环境变量回答时用 `createSystemPlatform(options)`。产品壳和本包都用它，不自己再判断平台。
 * 构造时可以指定平台和环境变量，在一台机器上算出另一个平台的答案。只算文本和命令规格，不读写磁盘、不启动进程，渲染进程也能用。
 */
export interface SystemPlatformCompatibilityApi {
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
  getShellKind(shellPath: string): SystemShellKind
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
