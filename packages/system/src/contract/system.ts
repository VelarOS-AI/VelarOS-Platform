/**
 * 可移植数据：工具与 mod 的身份、错误码、环境变量表，以及经过宿主端口流动的全部数据结构（命令、进程与端口、后台任务、搜索、shell 与运行环境）。
 * 本文件不依赖任何别的文件，没有 Node 专属类型，浏览器也能用；`./contracts` 入口就是它。这里的每个类型都被公开接口用到。
 */

// ── 工具身份 ────────────────────────────────────────────────────

/**
 * 模型面工具的 canonical 身份。
 *
 * 工具名统一是 `system:<动作>`，一个工具只属于一个职责类别。这份表是全仓唯一权威：
 * 工具定义、mod 清单、内核模块注册都从这里取名字，不允许在别处再写一遍字符串。
 */

/** 六个系统工具的 canonical 名字。 */
const SystemToolNames = Object.freeze({
  read: 'system:read',
  view: 'system:view',
  edit: 'system:edit',
  run: 'system:run',
  refreshEnvironment: 'system:refresh-environment',
  listTasks: 'system:list-tasks',
} as const)

type SystemToolName = (typeof SystemToolNames)[keyof typeof SystemToolNames]

/** 每个工具所属的唯一职责类别：文件、执行。 */
const SystemToolCategoryByName = Object.freeze({
  [SystemToolNames.read]: 'system-files',
  [SystemToolNames.view]: 'system-files',
  [SystemToolNames.edit]: 'system-files',
  [SystemToolNames.run]: 'system-execution',
  [SystemToolNames.refreshEnvironment]: 'system-execution',
  [SystemToolNames.listTasks]: 'system-execution',
} as const)

type SystemToolCategoryId = (typeof SystemToolCategoryByName)[SystemToolName]

/** 系统空间作为官方内置 mod 的身份。 */
const SystemModId = 'velaros.system' as const

/** 系统空间自己的身份，mod 清单里声明的空间用它。 */
const SystemSpaceId = 'system' as const

export { SystemModId, SystemSpaceId, SystemToolCategoryByName, SystemToolNames }
export type { SystemToolCategoryId, SystemToolName }

// ── 命令：入参、结果、运行记录、输出、验证摘要 ──────────────────

/**
 * 命令执行能力的对外数据类型：怎么发起一次命令、命令结束后能拿到什么、
 * 进程约束的事实如何上报、历史运行记录长什么样。
 *
 * 几条贯穿始终的语义（对应 spec/invariants.md 里的编号）：
 * - 审批事实与约束事实分开记录，谁也不能冒充谁（INV-6）。
 * - 输出窗口只保留末尾，并且末尾永远是真实的（INV-10、INV-17）。
 * - `nativeCommand` 只供宿主组合能力使用，绝不出现在模型工具 schema 里（INV-15）。
 */

/** 一条运行记录的状态。 */
export type SystemCommandRunStatus = 'running' | 'passed' | 'failed' | 'timed-out'

/** 已批准命令在操作系统进程层实际采用的文件副作用边界。 */
export type SystemProcessConfinementMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access'

/** 约束强度。`partial` 只能作为可观测事实，不能被需要绝对边界的调用方当作 `full`。 */
export type SystemProcessConfinementEnforcement = 'none' | 'partial' | 'full'

/** 实际承担约束的后端：macOS 是 Seatbelt，Linux 是 bubblewrap，`host` 表示宿主注入的实现。 */
export type SystemProcessConfinementBackend =
  | 'none'
  | 'bubblewrap'
  | 'seatbelt'
  | 'host'

/**
 * 一次真实进程启动的约束证据。
 *
 * 这是事实不是意愿：请求了 `workspace-write` 但没有后端时，实现必须拒绝执行，
 * 而不是在这里写一个 `enforcement: 'none'` 蒙混过去。
 */
