/**
 * 系统空间的可移植数据类型：命令结果、后台任务、控制台、进程与端口、指标、搜索、环境检查、演练沙箱等经宿主端口流动的数据结构。
 * 只放类型、一个值都没有；常量表在 `contract/constants.ts`。不 import 任何东西（只从常量表 import type）、不用 Node 专属类型，整个文件随 `./contracts` 入口出包。
 */

// ── 工具身份 ────────────────────────────────────────────────────

/**
 * 模型面工具的 canonical 身份。
 *
 * 工具名统一是 `system:<动作>`，一个工具只属于一个职责类别。这份表是全仓唯一权威：
 * 工具定义、mod 清单、内核模块注册都从这里取名字，不允许在别处再写一遍字符串。
 */

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

/** @AgentView 命令在操作系统进程层实际采用的文件副作用边界。 */
export type SystemProcessConfinementMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access'

/** @AgentView 约束强度；`partial` 不等于 `full`，别把它当成绝对边界。 */
export type SystemProcessConfinementEnforcement = 'none' | 'partial' | 'full'

/** @AgentView 实际承担约束的后端：macOS 是 Seatbelt，Linux 是 bubblewrap，`host` 表示宿主注入的实现。 */
export type SystemProcessConfinementBackend =
  | 'none'
  | 'bubblewrap'
  | 'seatbelt'
  | 'host'

/** @AgentView 这次进程启动真实生效的约束，不是请求的那个。 */
export interface SystemProcessConfinementEvidence {
  mode: SystemProcessConfinementMode
  enforcement: SystemProcessConfinementEnforcement
  backend: SystemProcessConfinementBackend
  reason: string
  /** 受约束模式下真实批准的写根；`danger-full-access` 为空表示不采用 allowlist。 */
  writableRoots: string[]
}

/** @AgentView 子进程树由谁负责在父进程退出时清理，以及实际能不能做到。 */
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
  /**
   * 交互式：命令要向用户要输入（口令、y/n、菜单选项）时为真，必须和 `background` 一起用。
   * 宿主把它跑成一个接受输入的后台任务（有 PTY 就用 PTY，没有就用保持打开的 stdin 管道），
   * 回执里的 `backgroundProcess.console` 就是那个控制台；宿主不支持时回执里没有 console。
   */
  interactive?: boolean
  maxOutputChars?: number
  sessionId?: string
  /**
   * 用哪个 shell 跑这条命令，来自 `system:run` 的 `shell` 字段；不给就用宿主自己挑的默认 shell。
   * 宿主必须在这个 shell 里执行：本机没有它就在执行之前拒绝（`VALIDATION`，报错里点名可用的有哪些），
   * 不许换一个 shell 照跑——模型是按这个 shell 的语法写的命令，换一个跑出来的是错的结果而不是报错。
   */
  shell?: SystemShellKind
  /** 宿主生成的可执行调用；永远不出现在模型工具 schema 中。 */
  nativeCommand?: { file: string; args: string[]; env?: Record<string, string> }
}

/** @AgentView 命令进了后台时的回执；`autoStarted` 表示不是调用方要的后台，是按命令本身判出来自动转的。 */
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
  /** 交互式任务的控制台：命令正在等用户输入，用户在聊天里的控制台卡片里打字。不是交互式任务时缺席。 */
  console?: SystemConsoleSessionInfo
  /** 把这个 taskId 交给 listTasks 就查得到这条任务的状态。 */
  statusContinuation?: {
    tool: 'system:list-tasks'
    args: { taskId: string }
  }
}

/** @AgentView 成功命令的 stdout / stderr 不会被当作 issue；失败、超时、取消时把输出末尾摘进 issues。 */
export interface SystemVerificationSummary {
  kind: 'build' | 'lint' | 'test' | 'typecheck' | 'unknown'
  status: 'aborted' | 'failed' | 'passed' | 'timed-out' | 'unknown'
  issues: string[]
}

/** @AgentView 输出窗口留的是完整输出的末尾，不是开头。 */
export interface SystemCommandOutputWindow {
  retained: 'tail'
  /** false 表示完整输出更长；不影响已返回的这段末尾的真实性。 */
  complete: boolean
  /** 进程结束后窗口的末端就是完整输出的末端。 */
  endPreserved: true
}

/** @AgentView 输出被截断时去哪里找完整内容：它在会话的终端日志里，不是一个能直接读的文件。 */
export interface SystemCommandOutputContinuation {
  kind: 'session-terminal-log'
  query: string
  tool: 'context:recall'
  args: { query: string; kind: 'terminal' }
}

/** @AgentView 各项字节数都按解码后的 UTF-8 文本算。 */
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
 * @AgentView
 * `success` 只看退出码为 0 且没有超时、没有被取消——命令自己失败不算这次调用失败。
 * `outputWindow` 一定给出；`outputContinuation` 只在宿主留了会话终端日志（`logPath`）时才有。
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
  confinement?: SystemProcessConfinementEvidence
  backgroundProcess?: SystemBackgroundProcessInfo
  verification: SystemVerificationSummary
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

/** @AgentView 后台任务状态；进程是否真的还在，拿不准时报 `unknown` 而不是猜。 */
export type SystemBackgroundTaskStatus = 'running' | 'exited' | 'unknown'

