/**
 * 可移植数据：一条 shell 命令执行前的分类结果、调度器问「能不能并发」时给的入参与选项，
 * 以及宿主端口上流动的命令数据（跑命令的选项、回执、后台任务、控制台、shell 描述），
 * 还有本机宿主给宿主界面的数据（进程、端口、资源快照、控制台、环境体检）。
 * 只从常量表 import type，不带函数，浏览器和渲染进程都能用；从 `@velaros-ai/velaros/execution/contracts` 取。
 */

import type { ShellCommandKind } from '../contract/constants.js'

/**
 * 一条 shell 命令执行前的分类。三个判定各管一件事，误判代价不同，判据也不同：
 * - `isReadOnly` 决定能不能并发、能不能无人值守放行：白名单加整体否决，拿不准一律非只读。
 * - `isDangerous` 决定要不要用户亲自确认：黑名单，漏判只是少弹一次确认。
 * - `shouldStartInBackground` 是体验判定（识别开发服务器这类长驻进程），误判只让命令跑在前台或后台。
 */
export interface ShellCommandPlan {
  /** 任何参数组合下都不写盘、不执行别的程序。 */
  isReadOnly: boolean
  /** 看起来是长驻服务，缺省该转后台。 */
  shouldStartInBackground: boolean
  /** 长驻的理由；不长驻为 null。 */
  reason: Nullable<string>
  /** 删数据、丢未提交改动、改系统这类不可逆操作。 */
  isDangerous: boolean
  /** 危险的理由，确认卡上原样展示；不危险为 null。 */
  dangerousReason: Nullable<string>
  /** 命令里看得出来的端口。 */
  ports: number[]
}

/** 调度器问一次命令调用能不能与别的调用并发时给的原始入参：工具入参里的这三个字段，类型不保证。 */
export interface ShellCommandConcurrencyInput {
  command?: unknown
  background?: unknown
  parallel?: unknown
}

/** 并发判定的选项。 */
export interface ShellCommandConcurrencyOptions {
  /** 为真时还要求入参显式写了 `parallel: true`（工具 schema 有 parallel 字段时用）；为假时只在入参写了 `parallel: false` 才拒绝。缺省为真。 */
  optIn?: boolean
}

/**
 * 宿主交回的命令回执（界面与本机宿主都用它）。前台 success 要求退出码为 0、没有超时、取消或未完成清理；后台 success 只确认进程启动，此时 exitCode 为 null，不表示任务完成。
 * 后台任务的完成与最终退出码由任务记录确认；命令自己失败是正常回执、不抛错。
 * stdout、stderr 超过 maxOutputChars 时**只留末尾**（失败现场在尾部），truncated 为真。
 */
export interface ShellCommandResult {
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
  capture?: ShellCommandOutputCapture
  shell?: ShellDescriptor
  cleanupIncomplete?: boolean
  ownership?: ShellProcessOwnership
  success: boolean
  confinement?: ShellProcessConfinementEvidence
  backgroundProcess?: ShellBackgroundProcessInfo
  verification: ShellVerificationSummary
}

/** 输出捕获的账，各项字节数都按解码后的 UTF-8 文本算。 */
export interface ShellCommandOutputCapture {
  status: 'complete' | 'truncated' | 'failed'
  encoding: 'utf-8'
  totalBytes: number
  storedBytes: number
  omittedBytes: number
  decodeErrors: number
  error?: string
}

/** 失败、超时、取消时 issues 里是 stdout 与 stderr 的末尾；成功时为空。 */
export interface ShellVerificationSummary {
  kind: 'build' | 'lint' | 'test' | 'typecheck' | 'unknown'
  status: 'aborted' | 'failed' | 'passed' | 'timed-out' | 'unknown'
  issues: string[]
}

/**
 * 宿主登记后台任务之后交回的完整信息：`taskId`、进程号、端口、三档终止命令（界面上的停止按钮用）。
 * `autoStarted` 表示不是调用方要的后台，是按命令本身判出来自动转的（开发服务器这类长驻命令）。模型看到的是从它整出来的 `ShellBackgroundStart`。
 */