export interface SystemProcessConfinementEvidence {
  mode: SystemProcessConfinementMode
  enforcement: SystemProcessConfinementEnforcement
  backend: SystemProcessConfinementBackend
  reason: string
  /** 受约束模式下真实批准的写根；`danger-full-access` 为空表示不采用 allowlist。 */
  writableRoots: string[]
}

/** 进程归属事实：子进程树由谁负责在父进程退出时清理，以及实际能不能做到。 */
export interface SystemProcessOwnership {
  backend: 'windows-job' | 'process-tree'
  parentDeathCleanup: boolean
  reason: string
}

/** 发起一次命令时的可选项。 */
export interface SystemRunCommandOptions {
  cwd?: string
  timeoutMs?: number
  background?: boolean
  maxOutputChars?: number
  sessionId?: string
  /** 宿主生成的可执行调用；永远不出现在模型工具 schema 中。 */
  nativeCommand?: { file: string; args: string[]; env?: Record<string, string> }
}

/**
 * 命令被送进后台管理时的回执。
 *
 * `statusContinuation` 指向 `system:list-tasks`，因为系统后台任务不归内核 `job:*` 工具管。
 */
export interface SystemBackgroundProcessInfo {
  taskId: Nullable<string>
  sessionId: Nullable<string>
  pid: Nullable<number>
  logPath: Nullable<string>
  ports: number[]
  reason: Nullable<string>
  terminateCommand: Nullable<string>
  forceTerminateCommand: Nullable<string>
  fallbackTerminateCommand: Nullable<string>
  requested: boolean
  autoStarted: boolean
  /** 精确查询该系统后台任务状态；不能交给内核 job:* 工具。 */
  statusContinuation?: {
    tool: 'system:list-tasks'
    args: { taskId: string }
  }
}

/**
 * 对命令结果的一句话判定，给模型当验证摘要用。
 *
 * 成功命令的 stdout / stderr 不会被当作 issue；失败、超时、取消时把输出末尾摘进 issues。
 */
export interface SystemVerificationSummary {
  kind: 'build' | 'lint' | 'test' | 'typecheck' | 'unknown'
  status: 'aborted' | 'failed' | 'passed' | 'timed-out' | 'unknown'
  issues: string[]
}

/** 返回给调用方的输出窗口是怎么截的。 */
export interface SystemCommandOutputWindow {
  /** 返回窗口保留完整输出的末尾，而不是开头。 */
  retained: 'tail'
  /** false 表示整体输出更长；不影响已返回末尾窗口的真实性。 */
  complete: boolean
  /** 进程结束后窗口的末端与完整输出末端一致。 */
  endPreserved: true
}

/** 输出被截断时，去哪里找完整内容。 */
export interface SystemCommandOutputContinuation {
  /** 完整输出由会话内部终端日志管理，不是普通文件。 */
  kind: 'session-terminal-log'
  /** 交给会话终端输出召回能力的稳定查询词。 */
  query: string
  /** 可直接执行的召回工具，避免把系统命令误交给 job:*。 */
  tool: 'context:recall'
  args: { query: string; kind: 'terminal' }
}

/** 命令输出采集事实；字节数按解码后的 UTF-8 文本计算。 */
export interface SystemCommandOutputCapture {
  status: 'complete' | 'truncated' | 'failed'
  encoding: 'utf-8'
  totalBytes: number
  storedBytes: number
  omittedBytes: number
  decodeErrors: number
  error?: string
}

/**
 * 一次命令执行的完整结果。
 *
 * `success` 只看退出码为 0 且没有超时、没有被取消；`truncated` 为 true 时
 * `outputWindow` 与 `outputContinuation` 一定同时给出。
 */