/**
 * @AgentView
 * 一条后台任务：`id` 就是 run 返回的 `taskId`。
 * 终止命令三档（普通、强制、兜底）是给 run 直接执行的现成命令。
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
  /** 这条任务输出的末尾 4000 字符。 */
  recentOutput: Nullable<string>
  /** 交互式任务的控制台；不是交互式任务时缺席。 */
  console?: SystemConsoleSessionInfo
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

// ── 交互式任务的控制台 ──────────────────────────────────────────

/**
 * 交互式后台任务的控制台数据：命令在控制台里跑，用户在界面上看输出、往里打字、发中断。
 *
 * 命令用 `interactive` 启动后就是一条普通的后台任务，只是多了一个控制台：
 * 任务表、状态查询、终止都照旧走后台任务那套，这里只多出「写输入、读增量输出、发中断」三件事。
 */

/** @AgentView 控制台后面接的是什么：真正的终端（宿主提供 PTY，有回显和终端尺寸）还是一根保持打开的 stdin 管道。 */
export type SystemConsoleChannel = 'pty' | 'pipe'

/** @AgentView 一个交互式任务的控制台。 */
export interface SystemConsoleSessionInfo {
  /** 和 `backgroundProcess.taskId` 是同一个。 */
  taskId: string
  /** 管道下没有回显，只读 tty 的密码提示可能根本不出现。 */
  channel: SystemConsoleChannel
  /** 进程退出后为 false。 */
  acceptsInput: boolean
  /** 一句话说明：任务正在控制台里等用户，别再等这次调用的输出。 */
  note: string
}

/** 读控制台增量输出的请求；`cursor` 是上一次返回的位置，不给就从留着的最早一段开始读。 */
export interface SystemConsoleOutputRequest {
  taskId: string
  sessionId?: string
  cursor?: number
}

/** 控制台的一段增量输出。 */
export interface SystemConsoleOutputChunk {
  taskId: string
  /** 从请求的 cursor 起新产生的输出。 */
  text: string
  /** 下一次请求把这个值当 cursor 传回来。 */
  cursor: number
  /** 缓冲区放不下、已经丢掉的字符数；大于 0 表示中间有一段永远看不到了。 */
  droppedChars: number
  /** 任务此刻的状态。 */
  status: SystemBackgroundTaskStatus
  /** 现在还能不能写输入。 */
  acceptsInput: boolean
}

/** 往控制台写一段输入的请求。 */
export interface SystemConsoleInputRequest {
  taskId: string
  sessionId?: string
  /** 写进去的文本。 */
  text: string
  /** 是否在末尾补一个换行，相当于用户按回车；缺省为真。 */
  submit?: boolean
}

/** 给控制台发中断（SIGINT，相当于用户按 Ctrl+C）的请求。 */
export interface SystemConsoleInterruptRequest {
  taskId: string
  sessionId?: string
}

/** 写输入或发中断的结果：`accepted` 为 false 时看 `message`，不猜原因。 */
export interface SystemConsoleControlResult {
  taskId: string
  accepted: boolean
  status: SystemBackgroundTaskStatus
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

/** @AgentView 实际选中的命令语言。Windows 按 Git Bash、PowerShell 7、Windows PowerShell、CMD 的顺序挑选。 */
export type SystemShellKind = 'git-bash' | 'pwsh' | 'powershell' | 'cmd' | 'posix'

/** @AgentView 当前机器缺少推荐的 shell 时给用户的安装建议。 */
export interface SystemShellRecommendation {
  code: 'INSTALL_GIT_BASH'
  message: string
  url: string
}

/** @AgentView `readiness` 为 `detected` 表示只发现了可执行文件，`ready` 表示已通过启动、版本与 UTF-8 自检。 */
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

/** @AgentView 刷新之后的 shell 环境：`shell` 是重新选定的那个默认 shell 的可执行文件路径，`runtime` 是它的完整描述。 */
export interface SystemShellEnvironmentRefreshResult {
  shell: string
  variableCount: number
  refreshedAt: number
  runtime?: SystemShellDescriptor
  /** 刷新之后本机可用的全部 shell，按挑选优先顺序，第一个就是 `runtime` 那个默认的。刚装上的 shell 在这里就看得到，不必等下一个回合的环境报告。 */
  shells?: SystemShellDescriptor[]
  /** 这次选定的 shell 环境的版本号；变了说明之前缓存的 shell 选择已作废。 */
  revision?: string
  /** Windows 上重读用户与系统环境变量失败时的原因；成功或不是 Windows 时没有。 */
  reason?: string
}

/** 某个命令在当前 shell 下是否可用，以及它是原生程序、脚本、批处理还是内置命令。 */
export interface SystemEnvironmentCommandAvailability {
  name: string
  available: boolean
  path: Nullable<string>
  kind?: LooseOptional<'native' | 'script' | 'batch' | 'builtin'>
}

/**
 * 一次环境体检的完整结果：操作系统、shell 与关心的命令是否齐备。
 *
 * `shell` 是默认用的那个，`shells` 是本机可用的全部。宿主把这两样写进每回合给模型的环境报告，模型才知道
 * `system:run` / `project:run` 的 `shell` 字段能填哪几个、不填时用的是哪个；POSIX 机器上 `shells` 只有 `posix` 一项，模型就不会去填。
 */
export interface SystemEnvironmentInspection {
  os: { platform: SystemRuntimePlatform; arch: string; release: string; homeDir: string }
  /** 本机可用的全部 shell，按挑选优先顺序（Windows 是 Git Bash、PowerShell 7、Windows PowerShell、CMD），第一个就是 `shell` 那个默认的。 */
  shells: SystemShellDescriptor[]
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