export interface ShellBackgroundProcessInfo {
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
  /** 交互式任务的控制台：命令正在等用户输入，用户在控制台里打字。不是交互式任务时缺席。 */
  console?: ShellConsoleSessionInfo
}

// ── 进程约束与归属 ──────────────────────────────────────────────

/**  命令在操作系统进程层实际采用的文件副作用边界。 */
export type ShellProcessConfinementMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**  约束强度；`partial` 不等于 `full`，别把它当成绝对边界。 */
export type ShellProcessConfinementEnforcement = 'none' | 'partial' | 'full'

/**  实际承担约束的后端：macOS 是 Seatbelt，Linux 是 bubblewrap，`host` 表示宿主注入的实现。 */
export type ShellProcessConfinementBackend = 'none' | 'bubblewrap' | 'seatbelt' | 'host'

/**  这次进程启动真实生效的约束，不是请求的那个。审批事实与约束事实分开记，谁也不冒充谁。 */
export interface ShellProcessConfinementEvidence {
  mode: ShellProcessConfinementMode
  enforcement: ShellProcessConfinementEnforcement
  backend: ShellProcessConfinementBackend
  reason: string
  /** 受约束模式下真实批准的写根；`danger-full-access` 为空表示不采用 allowlist。 */
  writableRoots: string[]
}

/** 子进程树由谁负责在父进程退出时清理，以及实际能不能做到。 */
export interface ShellProcessOwnership {
  backend: 'windows-job' | 'process-tree'
  parentDeathCleanup: boolean
  reason: string
}

// ── 后台任务与控制台 ────────────────────────────────────────────

/**  后台任务状态；进程是否真的还在，拿不准时报 `unknown` 而不是猜。 */
export type ShellBackgroundTaskStatus = 'running' | 'exited' | 'unknown'

/**
 * 宿主任务表里的一条后台任务（界面也用它）：`id` 就是 run 返回的 `taskId`，终止命令三档（普通、强制、兜底）是现成的命令。
 *
 */
export interface ShellBackgroundTaskRecord {
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
  status: ShellBackgroundTaskStatus
  /** 这条任务到现在的输出；超过 `ShellLimits.outputChars` 只留末尾。 */
  recentOutput: Nullable<string>
  /** 交互式任务的控制台；不是交互式任务时缺席。 */
  console?: ShellConsoleSessionInfo
}

/**  控制台后面接的是什么：真正的终端（宿主提供 PTY，有回显和终端尺寸）还是一根保持打开的 stdin 管道。 */
export type ShellConsoleChannel = 'pty' | 'pipe'

/**  一个交互式任务的控制台。 */
export interface ShellConsoleSessionInfo {
  /** 和 `backgroundProcess.taskId` 是同一个。 */
  taskId: string
  /** 管道下没有回显，只读 tty 的密码提示可能根本不出现。 */
  channel: ShellConsoleChannel
  /** 进程退出后为 false。 */
  acceptsInput: boolean
  /** 一句话说明：任务正在控制台里等用户，别再等这次调用的输出。 */
  note: string
}

// ── shell 与环境 ────────────────────────────────────────────────

/** 当前机器缺少推荐的 shell 时给用户的安装建议。 */
export interface ShellRecommendation {
  code: 'INSTALL_GIT_BASH'
  message: string
  url: string
}

/** `readiness` 为 `detected` 表示只发现了可执行文件，`ready` 表示已通过启动、版本与 UTF-8 自检。 */
export interface ShellDescriptor {
  kind: ShellCommandKind
  name: string
  shellPath: string
  args: string[]
  readiness: 'detected' | 'ready'
  version: Nullable<string>
  recommendation: Nullable<ShellRecommendation>
}