export interface SystemCommandResult {
  command: string
  cwd: string
  exitCode: Nullable<number>
  signal: Nullable<string>
  stdout: string
  stderr: string
  logPath?: string
  durationMs: number
  timedOut: boolean
  aborted: boolean
  truncated: boolean
  capture?: SystemCommandOutputCapture
  shell?: SystemShellDescriptor
  cleanupIncomplete?: boolean
  ownership?: SystemProcessOwnership
  outputWindow?: SystemCommandOutputWindow
  outputContinuation?: SystemCommandOutputContinuation
  success: boolean
  /** 缺席仅用于兼容旧宿主；新执行器必须报告真实的进程约束事实。 */
  confinement?: SystemProcessConfinementEvidence
  backgroundProcess?: SystemBackgroundProcessInfo
  verification: SystemVerificationSummary
}

/** 历史运行记录：与 `SystemCommandResult` 相比只保留预览，不保留完整输出。 */
export interface SystemCommandRunRecord {
  capture?: SystemCommandOutputCapture
  aborted?: boolean
  cleanupIncomplete?: boolean
  ownership?: SystemProcessOwnership
  confinement?: SystemProcessConfinementEvidence
  id: string
  sessionId: Nullable<string>
  command: string
  cwd: string
  startedAt: number
  finishedAt: Nullable<number>
  durationMs: Nullable<number>
  exitCode: Nullable<number>
  signal: Nullable<string>
  timedOut: boolean
  success: boolean
  background: boolean
  pid: Nullable<number>
  logPath: Nullable<string>
  stdoutPreview: string
  stderrPreview: string
  truncated: boolean
  status: SystemCommandRunStatus
  verification: SystemVerificationSummary
}

/** 查询历史运行记录的过滤条件。 */
export interface SystemCommandRunQueryOptions {
  limit?: number
  sessionId?: string
  onlyFailed?: boolean
  background?: boolean
}

// ── 进程、端口与资源快照 ────────────────────────────────────────

/**
 * 进程能力的对外数据结构：进程列表、开放端口、资源快照。本模块自己管理的后台任务在 `background-tasks.ts`。
 *
 * 所有查询都遵守同一条规则：先按 `filter` 对完整命令行做不区分大小写的包含匹配，
 * 再按 `limit` 截断（默认 50）。先截断再过滤会漏掉命中，所以顺序不能反。
 */

/** 目前只报告 TCP 监听端口。 */
export type SystemOpenPortProtocol = 'tcp'

/** 资源指标的分级。 */
export type SystemMetricLevel = 'normal' | 'warn' | 'high' | 'unknown'

/** 一个进程的快照。 */
export interface SystemProcessInfo {
  pid: number
  ppid: number
  name: string
  command: string
  cwd: Nullable<string>
  startTime: Nullable<string>
  user: string
  cpuPercent: number
  memoryBytes: number
  status: string
}

/** 查询进程的过滤条件。 */
export interface SystemProcessQueryOptions {
  /** 对进程名与完整命令行做不区分大小写的包含匹配，在 limit 截断前过滤。 */
  filter?: string
  /** 匹配结果数量上限；默认 50。 */
  limit?: number
  pid?: number
  pids?: number[]
  name?: string
  commandContains?: string
  user?: string
  onlyCurrentUser?: boolean
  minCpuPercent?: number
  minMemoryBytes?: number
  includeCwd?: boolean
}

/** 一个开放端口及占用它的进程。 */
export interface SystemOpenPortInfo {
  port: number
  protocol: SystemOpenPortProtocol
  pid: Nullable<number>
  processName: Nullable<string>
  command: Nullable<string>
  address: string
  state: Nullable<string>
  cwd: Nullable<string>
}

/** 查询开放端口的过滤条件。 */
export interface SystemOpenPortQueryOptions {
  /** 对进程名与完整命令行做不区分大小写的包含匹配，在 limit 截断前过滤。 */
  filter?: string
  /** 匹配结果数量上限；默认 50。 */
  limit?: number
  pid?: number
  processName?: string
  port?: number
  ports?: number[]
  rangeStart?: number
  rangeEnd?: number
  includeCwd?: boolean
}

