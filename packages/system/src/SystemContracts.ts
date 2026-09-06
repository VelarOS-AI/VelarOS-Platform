export type SystemCommandScope = 'system' | 'project'
export type SystemCommandRunStatus = 'running' | 'passed' | 'failed' | 'timed-out'
export type SystemOpenPortProtocol = 'tcp'
export type SystemMetricLevel = 'normal' | 'warn' | 'high' | 'unknown'
export type SystemGlobalSearchMode = 'paths' | 'content'
export type SystemGlobalSearchPathMatchMode = 'contains' | 'exact' | 'fuzzy'
export type SystemBackgroundTaskStatus = 'running' | 'exited' | 'unknown'
/** 已批准命令在操作系统进程层实际采用的文件副作用边界。 */
export type SystemProcessConfinementMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access'
/** `partial` 只能作为可观测事实，不能被需要绝对边界的调用方当作 `full`。 */
export type SystemProcessConfinementEnforcement = 'none' | 'partial' | 'full'
export type SystemProcessConfinementBackend =
  | 'none'
  | 'bubblewrap'
  | 'seatbelt'
  | 'host'

/** 一次真实进程启动的约束证据；审批事实与约束事实必须分开记录。 */
export interface SystemProcessConfinementEvidence {
  mode: SystemProcessConfinementMode
  enforcement: SystemProcessConfinementEnforcement
  backend: SystemProcessConfinementBackend
  reason: string
  /** 受约束模式下真实批准的写根；`danger-full-access` 为空表示不采用 allowlist。 */
  writableRoots: string[]
}
export type SystemDefaultEditorId =
  | 'velaros-light'
  | 'system'
  | 'visual-studio-code'
  | 'cursor'
  | 'windsurf'
  | 'trae'
  | 'zed'
  | 'webstorm'
  | 'sublime-text'
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

export interface SystemFileEntry {
  path: string
  type: 'file' | 'directory'
}

export interface SystemSearchMatch {
  path: string
  line: number
  column: number
  excerpt: string
}

export interface SystemOpenPathResult {
  path: string
  opened: boolean
  editor?: SystemDefaultEditorId
  application?: string
}

export interface SystemRevealPathResult {
  path: string
  revealed: boolean
}

export interface SystemOpenApplicationOptions {
  args?: string[]
  targetPath?: string
}

export interface SystemOpenApplicationResult {
  application: string
  args: string[]
  targetPath?: string
  opened: boolean
}

export interface SystemRunCommandOptions {
  cwd?: string
  timeoutMs?: number
  background?: boolean
  maxOutputChars?: number
  sessionId?: string
}

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

export interface SystemVerificationSummary {
  kind: 'build' | 'lint' | 'test' | 'typecheck' | 'unknown'
  status: 'aborted' | 'failed' | 'passed' | 'timed-out' | 'unknown'
  issues: string[]
}

export interface SystemCommandOutputWindow {
  /** 返回窗口保留完整输出的末尾，而不是开头。 */
  retained: 'tail'
  /** false 表示整体输出更长；不影响已返回末尾窗口的真实性。 */
  complete: boolean
  /** 进程结束后窗口的末端与完整输出末端一致。 */
  endPreserved: true
}

export interface SystemCommandOutputContinuation {
  /** 完整输出由会话内部终端日志管理，不是普通工作区文件。 */
  kind: 'session-terminal-log'
  /** 交给会话终端输出召回能力的稳定查询词。 */
  query: string
  /** 可直接执行的召回工具，避免把系统命令误交给 job:*。 */
  tool: 'context:recall'
  args: { query: string; kind: 'terminal' }
}

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
  outputWindow?: SystemCommandOutputWindow
  outputContinuation?: SystemCommandOutputContinuation
  success: boolean
  /** 缺席仅用于兼容旧宿主；新执行器必须报告真实的进程约束事实。 */
  confinement?: SystemProcessConfinementEvidence
  backgroundProcess?: SystemBackgroundProcessInfo
  verification: SystemVerificationSummary
  systemToolSuggestion?: LooseOptional<SystemToolInstallSuggestion>
}

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

export interface SystemCommandRunRecord {
  id: string
  sessionId: Nullable<string>
  scope: SystemCommandScope
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

export interface SystemCommandRunQueryOptions {
  limit?: number
  sessionId?: string
  scope?: SystemCommandScope
  onlyFailed?: boolean
  background?: boolean
}

export interface SystemBackgroundTaskRecord {
  id: string
  runId: string
  sessionId: Nullable<string>
  scope: SystemCommandScope
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

export interface SystemBackgroundTaskTerminateRequest {
  taskId: string
  sessionId?: string
  force?: boolean
}

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

export interface SystemShellEnvironmentRefreshResult {
  shell: string
  variableCount: number
  refreshedAt: number
}

export interface SystemEnvironmentCommandAvailability {
  name: string
  available: boolean
  path: Nullable<string>
}

export interface SystemEnvironmentInspection {
  os: { platform: SystemRuntimePlatform; arch: string; release: string; homeDir: string }
  shell: { path: string; variableCount: number; pathEntries: string[] }
  commands: SystemEnvironmentCommandAvailability[]
}

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

export interface SystemGlobalSearchResult {
  mode: SystemGlobalSearchMode
  rootPath: string
  count: number
  truncated: boolean
  entries?: SystemFileEntry[]
  matches?: SystemSearchMatch[]
}

export interface SystemToolInstallAlternative {
  id: string
  label: { 'zh-CN': string; 'en-US': string }
  description: { 'zh-CN': string; 'en-US': string }
  draft: { 'zh-CN': string; 'en-US': string }
}

export interface SystemToolPromptHint {
  toolId: string
  label: string
  commands: string[]
  availableCommand: string
  path: Nullable<string>
  prompt: string
}

export interface SystemToolInstallSuggestion {
  id: string
  toolId: string
  label: string
  command: string
  packageName: string
  reason: string
  installCommand: Nullable<string>
  installAvailable: boolean
  detectedAt: number
  triggeredBy: { scope: 'project' | 'system'; command: string }
  alternatives?: SystemToolInstallAlternative[]
}

export interface SystemToolInstallRequest { suggestionId: string }

export interface SystemToolInstallResult {
  suggestion: SystemToolInstallSuggestion
  installCommand: Nullable<string>
  commandResult: Nullable<SystemCommandResult>
  installed: boolean
  path: Nullable<string>
  message: string
}
