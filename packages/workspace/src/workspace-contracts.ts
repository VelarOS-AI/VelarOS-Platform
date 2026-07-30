import type { WorkspaceRootSource } from './workspace-root-source.js'

/** Install request emitted by a Workspace command adapter without owning a System implementation. */
export interface WorkspaceToolInstallAlternative {
  id: string
  label: {
    'zh-CN': string
    'en-US': string
  }
  description: {
    'zh-CN': string
    'en-US': string
  }
  draft: {
    'zh-CN': string
    'en-US': string
  }
}

export interface WorkspaceToolInstallSuggestion {
  id: string
  toolId: string
  label: string
  command: string
  packageName: string
  reason: string
  installCommand: Nullable<string>
  installAvailable: boolean
  detectedAt: number
  triggeredBy: {
    scope: 'workspace' | 'system'
    command: string
  }
  alternatives?: WorkspaceToolInstallAlternative[]
}

export interface WorkspaceAutoApprovalNotice {
  id: string
  path: string
  reason: string
  action: 'add' | 'mutation'
  message: string
  approvedAt: number
}

export interface WorkspaceAutoApprovalNoticeBlock {
  type: 'workspace-auto-approval'
  notice: WorkspaceAutoApprovalNotice
}

export interface WorkspaceRootEntry {
  path: string
  active: boolean
  exists: boolean
  removable: boolean
  source: WorkspaceRootSource
}

export interface WorkspaceFileEntry {
  path: string
  type: 'file' | 'directory'
}

export interface WorkspaceListOptions {
  path?: string
  include?: string[]
  exclude?: string[]
  excludeGitignored?: boolean
  recursive?: boolean
  maxDepth?: number
  limit?: number
}

export interface WorkspaceFindFilesOptions {
  query?: string
  path?: string
  include?: string[]
  exclude?: string[]
  excludeGitignored?: boolean
  glob?: string
  limit?: number
  maxDepth?: number
  entryTypes?: Array<WorkspaceFileEntry['type']>
  pathMatchMode?: WorkspacePathMatchMode
  extensions?: string[]
}

export type WorkspacePathMatchMode = 'contains' | 'exact' | 'fuzzy'

export interface WorkspaceReadFileResult {
  path: string
  content: string
  totalLines: number
  startLine: number
  endLine: number
  totalChars: number
  returnedChars: number
  truncated: boolean
  hasMore?: boolean
  remainingLines?: number
  nextStartLine?: LooseOptional<number>
}

export interface WorkspaceSearchMatch {
  path: string
  line: number
  column: number
  excerpt: string
}

export interface WorkspaceSearchOptions {
  query: string
  path?: string
  limit?: number
  caseSensitive?: boolean
  regex?: boolean
  glob?: string
  exclude?: string[]
  excludeGitignored?: boolean
  contextLines?: number
  extensions?: string[]
  maxResultsPerFile?: number
}

export type WorkspaceCodeSymbolKind =
  | 'class'
  | 'enum'
  | 'export'
  | 'function'
  | 'interface'
  | 'type'
  | 'variable'

export interface WorkspaceCodeSymbol {
  path: string
  name: string
  kind: WorkspaceCodeSymbolKind
  line: number
  column: number
  exported: boolean
}

export interface WorkspaceFindSymbolsOptions {
  query?: string
  path?: string
  limit?: number
  exportedOnly?: boolean
  kinds?: WorkspaceCodeSymbolKind[]
  extensions?: string[]
}

export interface WorkspaceFindReferencesOptions {
  symbol: string
  path?: string
  limit?: number
  exactWord?: boolean
  extensions?: string[]
}

export type WorkspaceImportKind = 'dynamic-import' | 'export-from' | 'import' | 'require'

export interface WorkspaceImportRecord {
  path: string
  line: number
  column: number
  kind: WorkspaceImportKind
  specifier: string
  isRelative: boolean
}