/** 一次系统资源采样。拿不到的指标填 null，不填 0。 */
export interface SystemMetricsSnapshot {
  sampledAt: number
  cpuUsagePercent: Nullable<number>
  cpuCoreCount: number
  memoryUsedBytes: number
  memoryTotalBytes: number
  memoryUsagePercent: number
  swapUsedBytes: Nullable<number>
  swapTotalBytes: Nullable<number>
  swapUsagePercent: Nullable<number>
  diskUsedBytes: Nullable<number>
  diskTotalBytes: Nullable<number>
  diskUsagePercent: Nullable<number>
  loadAverage: { oneMinute: number; fiveMinutes: number; fifteenMinutes: number }
  levels: Record<'cpu' | 'memory' | 'swap' | 'disk' | 'load', SystemMetricLevel>
  topProcesses: SystemProcessInfo[]
}

// ── 后台任务 ────────────────────────────────────────────────────

/** 后台任务状态；进程是否真的还在，拿不准时报 `unknown` 而不是猜。 */
export type SystemBackgroundTaskStatus = 'running' | 'exited' | 'unknown'

/**
 * 本模块管理的一条后台任务。
 *
 * 任务由 `system:run` 的后台模式创建，`id` 就是当时返回的 `taskId`；
 * 终止命令三档（普通、强制、兜底）都是给人看的建议，真正终止走 `terminateBackgroundTask`。
 */
export interface SystemBackgroundTaskRecord {
  exitCode?: LooseOptional<number>
  signal?: LooseOptional<string>
  finishedAt?: number
  cleanupIncomplete?: boolean
  id: string
  runId: string
  sessionId: Nullable<string>
  command: string
  cwd: string
  pid: number
  logPath: Nullable<string>
  ports: number[]
  reason: Nullable<string>
  terminateCommand: Nullable<string>
  forceTerminateCommand: Nullable<string>
  fallbackTerminateCommand: Nullable<string>
  requested: boolean
  autoStarted: boolean
  startedAt: number
  updatedAt: number
  status: SystemBackgroundTaskStatus
  recentOutput: Nullable<string>
}

/** 查询后台任务的过滤条件；给了 `taskId` 就精确匹配那一条。 */
export interface SystemBackgroundTaskQueryOptions {
  /** 对后台任务完整命令行做不区分大小写的包含匹配，在 limit 截断前过滤。 */
  filter?: string
  /** 匹配结果数量上限；默认 50。 */
  limit?: number
  taskId?: string
  sessionId?: string
  sessionIds?: string[]
  onlyRunning?: boolean
}

/** 终止后台任务的请求；`force` 直接发 SIGKILL。 */
export interface SystemBackgroundTaskTerminateRequest {
  taskId: string
  sessionId?: string
  force?: boolean
}

/** 终止后台任务的结果：记录终止前后的状态，`terminated` 为 false 时看 `message`。 */
export interface SystemBackgroundTaskTerminateResult {
  taskId: string
  sessionId: Nullable<string>
  pid: number
  signal: 'SIGTERM' | 'SIGKILL'
  statusBefore: SystemBackgroundTaskStatus
  statusAfter: SystemBackgroundTaskStatus
  terminated: boolean
  message: string
}

// ── 系统范围搜索 ────────────────────────────────────────────────

/**
 * 文件能力的对外数据类型：系统范围搜索的输入与输出。
 *
 * 这里只描述「跨进程可传递的数据长什么样」；读、写、编辑、列目录四个工具的入参由各工具的
 * schema 定义，不在这里重复。
 */

/** 搜索命中的一个文件系统条目。 */
export interface SystemFileEntry {
  path: string
  type: 'file' | 'directory'
}

/** 内容搜索命中的一行：定位到文件、行、列，并附一段摘录。 */
export interface SystemSearchMatch {
  path: string
  line: number
  column: number
  excerpt: string
}

/** 搜索模式：`paths` 按路径名找条目，`content` 在文件内容里找文本。 */
export type SystemGlobalSearchMode = 'paths' | 'content'