/** 刷新之后的 shell 环境：`shell` 是重新选定的那个默认 shell 的可执行文件路径，`runtime` 是它的完整描述。 */
export interface ShellEnvironmentRefreshResult {
  shell: string
  variableCount: number
  refreshedAt: number
  runtime?: ShellDescriptor
  /** 刷新之后本机可用的全部 shell，按挑选优先顺序，第一个就是 `runtime` 那个默认的。刚装上的 shell 在这里就看得到，不必等下一个回合的环境报告。 */
  shells?: ShellDescriptor[]
  /** 这次选定的 shell 环境的版本号；变了说明之前缓存的 shell 选择已作废。 */
  revision?: string
  /** Windows 上重读用户与系统环境变量失败时的原因；成功或不是 Windows 时没有。 */
  reason?: string
}

// ── 宿主端口上的选项 ────────────────────────────────────────────

/** 宿主跑一条命令时的可选项：run 的入参，工作目录已由空间端口解析成绝对路径。 */
export interface ShellRunCommandOptions {
  /** 宿主为当前进程注入的环境。 */
  environment?: Readonly<Record<string, string | undefined>>
  /** 宿主能力桥的单个本机套接字；不开放外部网络。 */
  ipcSocket?: string
  /** 本次进程的宿主输出文件。 */
  outputFile?: string
  /** 绝对工作目录。 */
  cwd?: string
  /** null 仅供宿主自管时钟使用，必须同时提供取消信号。 */
  timeoutMs?: LooseOptional<number>
  background?: boolean
  /**
   * 交互式：命令要向用户要输入（口令、y/n、菜单选项）时为真，必须和 `background` 一起用。
   * 宿主把它跑成一个接受输入的后台任务（有 PTY 就用 PTY，没有就用保持打开的 stdin 管道），
   * 回执里的 `backgroundProcess.console` 就是那个控制台；宿主不支持时回执里没有 console。
   */
  interactive?: boolean
  maxOutputChars?: number
  /** 宿主提供的前台标准输入，按 UTF-8 写入后发送 EOF；后台命令不接受此字段。 */
  stdin?: string
  /** 发起这条命令的会话；宿主按它登记后台任务的归属。 */
  sessionId?: string
  /**
   * 用哪个 shell 跑；不给就用宿主自己挑的默认 shell。宿主必须在这个 shell 里执行：本机没有它就在执行之前拒绝
   * （`VALIDATION`，报错里点名可用的有哪些），不许换一个 shell 照跑——命令是按这个 shell 的语法写的，换一个跑出来的是错的结果而不是报错。
   */
  shell?: ShellCommandKind
  /** 宿主自己组合出来的可执行调用；env 覆盖本次环境，undefined 删除该键；永远不进模型面。 */
  nativeCommand?: { file: string; args: string[]; env?: Record<string, string | undefined> }
}

/** 查询后台任务的过滤条件；给了 `taskId` 就精确匹配那一条。 */
export interface ShellBackgroundTaskQueryOptions {
  /** 对后台任务完整命令行做不区分大小写的包含匹配，在 limit 截断前过滤。 */
  filter?: string
  /** 匹配结果数量上限；不给就全列。 */
  limit?: number
  taskId?: string
  sessionId?: string
  sessionIds?: string[]
  onlyRunning?: boolean
}

/** 停一条后台任务的请求：宿主核对它属于这个会话；force 为真直接强杀，否则发普通的终止信号。 */
export interface ShellTaskTerminateRequest {
  taskId: string
  sessionId?: string
  force: boolean
}

/** 宿主终止后台任务的结果：`terminated` 为 false 时看 `message`（本来就不在跑）。本机宿主给的 `ShellTaskTerminateReport` 在它之上多记几项。 */
export interface ShellTaskTerminateResult {
  terminated: boolean
  statusAfter: ShellBackgroundTaskStatus
  message: string
}

// ── 本机宿主给宿主界面的数据（`@velaros-ai/velaros/execution/local` 的 LocalShellHost；模型碰不到） ──────────

/**
 * 进程能力的对外数据结构：进程列表、开放端口、资源快照。
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

/**
 * 交互式后台任务的控制台数据：命令在控制台里跑，用户在界面上看输出、往里打字、发中断。
 *
 * 命令用 `interactive` 启动后就是一条普通的后台任务，只是多了一个控制台：
 * 任务表、状态查询、终止都照旧走后台任务那套，这里只多出「写输入、读增量输出、订阅新输出、发中断、改终端尺寸」几件事。
 */

