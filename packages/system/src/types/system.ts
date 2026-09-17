/**
 * 本地内核给宿主界面的可移植数据：进程与端口、资源指标、终止后台任务与控制台的请求、系统范围搜索、运行平台与命令可用性。
 * 命令回执、后台任务、shell 描述这些 `velar:shell` 也用的数据在 `@velaros-ai/shell-command/contracts`；
 * 引用到它们的内核数据在 `types/host.ts`。
 * 只放类型、一个值都没有；常量表在 `contract/constants.ts`。不 import 任何东西、不用 Node 专属类型，整个文件随 `./contracts` 入口出包。
 */

// ── 进程、端口与资源快照 ────────────────────────────────────────

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

// ── 后台任务 ────────────────────────────────────────────────────

/** 终止后台任务的请求；`force` 直接发 SIGKILL。 */
export interface SystemBackgroundTaskTerminateRequest {
  taskId: string
  sessionId?: string
  force?: boolean
}

// ── 交互式任务的控制台 ──────────────────────────────────────────

/**
 * 交互式后台任务的控制台数据：命令在控制台里跑，用户在界面上看输出、往里打字、发中断。
 *
 * 命令用 `interactive` 启动后就是一条普通的后台任务，只是多了一个控制台：
 * 任务表、状态查询、终止都照旧走后台任务那套，这里只多出「写输入、读增量输出、发中断」三件事。
 */

/** 读控制台增量输出的请求；`cursor` 是上一次返回的位置，不给就从留着的最早一段开始读。 */
export interface SystemConsoleOutputRequest {
  taskId: string
  sessionId?: string
  cursor?: number
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

// ── 系统范围搜索 ────────────────────────────────────────────────

/**
 * 系统范围搜索的输入与输出：给宿主自己的界面用，模型列目录、搜文本用命令。
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

// ── 运行环境 ────────────────────────────────────────────────────

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
export interface SystemEnvironmentCommandAvailability {
  name: string
  available: boolean
  path: Nullable<string>
  kind?: LooseOptional<'native' | 'script' | 'batch' | 'builtin'>
}