/** 路径模式下的匹配方式：包含、精确、模糊。 */
export type SystemGlobalSearchPathMatchMode = 'contains' | 'exact' | 'fuzzy'

/**
 * 系统范围搜索的输入。
 *
 * 未给出的字段一律由实现取默认值：默认根目录、默认条数上限、默认深度上限。
 * `unrestricted` 只表达调用方的意愿，实现仍会跳过受系统保护的目录（见不变量登记）。
 */
export interface SystemGlobalSearchOptions {
  query: string
  mode?: SystemGlobalSearchMode
  rootPath?: string
  limit?: number
  maxDepth?: number
  entryTypes?: Array<SystemFileEntry['type']>
  pathMatchMode?: SystemGlobalSearchPathMatchMode
  extensions?: string[]
  caseSensitive?: boolean
  regex?: boolean
  maxResultsPerFile?: number
  includeHidden?: boolean
  unrestricted?: boolean
}

/**
 * 系统范围搜索的输出。
 *
 * `count` 是本次返回的条数；`truncated` 为 true 表示还有结果没有返回，而不是搜索失败。
 * 路径模式填 `entries`，内容模式填 `matches`，两者不会同时出现。
 */
export interface SystemGlobalSearchResult {
  mode: SystemGlobalSearchMode
  rootPath: string
  count: number
  truncated: boolean
  entries?: SystemFileEntry[]
  matches?: SystemSearchMatch[]
}

// ── shell 与运行环境 ──────────────────────────────────────

/**
 * Shell 与运行环境的对外数据类型。
 *
 * 命令在哪个 shell 里跑、这个 shell 是否自检通过、环境变量什么时候刷新过，
 * 这些事实都通过这里的类型向界面和模型报告。`env` 一类只供宿主进程使用的数据
 * 刻意不出现在这里，避免泄漏到模型面。
 */

/** 实际选中的命令语言。Windows 按 Git Bash、PowerShell 7、Windows PowerShell、CMD 的顺序挑选。 */
export type SystemShellKind = 'git-bash' | 'pwsh' | 'powershell' | 'cmd' | 'posix'

/** 当前机器缺少推荐的 shell 时给用户的安装建议。 */
export interface SystemShellRecommendation {
  code: 'INSTALL_GIT_BASH'
  message: string
  url: string
}

/**
 * 生成命令之前就已确定的 shell 描述。可安全地传给浏览器端。
 *
 * `readiness` 为 `detected` 表示只发现了可执行文件，`ready` 表示已通过启动、版本与 UTF-8 自检。
 */
export interface SystemShellDescriptor {
  kind: SystemShellKind
  name: string
  shellPath: string
  args: string[]
  readiness: 'detected' | 'ready'
  version: Nullable<string>
  recommendation: Nullable<SystemShellRecommendation>
}

/** 运行平台标识；保留 `string & {}` 是为了让未知平台也能原样上报而不是被压成 never。 */
export type SystemRuntimePlatform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | (string & {})

/** 刷新 shell 环境后的回执；`revision` 变化意味着之前缓存的 shell 选择已作废。 */
export interface SystemShellEnvironmentRefreshResult {
  shell: string
  variableCount: number
  refreshedAt: number
  runtime?: SystemShellDescriptor
  revision?: string
}

/** 某个命令在当前 shell 下是否可用，以及它是原生程序、脚本、批处理还是内置命令。 */
export interface SystemEnvironmentCommandAvailability {
  name: string
  available: boolean
  path: Nullable<string>
  kind?: LooseOptional<'native' | 'script' | 'batch' | 'builtin'>
}