export interface WorkspaceFindImportsOptions {
  path: string
  includeExternal?: boolean
}

export interface WorkspaceFindImportersOptions {
  targetPath: string
  path?: string
  limit?: number
  extensions?: string[]
}

export interface WorkspaceWriteFileResult {
  path: string
  bytes: number
  created: boolean
  changed: boolean
  message?: string
  change?: LooseOptional<WorkspaceFileChangeDescriptor>
}

export interface WorkspaceWriteFileOptions {
  overwrite?: boolean
}

/** @deprecated 变更协调器已移除，工作区内核会在内部处理锁。 */
export interface WorkspaceMutationCoordinationInfo {
  queued: boolean
  waitedMs: number
  paths: string[]
  sessionId: string
  waitedForSessions: string[]
  message?: string
}

export interface WorkspaceFileChangeDescriptor {
  changeId: string
  path: string
  created: boolean
  /** 本次变更新增的行数（仅对文本文件有效，二进制文件为 0）*/
  added: number
  /** 本次变更删除的行数（仅对文本文件有效，二进制文件为 0）*/
  removed: number
}

export interface WorkspaceDeleteFileResult {
  path: string
  deleted: true
}

export interface WorkspaceMoveFileResult {
  fromPath: string
  toPath: string
  overwritten: boolean
}

export interface WorkspaceApplyPatchOptions {
  dryRun?: boolean
}

export type WorkspaceApplyPatchFileAction = 'added' | 'deleted' | 'moved' | 'updated'

export interface WorkspaceApplyPatchFileResult {
  path: string
  action: WorkspaceApplyPatchFileAction
  operations: number
  replacements: number
  toPath?: string
  bytes: number
  changed: boolean
  change?: LooseOptional<WorkspaceFileChangeDescriptor>
}

export interface WorkspaceApplyPatchResult extends WorkspaceWriteFileResult {
  operations: number
  replacements: number
  dryRun: boolean
  changed: boolean
  files?: WorkspaceApplyPatchFileResult[]
}

export interface WorkspaceReplaceTextOptions {
  path: string
  search: string
  replace: string
  replaceAll?: boolean
  dryRun?: boolean
}

export interface WorkspaceReplaceTextResult extends WorkspaceWriteFileResult {
  replacements: number
  dryRun: boolean
  changed: boolean
}

export interface WorkspaceReplaceLinesOptions {
  path: string
  startLine: number
  endLine: number
  content: string
  dryRun?: boolean
}

export interface WorkspaceReplaceLinesResult extends WorkspaceWriteFileResult {
  startLine: number
  endLine: number
  dryRun: boolean
  changed: boolean
}

export interface WorkspaceBatchReplaceTextEdit {
  kind: 'replace_text'
  path: string
  search: string
  replace: string
  replaceAll?: boolean
}

export interface WorkspaceBatchReplaceLinesEdit {
  kind: 'replace_lines'
  path: string
  startLine: number
  endLine: number
  content: string
}

export interface WorkspaceBatchExactTextEdit {
  kind: 'exact_text'
  path: string
  oldText: string
  newText: string
}

export type WorkspaceBatchEdit =
  | WorkspaceBatchReplaceTextEdit
  | WorkspaceBatchReplaceLinesEdit
  | WorkspaceBatchExactTextEdit

export interface WorkspaceApplyEditsOptions {
  edits: WorkspaceBatchEdit[]
  dryRun?: boolean
}

export interface WorkspaceApplyEditsFileResult {
  path: string
  edits: number
  replacements: number
  bytes: number
  changed: boolean
  change?: LooseOptional<WorkspaceFileChangeDescriptor>
}

export interface WorkspaceApplyEditsResult {
  dryRun: boolean
  editCount: number
  changedFiles: number
  files: WorkspaceApplyEditsFileResult[]
}

export interface WorkspaceRunCommandOptions {
  cwd?: string
  timeoutMs?: number
  background?: boolean
  maxOutputChars?: number
  sessionId?: string
}

