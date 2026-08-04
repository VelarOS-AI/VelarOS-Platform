export type SystemCommandScope = 'system' | 'project'
export type SystemCommandRunStatus = 'running' | 'passed' | 'failed' | 'timed-out'
export type SystemOpenPortProtocol = 'tcp'
export type SystemMetricLevel = 'normal' | 'warn' | 'high' | 'unknown'
export type SystemGlobalSearchMode = 'paths' | 'content'
export type SystemGlobalSearchPathMatchMode = 'contains' | 'exact' | 'fuzzy'
export type SystemBackgroundTaskStatus = 'running' | 'exited' | 'unknown'
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
  limit?: number
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