/** 一次环境体检的完整结果：操作系统、shell 与关心的命令是否齐备。 */
export interface SystemEnvironmentInspection {
  os: { platform: SystemRuntimePlatform; arch: string; release: string; homeDir: string }
  shell: {
    path: string
    variableCount: number
    pathEntries: string[]
    kind?: SystemShellKind
    name?: string
    readiness?: SystemShellDescriptor['readiness']
    version?: LooseOptional<string>
    recommendation?: LooseOptional<SystemShellRecommendation>
    revision?: string
  }
  commands: SystemEnvironmentCommandAvailability[]
}

// ── 错误码 ──────────────────────────────────────────────────────

/**
 * 系统空间对外承诺的错误语义。
 *
 * 失败关闭是默认姿态：拿不到安全的执行条件时拒绝执行，而不是降级成裸进程或静默跳过。
 *
 * 错误分两类：
 * 1. 下面两个专属错误码。调用方可以按码分支处理，码本身是契约的一部分，不得改名。
 * 2. 通用 `AppError` 码，含义沿用 `@velaros-ai/core`：
 *    - `VALIDATION`：入参不合法，包括 wire 面出现未知字段（schema 一律严格）。
 *    - `PERMISSION`：路径或操作越过了审批边界、宿主未开放该能力，或后台任务不属于当前会话。
 *    - `NOT_FOUND`：路径、进程或后台任务不存在。
 *    - `PLATFORM`：当前操作系统不支持该操作，或平台命令本身执行失败。
 *    - `INVARIANT`：内部状态自相矛盾，属于实现缺陷，不是用户错误。
 */
export const SystemErrorCodes = Object.freeze({
  /** 找不到任何可用的命令 shell。Windows 上建议安装 Git for Windows 后刷新命令环境。 */
  shellUnavailable: 'SYSTEM_SHELL_UNAVAILABLE',
  /** 请求了受约束的进程模式，但当前宿主没有可用后端。实现必须拒绝执行，不得退回裸进程。 */
  processConfinementUnavailable: 'SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE',
} as const)

export type SystemErrorCode = (typeof SystemErrorCodes)[keyof typeof SystemErrorCodes]

// ── 环境变量 ────────────────────────────────────────────────────

/**
 * 本包读写的全部环境变量。环境变量也是注入：宿主设什么、本包读什么，都在这张表里，别处不许再冒出新的变量名。
 *
 * - `input`：宿主可以设、本包读取的配置。
 * - `marker`：本包写进子进程环境的标记，子进程里的脚本可以读，宿主不要设。
 */
const SystemEnvironmentVariables = Object.freeze({
  shellPath: {
    name: 'VELAROS_SHELL_PATH',
    direction: 'input',
    description: 'Windows 上指定用哪个 shell 的完整路径；子进程环境里也会写上实际使用的 shell 路径。',
  },
  gitBash: {
    name: 'VELAROS_GIT_BASH',
    direction: 'input',
    description: 'Windows 上 Git Bash 的 bash.exe 路径，优先于自动查找。',
  },
  processHost: {
    name: 'VELAROS_PROCESS_HOST',
    direction: 'input',
    description: 'Windows 原生进程宿主的路径，优先于默认位置。',
  },
  sharedDataRoot: {
    name: 'VELAROS_SHARED_DATA_ROOT',
    direction: 'input',
    description: 'VelarOS 产品家族共享数据的根目录，覆盖按平台算出的默认位置。',
  },
  shellKind: {
    name: 'VELAROS_SHELL_KIND',
    direction: 'marker',
    description: '子进程所在 shell 的种类。',
  },
  shellReadiness: {
    name: 'VELAROS_SHELL_READINESS',
    direction: 'marker',
    description: 'shell 只是检测到（detected）还是已经通过自检（ready）。',
  },
  shellVersion: {
    name: 'VELAROS_SHELL_VERSION',
    direction: 'marker',
    description: '自检读到的 shell 版本。',
  },
} as const)

/** 环境变量表里的一项。 */
type SystemEnvironmentVariable = (typeof SystemEnvironmentVariables)[keyof typeof SystemEnvironmentVariables]

export { SystemEnvironmentVariables }
export type { SystemEnvironmentVariable }