export interface WorkspaceBackgroundProcessInfo {
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

export interface WorkspaceCommandResult {
  command: string
  cwd: string
  exitCode: Nullable<number>
  signal: Nullable<string>
  stdout: string
  stderr: string
  logPath?: LooseOptional<string>
  durationMs: number
  timedOut: boolean
  aborted: boolean
  truncated: boolean
  success: boolean
  backgroundProcess?: LooseOptional<WorkspaceBackgroundProcessInfo>
  verification: WorkspaceVerificationSummary
  systemToolSuggestion?: LooseOptional<WorkspaceToolInstallSuggestion>
}

export type WorkspaceVerificationKind = 'build' | 'lint' | 'test' | 'typecheck' | 'unknown'

export type WorkspaceVerificationStatus = 'aborted' | 'failed' | 'passed' | 'timed-out' | 'unknown'

export interface WorkspaceVerificationSummary {
  kind: WorkspaceVerificationKind
  status: WorkspaceVerificationStatus
  issues: string[]
}

export type WorkspacePackageManager = 'bun' | 'npm' | 'pnpm' | 'unknown' | 'yarn'

export interface WorkspaceProjectScript {
  name: string
  command: string
}

export type WorkspaceProjectKind =
  | 'cpp'
  | 'go'
  | 'java'
  | 'javascript'
  | 'make'
  | 'php'
  | 'python'
  | 'ruby'
  | 'rust'
  | 'unknown'

export interface WorkspaceProjectMarker {
  path: string
  kind: WorkspaceProjectKind | 'container' | 'task-runner'
  label: string
}

export interface WorkspaceProjectInfo {
  name: Nullable<string>
  version: Nullable<string>
  packageManager: Nullable<string>
  framework: Nullable<string>
  language: string
  scripts: string[]
  hasTests: boolean
  hasBuild: boolean
  hasLint: boolean
  hasTypeCheck: boolean
}

export type WorkspaceVerificationGoal = 'quick' | 'standard' | 'thorough'

export interface WorkspaceVerificationSuggestion {
  command: string
  label?: string
  priority: number
}

export interface WorkspaceSuggestVerificationOptions {
  changedPaths?: string[]
  goal?: WorkspaceVerificationGoal
}

export interface WorkspaceVerificationPlan {
  goal: WorkspaceVerificationGoal
  suggestions: WorkspaceVerificationSuggestion[]
  notes?: string[]
}

export interface WorkspaceImpactImporter {
  targetPath: string
  importerPath: string
  depth: number
}

export interface WorkspaceAnalyzeImpactOptions {
  changedPaths?: string[]
  maxDepth?: number
}

export interface WorkspaceImpactAnalysis {
  changedPaths: string[]
  affectedPaths: string[]
  importers: WorkspaceImpactImporter[]
  relatedTestPaths: string[]
  maxDepth: number
}

export interface WorkspaceRunVerificationOptions {
  changedPaths?: string[]
  goal?: WorkspaceVerificationGoal
  maxCommands?: number
  stopOnFailure?: boolean
}

export interface WorkspaceVerificationRunStep {
  suggestion: WorkspaceVerificationSuggestion
  result: WorkspaceCommandResult
}

export interface WorkspaceVerificationRunResult {
  plan: WorkspaceVerificationPlan
  steps: WorkspaceVerificationRunStep[]
  overallStatus: WorkspaceVerificationStatus
  stoppedEarly: boolean
}

export interface WorkspaceGitFileStatusEntry {
  path: string
  originalPath?: string
  indexStatus: string
  workTreeStatus: string
}

export interface WorkspaceGitStatusResult {
  branch: Nullable<string>
  upstream: Nullable<string>
  ahead: number
  behind: number
  isClean: boolean
  changedFiles: number
  stagedFiles: number
  unstagedFiles: number
  untrackedFiles: number
  entries: WorkspaceGitFileStatusEntry[]
}

export interface WorkspaceGitBranch {
  name: string
  current: boolean
  upstream: Nullable<string>
  /** 本地分支或远程跟踪引用；旧调用方未提供时按本地分支处理。 */
  kind?: 'local' | 'remote'
  /** 最近一次提交时间，用于让分支菜单保持稳定、常用分支优先。 */
  lastCommitAt?: number
}

export interface WorkspaceGitLogEntry {
  sha: string
  shortSha: string
  subject: string
  authorName: string
  authorEmail: Nullable<string>
  authoredAt: number
  refs: string[]
}

export interface WorkspaceGitLogOptions {
  branch?: string
  limit?: number
  /** 限定为某个文件的历史（`git log --follow -- <path>`），用于「查看 Git 历史」。 */
  path?: string
}

export interface WorkspaceGitLineStats {
  additions: number
  deletions: number
  changedFiles: number
  binaryFiles: number
}

export interface WorkspaceGitCommitResult {
  commitSha: string
  message: string
  changedFiles: number
  lineStats: WorkspaceGitLineStats
}

export type WorkspaceGitRemoteAction = 'fetch' | 'update' | 'upload'

export type WorkspaceGitFileAction = 'discard' | 'stage' | 'unstage'

export interface WorkspaceGitRemoteActionOptions {
  githubToken?: string
  privateKeyPath?: string
  sshKeyPath?: string
}

export interface WorkspaceGitRemoteActionResult {
  action: WorkspaceGitRemoteAction
  branch: string
  upstream: Nullable<string>
  output: string
}

export interface WorkspaceGitFileActionResult {
  action: WorkspaceGitFileAction
  path: string
  status: WorkspaceGitStatusResult
}

export interface WorkspaceGitRestoreResult {
  commitSha: string
  changedFiles: number
}

export interface WorkspaceGitDiffOptions {
  commitSha?: string
  staged?: boolean
  path?: string
  originalPath?: string
  maxChars?: number
}

export interface WorkspaceGitDiffResult {
  scope: 'commit' | 'working' | 'staged'
  path?: string
  diff: string
  truncated: boolean
}

/** 工作区写操作授权请求(全仓唯一权威;app/包侧曾四份漂移,一律 re-export 本定义)。 */
export interface WorkspaceMutationAuthorizationInput {
  /** 可选当前工作目录。 */
  cwd?: string
  /** 操作名称，用于生成确认文案。 */
  operation: string
  /** 目标路径；为空时按 cwd 或当前 root 判断。 */
  targetPath?: LooseOptional<string>
  /** 授权通过后是否激活该 root。 */
  activate?: boolean
}

/** 授权范围。当前策略进入工作区后统一为 workspace。 */
export type WorkspaceMutationAuthorizationScope = 'operation' | 'workspace'

/** 工作区授权决策结果(全仓唯一权威)。 */
export interface WorkspaceAuthorizationDecision {
  /** 用户/策略是否允许本次操作。 */
  approved: boolean
  /** 本次决策对应的工作区 root。 */
  rootPath: string
  /** 是否发生了 active root 切换。 */
  switched: boolean
  /** 目标 root 是否原本就已授权。 */
  alreadyAuthorized: boolean
  /** 拒绝时给工具/模型看的原因。 */
  rejectionMessage: Nullable<string>
  /** 成功或拒绝的可读说明。 */
  message: string
  /** 本次没有立即激活，而是发出了非阻塞提示。 */
  deferred?: boolean
  /** 会话风险确认自动批准触发时的可见 UI 记录。 */
  workspaceAutoApprovalNotice?: WorkspaceAutoApprovalNotice
  /** 本次确认是否由会话风险确认策略完成。 */
  autoApproved?: boolean
  /** 授权范围。 */
  authorizationScope?: WorkspaceMutationAuthorizationScope
}
