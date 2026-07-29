export type SystemCapabilityId =
  | 'workspace-roots'
  | 'open-path'
  | 'reveal-path'
  | 'open-application'
  | 'run-command'
  | 'shell-env-refresh'
export type SystemCommandScope = 'system' | 'workspace'
export type SystemCommandRunStatus = 'running' | 'passed' | 'failed' | 'timed-out'
export type SystemOpenPortProtocol = 'tcp'
export type SystemMetricLevel = 'normal' | 'warn' | 'high' | 'unknown'
export type SystemRecentLogSource = 'background-task' | 'command-run' | 'application'
export type SystemRecentLogLevel = 'info' | 'warn' | 'error' | 'unknown'
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

export interface SystemIntegrationDescriptor {
  id: string
  label: string
  description: string
  capabilities: SystemCapabilityId[]
}

export interface SystemRootEntry {
  path: string
  active: boolean
  exists: boolean
  removable: boolean
  source: 'project'
}

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

export interface SystemBrowserSiteContext {
  url: string
  workspaceRoot: string
}

export interface SystemOverview {
  providers: SystemIntegrationDescriptor[]
  workspaceRoots: SystemRootEntry[]
  activeWorkspaceRoot: string | null
  browserSiteContext: SystemBrowserSiteContext | null
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
  taskId: string | null
  sessionId: string | null
  pid: number | null
  logPath: string | null
  ports: number[]
  reason: string | null
  terminateCommand: string | null
  forceTerminateCommand: string | null
  fallbackTerminateCommand: string | null
  requested: boolean
  autoStarted: boolean
}

export interface SystemVerificationSummary {
  kind: 'build' | 'lint' | 'test' | 'typecheck' | 'unknown'
  status: 'aborted' | 'failed' | 'passed' | 'timed-out' | 'unknown'
  issues: string[]
}

export interface SystemCommandResult {
  command: string
  cwd: string
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  logPath?: string
  durationMs: number
  timedOut: boolean
  aborted: boolean
  truncated: boolean
  success: boolean
  backgroundProcess?: SystemBackgroundProcessInfo
  verification: SystemVerificationSummary
  systemToolSuggestion?: SystemToolInstallSuggestion | null
}

export interface SystemProcessInfo {
  pid: number
  ppid: number
  name: string
  command: string
  cwd: string | null
  startTime: string | null
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
  pid: number | null
  processName: string | null
  command: string | null
  address: string
  state: string | null
  cwd: string | null
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
  cpuUsagePercent: number | null
  cpuCoreCount: number
  memoryUsedBytes: number
  memoryTotalBytes: number
  memoryUsagePercent: number
  swapUsedBytes: number | null
  swapTotalBytes: number | null
  swapUsagePercent: number | null
  diskUsedBytes: number | null
  diskTotalBytes: number | null
  diskUsagePercent: number | null
  loadAverage: { oneMinute: number; fiveMinutes: number; fifteenMinutes: number }
  levels: Record<'cpu' | 'memory' | 'swap' | 'disk' | 'load', SystemMetricLevel>
  topProcesses: SystemProcessInfo[]
}

export interface SystemProjectDiscoveryOptions {
  rootPaths?: string[]
  maxDepth?: number
  limit?: number
  excludeNames?: string[]
  refresh?: boolean
}

export interface SystemProjectRescanResult {
  refreshedAt: number
  projectCount: number
  roots: string[]
  maxDepth: number
}

export interface SystemDiscoveredProject {
  path: string
  name: string
  projectKinds: string[]
  markers: never[]
  packageManager: string | null
  packageName?: string
  scripts: string[]
  hasGit: boolean
  repoRoot: string | null
  lastModifiedAt: number | null
  confidence: number
}

export interface SystemRecentProjectEntry extends SystemDiscoveredProject {
  score: number
  lastActiveAt: number | null
  evidence: string[]
  runningTaskCount: number
  hasUncommittedChanges: boolean
  gitBranch: string | null
}

export interface SystemActiveProjectInference {
  project: SystemRecentProjectEntry | null
  confidence: number
  evidence: string[]
  alternatives: SystemRecentProjectEntry[]
}

export interface SystemGitFileStatusEntry {
  path: string
  originalPath?: string
  indexStatus: string
  workTreeStatus: string
}

export interface SystemGitStatusResult {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  isClean: boolean
  changedFiles: number
  stagedFiles: number
  unstagedFiles: number
  untrackedFiles: number
  entries: SystemGitFileStatusEntry[]
}

export interface SystemProjectContextOptions { path?: string }