/** 读控制台增量输出的请求；`cursor` 是上一次返回的位置，不给就从留着的最早一段开始读。 */
export interface ShellConsoleOutputRequest {
  taskId: string
  sessionId?: string
  cursor?: number
}

/** 往控制台写一段输入的请求。 */
export interface ShellConsoleInputRequest {
  taskId: string
  sessionId?: string
  /** 写进去的文本。 */
  text: string
  /** 是否在末尾补一个换行，相当于用户按回车；缺省为真。 */
  submit?: boolean
}

/** 给控制台发中断（SIGINT，相当于用户按 Ctrl+C）的请求。 */
export interface ShellConsoleInterruptRequest {
  taskId: string
  sessionId?: string
}

/** 改控制台终端尺寸的请求：列数、行数都是正整数。 */
export interface ShellConsoleResizeRequest {
  taskId: string
  sessionId?: string
  cols: number
  rows: number
}

/** 订阅控制台新输出的请求。 */
export interface ShellConsoleWatchRequest {
  taskId: string
  sessionId?: string
}

/** 控制台新到的一段输出；`cursor` 是这段结束处的位置，和读增量输出用的是同一把尺子。 */
export interface ShellConsoleOutputEvent {
  taskId: string
  text: string
  cursor: number
}

/** 本机宿主终止后台任务的完整结果：在端口要的那三项之外，记下进程号、发的信号与终止前的状态，给宿主界面用。 */
export interface ShellTaskTerminateReport extends ShellTaskTerminateResult {
  taskId: string
  sessionId: Nullable<string>
  pid: number
  signal: 'SIGTERM' | 'SIGKILL'
  statusBefore: ShellBackgroundTaskStatus
}

/** 控制台的一段增量输出。 */
export interface ShellConsoleOutputChunk {
  taskId: string
  /** 从请求的 cursor 起新产生的输出。 */
  text: string
  /** 下一次请求把这个值当 cursor 传回来。 */
  cursor: number
  /** 缓冲区放不下、已经丢掉的字符数；大于 0 表示中间有一段永远看不到了。 */
  droppedChars: number
  /** 任务此刻的状态。 */
  status: ShellBackgroundTaskStatus
  /** 现在还能不能写输入。 */
  acceptsInput: boolean
}

/** 写输入或发中断的结果：`accepted` 为 false 时看 `message`，不猜原因。 */
export interface ShellConsoleControlResult {
  taskId: string
  accepted: boolean
  status: ShellBackgroundTaskStatus
  message: string
}

/**
 * 一次环境体检的完整结果：操作系统、shell 与关心的命令是否齐备。
 *
 * `shell` 是默认用的那个，`shells` 是本机可用的全部。宿主把这两样写进每回合给模型的环境报告，模型才知道
 * `run` 的 `shell` 字段能填哪几个、不填时用的是哪个；POSIX 机器上 `shells` 只有 `posix` 一项，模型就不会去填。
 */
export interface ShellEnvironmentInspection {
  os: { platform: SystemRuntimePlatform; arch: string; release: string; homeDir: string }
  /** 本机可用的全部 shell，按挑选优先顺序（Windows 是 Git Bash、PowerShell 7、Windows PowerShell、CMD），第一个就是 `shell` 那个默认的。 */
  shells: ShellDescriptor[]
  shell: {
    path: string
    variableCount: number
    pathEntries: string[]
    kind?: ShellCommandKind
    name?: string
    readiness?: ShellDescriptor['readiness']
    version?: LooseOptional<string>
    recommendation?: LooseOptional<ShellRecommendation>
    revision?: string
  }
  commands: ShellCommandAvailability[]
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

/** 某个命令在当前 shell 下是否可用，以及它是原生程序、脚本、批处理还是内置命令。 */
export interface ShellCommandAvailability {
  name: string
  available: boolean
  path: Nullable<string>
  kind?: LooseOptional<'native' | 'script' | 'batch' | 'builtin'>
}