export interface SystemProjectContextSummary {
  project: SystemDiscoveredProject
  gitStatus: SystemGitStatusResult | null
  changedFiles: SystemGitFileStatusEntry[]
  runningTasks: SystemBackgroundTaskRecord[]
  openPorts: SystemOpenPortInfo[]
  recentCommandRuns: SystemCommandRunRecord[]
  recentFailedCommandRuns: SystemCommandRunRecord[]
  suggestedNextStep: string | null
}

export interface SystemRecentLogQueryOptions {
  limit?: number
  sources?: SystemRecentLogSource[]
  projectPath?: string
  taskId?: string
  runId?: string
  onlyErrors?: boolean
}

export interface SystemRecentLogEntry {
  id: string
  source: SystemRecentLogSource
  level: SystemRecentLogLevel
  occurredAt: number
  summary: string
  excerpt: string
  cwd: string | null
  projectPath: string | null
  pid: number | null
  taskId: string | null
  runId: string | null
  logPath: string | null
}

export interface SystemProcessProjectAssociationOptions extends SystemProjectDiscoveryOptions {
  pid?: number
  name?: string
  commandContains?: string
  onlyCurrentUser?: boolean
  includeUnmatched?: boolean
}

export interface SystemProcessProjectAssociation {
  process: SystemProcessInfo
  project: SystemDiscoveredProject | null
  confidence: number
  evidence: string[]
  ports: SystemOpenPortInfo[]
}

export interface SystemDevEnvironmentSummaryOptions extends SystemProjectDiscoveryOptions {
  logLimit?: number
  processLimit?: number
  portLimit?: number
}

export interface SystemDevEnvironmentSummary {
  generatedAt: number
  headline: string
  activeProject: SystemActiveProjectInference
  projectContext: SystemProjectContextSummary | null
  systemMetrics: SystemMetricsSnapshot
  relatedProcesses: SystemProcessProjectAssociation[]
  runningTasks: SystemBackgroundTaskRecord[]
  openPorts: SystemOpenPortInfo[]
  recentLogs: SystemRecentLogEntry[]
  risks: string[]
  suggestedNextStep: string | null
}

export interface SystemDevRuntimeDiagnosisOptions extends SystemProjectDiscoveryOptions {
  path?: string
  port?: number
  pid?: number
}

export interface SystemDevRuntimeDiagnosis {
  diagnosedAt: number
  target: { projectPath: string | null; pid: number | null; port: number | null }
  activeProject: SystemActiveProjectInference
  projectContext: SystemProjectContextSummary | null
  relatedProcesses: SystemProcessProjectAssociation[]
  runningTasks: SystemBackgroundTaskRecord[]
  openPorts: SystemOpenPortInfo[]
  recentLogs: SystemRecentLogEntry[]
  systemMetrics: SystemMetricsSnapshot
  risks: string[]
  suggestedNextStep: string | null
}

export interface SystemCommandRunRecord {
  id: string
  sessionId: string | null
  scope: SystemCommandScope
  command: string
  cwd: string
  startedAt: number
  finishedAt: number | null
  durationMs: number | null
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  success: boolean
  background: boolean
  pid: number | null
  logPath: string | null
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
  sessionId: string | null
  scope: SystemCommandScope
  command: string
  cwd: string
  pid: number
  logPath: string | null
  ports: number[]
  reason: string | null
  terminateCommand: string | null
  forceTerminateCommand: string | null
  fallbackTerminateCommand: string | null
  requested: boolean
  autoStarted: boolean
  startedAt: number
  updatedAt: number
  status: SystemBackgroundTaskStatus
  recentOutput: string | null
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
  sessionId: string | null
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
  path: string | null
}

export interface SystemEnvironmentInspection {
  os: { platform: SystemRuntimePlatform; arch: string; release: string; homeDir: string }
  shell: { path: string; variableCount: number; pathEntries: string[] }
  workspace: {
    systemWorkspaceRoot: string | null
    activeRoot: string | null
    configuredRoots: SystemRootEntry[]
    activeConfiguredRoot: string | null
  }
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
  path: string | null
  prompt: string
}

export interface SystemToolInstallSuggestion {
  id: string
  toolId: string
  label: string
  command: string
  packageName: string
  reason: string
  installCommand: string | null
  installAvailable: boolean
  detectedAt: number
  triggeredBy: { scope: 'workspace' | 'system'; command: string }
  alternatives?: SystemToolInstallAlternative[]
}

export interface SystemToolInstallRequest { suggestionId: string }

export interface SystemToolInstallResult {
  suggestion: SystemToolInstallSuggestion
  installCommand: string | null
  commandResult: SystemCommandResult | null
  installed: boolean
  path: string | null
  message: string
}
