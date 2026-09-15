
/** Install request emitted by a Project command adapter without owning a System implementation. */
export interface ProjectToolInstallAlternative {
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

export interface ProjectToolInstallSuggestion {
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
    scope: 'project' | 'system'
    command: string
  }
  alternatives?: ProjectToolInstallAlternative[]
}

export interface ProjectAutoApprovalNotice {
  id: string
  path: string
  reason: string
  action: 'add' | 'mutation'
  message: string
  approvedAt: number
}

export interface ProjectAutoApprovalNoticeBlock {
  type: 'project-auto-approval'
  notice: ProjectAutoApprovalNotice
}

export interface ProjectRootEntry {
  path: string
  active: boolean
  exists: boolean
  removable: boolean
  /** 根目录的来源；目前只有项目根（'project'）。 */
  source: 'project'
}

export interface ProjectFileEntry {
  path: string
  type: 'file' | 'directory'
}

export interface ProjectListOptions {
  path?: string
  include?: string[]
  exclude?: string[]
  excludeGitignored?: boolean
  recursive?: boolean
  maxDepth?: number
  limit?: number
}

export interface ProjectFindFilesOptions {
  query?: string
  path?: string
  include?: string[]
  exclude?: string[]
  excludeGitignored?: boolean
  glob?: string
  limit?: number
  maxDepth?: number
  entryTypes?: Array<ProjectFileEntry['type']>
  pathMatchMode?: ProjectPathMatchMode
  extensions?: string[]
}

export type ProjectPathMatchMode = 'contains' | 'exact' | 'fuzzy'

export interface ProjectReadFileResult {
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

export interface ProjectSearchMatch {
  path: string
  line: number
  column: number
  excerpt: string
}

export interface ProjectSearchOptions {
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

export type ProjectCodeSymbolKind =
  | 'class'
  | 'enum'
  | 'export'
  | 'function'
  | 'interface'
  | 'type'
  | 'variable'

export interface ProjectCodeSymbol {
  path: string
  name: string
  kind: ProjectCodeSymbolKind
  line: number
  column: number
  exported: boolean
}

export interface ProjectFindSymbolsOptions {
  query?: string
  path?: string
  limit?: number
  exportedOnly?: boolean
  kinds?: ProjectCodeSymbolKind[]
  extensions?: string[]
}

export interface ProjectFindReferencesOptions {
  symbol: string
  path?: string
  limit?: number
  exactWord?: boolean
  extensions?: string[]
}

export type ProjectImportKind = 'dynamic-import' | 'export-from' | 'import' | 'require'

export interface ProjectImportRecord {
  path: string
  line: number
  column: number
  kind: ProjectImportKind
  specifier: string
  isRelative: boolean
}

export interface ProjectFindImportsOptions {
  path: string
  includeExternal?: boolean
}

export interface ProjectFindImportersOptions {
  targetPath: string
  path?: string
  limit?: number
  extensions?: string[]
}

export interface ProjectWriteFileResult {
  path: string
  bytes: number
  created: boolean
  changed: boolean
  message?: string
  change?: LooseOptional<ProjectFileChangeDescriptor>
}

export interface ProjectWriteFileOptions {
  overwrite?: boolean
}

export interface ProjectFileChangeDescriptor {
  changeId: string
  path: string
  created: boolean
  /** 本次变更新增的行数（仅对文本文件有效，二进制文件为 0）*/
  added: number
  /** 本次变更删除的行数（仅对文本文件有效，二进制文件为 0）*/
  removed: number
}

export interface ProjectDeleteFileResult {
  path: string
  deleted: true
}

export interface ProjectMoveFileResult {
  fromPath: string
  toPath: string
  overwritten: boolean
}

export interface ProjectApplyPatchOptions {
  dryRun?: boolean
}

export type ProjectApplyPatchFileAction = 'added' | 'deleted' | 'moved' | 'updated'

export interface ProjectApplyPatchFileResult {
  path: string
  action: ProjectApplyPatchFileAction
  operations: number
  replacements: number
  toPath?: string
  bytes: number
  changed: boolean
  change?: LooseOptional<ProjectFileChangeDescriptor>
}

export interface ProjectApplyPatchResult extends ProjectWriteFileResult {
  operations: number
  replacements: number
  dryRun: boolean
  changed: boolean
  files?: ProjectApplyPatchFileResult[]
}

export interface ProjectReplaceTextOptions {
  path: string
  search: string
  replace: string
  replaceAll?: boolean
  dryRun?: boolean
}

export interface ProjectReplaceTextResult extends ProjectWriteFileResult {
  replacements: number
  dryRun: boolean
  changed: boolean
}

export interface ProjectReplaceLinesOptions {
  path: string
  startLine: number
  endLine: number
  content: string
  dryRun?: boolean
}

export interface ProjectReplaceLinesResult extends ProjectWriteFileResult {
  startLine: number
  endLine: number
  dryRun: boolean
  changed: boolean
}

export interface ProjectBatchReplaceTextEdit {
  kind: 'replace_text'
  path: string
  search: string
  replace: string
  replaceAll?: boolean
}

export interface ProjectBatchReplaceLinesEdit {
  kind: 'replace_lines'
  path: string
  startLine: number
  endLine: number
  content: string
}

export interface ProjectBatchExactTextEdit {
  kind: 'exact_text'
  path: string
  oldText: string
  newText: string
}

export type ProjectBatchEdit =
  | ProjectBatchReplaceTextEdit
  | ProjectBatchReplaceLinesEdit
  | ProjectBatchExactTextEdit

export interface ProjectApplyEditsOptions {
  edits: ProjectBatchEdit[]
  dryRun?: boolean
}

export interface ProjectApplyEditsFileResult {
  path: string
  edits: number
  replacements: number
  bytes: number
  changed: boolean
  change?: LooseOptional<ProjectFileChangeDescriptor>
}

export interface ProjectApplyEditsResult {
  dryRun: boolean
  editCount: number
  changedFiles: number
  files: ProjectApplyEditsFileResult[]
}

export interface ProjectRunCommandOptions {
  cwd?: string
  timeoutMs?: number
  background?: boolean
  maxOutputChars?: number
  sessionId?: string
}

export interface ProjectBackgroundProcessInfo {
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

/** 项目宿主报告的输出采集事实，不依赖具体系统执行器。 */
export interface ProjectCommandOutputCapture {
  status: 'complete' | 'truncated' | 'failed'
  encoding: 'utf-8'
  totalBytes: number
  storedBytes: number
  omittedBytes: number
  decodeErrors: number
  error?: string
}

export interface ProjectCommandResult {
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
  capture?: ProjectCommandOutputCapture
  cleanupIncomplete?: boolean
  ownership?: { backend: 'windows-job' | 'process-tree'; parentDeathCleanup: boolean; reason: string }
  success: boolean
  backgroundProcess?: LooseOptional<ProjectBackgroundProcessInfo>
  verification: ProjectVerificationSummary
  systemToolSuggestion?: LooseOptional<ProjectToolInstallSuggestion>
}

export type ProjectVerificationKind = 'build' | 'lint' | 'test' | 'typecheck' | 'unknown'

export type ProjectVerificationStatus = 'aborted' | 'failed' | 'passed' | 'timed-out' | 'unknown'

export interface ProjectVerificationSummary {
  kind: ProjectVerificationKind
  status: ProjectVerificationStatus
  issues: string[]
}

export type ProjectPackageManager = 'bun' | 'npm' | 'pnpm' | 'unknown' | 'yarn'

export interface ProjectScript {
  name: string
  command: string
}

export type ProjectKind =
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

export interface ProjectMarker {
  path: string
  kind: ProjectKind | 'container' | 'task-runner'
  label: string
}

export interface ProjectInfo {
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

export interface ProjectGitFileStatusEntry {
  path: string
  originalPath?: string
  indexStatus: string
  workTreeStatus: string
}

export interface ProjectGitStatusResult {
  branch: Nullable<string>
  upstream: Nullable<string>
  ahead: number
  behind: number
  isClean: boolean
  changedFiles: number
  stagedFiles: number
  unstagedFiles: number
  untrackedFiles: number
  entries: ProjectGitFileStatusEntry[]
}

export interface ProjectGitBranch {
  name: string
  current: boolean
  upstream: Nullable<string>
  /** 本地分支或远程跟踪引用；旧调用方未提供时按本地分支处理。 */
  kind?: 'local' | 'remote'
  /** 最近一次提交时间，用于让分支菜单保持稳定、常用分支优先。 */
  lastCommitAt?: number
}

export interface ProjectGitLogEntry {
  sha: string
  shortSha: string
  subject: string
  authorName: string
  authorEmail: Nullable<string>
  authoredAt: number
  refs: string[]
}

export interface ProjectGitLogOptions {
  branch?: string
  limit?: number
  /** 限定为某个文件的历史（`git log --follow -- <path>`），用于「查看 Git 历史」。 */
  path?: string
}

export interface ProjectGitLineStats {
  additions: number
  deletions: number
  changedFiles: number
  binaryFiles: number
}

export interface ProjectGitCommitResult {
  commitSha: string
  message: string
  changedFiles: number
  lineStats: ProjectGitLineStats
}

export type ProjectGitRemoteAction = 'fetch' | 'update' | 'upload'

export type ProjectGitFileAction = 'discard' | 'stage' | 'unstage'

export interface ProjectGitRemoteActionOptions {
  githubToken?: string
  privateKeyPath?: string
  sshKeyPath?: string
}

export interface ProjectGitRemoteActionResult {
  action: ProjectGitRemoteAction
  branch: string
  upstream: Nullable<string>
  output: string
}

export interface ProjectGitFileActionResult {
  action: ProjectGitFileAction
  path: string
  status: ProjectGitStatusResult
}

export interface ProjectGitRestoreResult {
  commitSha: string
  changedFiles: number
}

export interface ProjectGitDiffOptions {
  commitSha?: string
  staged?: boolean
  path?: string
  originalPath?: string
  maxChars?: number
}

export interface ProjectGitDiffResult {
  scope: 'commit' | 'working' | 'staged'
  path?: string
  diff: string
  truncated: boolean
}

/** 项目写操作授权请求；这是全仓唯一权威定义。 */
export interface ProjectMutationAuthorizationInput {
  /** 可选当前工作目录。 */
  cwd?: string
  /** 操作名称，用于生成确认文案。 */
  operation: string
  /** 目标路径；为空时按 cwd 或当前 root 判断。 */
  targetPath?: LooseOptional<string>
  /** 授权通过后是否激活该 root。 */
  activate?: boolean
}

/** 项目变更的授权范围。 */
export type ProjectMutationAuthorizationScope = 'operation' | 'project'

/** 项目变更授权决策结果。 */
export interface ProjectAuthorizationDecision {
  /** 用户/策略是否允许本次操作。 */
  approved: boolean
  /** 本次决策对应的项目 root。 */
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
  projectAutoApprovalNotice?: ProjectAutoApprovalNotice
  /** 本次确认是否由会话风险确认策略完成。 */
  autoApproved?: boolean
  /** 授权范围。 */
  authorizationScope?: ProjectMutationAuthorizationScope
}

// ── 演练沙箱（与 @velaros-ai/system 的形状一致，两边互不引用；仓库层有镜像一致性测试） ──

/** 镜像时 gitignore 忽略的目录怎么处理：link 链接到真实目录（能读、写不进），copy 复制过来，skip 不要。忽略的文件一律不复制。 */
export type ProjectSandboxIgnoredMode = 'link' | 'copy' | 'skip'

/** 建沙箱的请求：source 是工具解析好的项目内绝对路径；network 为 false 时镜像里的命令连不上网。 */
export interface ProjectSandboxCreateRequest {
  source: string
  network: boolean
  ignored: ProjectSandboxIgnoredMode
}

/** 一个沙箱：id 就是目录名，root 是镜像根，source 是被镜像的项目目录。 */
export interface ProjectSandboxRecord {
  id: string
  root: string
  source: string
  createdAt: number
  network: boolean
  ignored: ProjectSandboxIgnoredMode
  fileCount: number
  bytes: number
  /** 链接到真实目录的忽略目录（相对路径）。 */
  linkedDirectories: string[]
  /** 源目录是 git 仓库：镜像里的 .git 已把推送地址改掉。 */
  git: boolean
}

/** 在镜像里跑一条命令：宿主把它约束在镜像根之内。 */
export interface ProjectSandboxRunOptions {
  sandboxId: string
  command: string
  timeoutMs?: number
  maxOutputChars?: number
}

/** 看差量的选项：maxFiles 限制新增与修改各列最多列多少条（默认 200），删除列不受限。 */
export interface ProjectSandboxDiffOptions {
  sandboxId: string
  maxFiles?: number
}

/** 一个文本文件的统一差量；超过预算时 truncated 为真、diff 被截断。 */
export interface ProjectSandboxTextDiff {
  path: string
  diff: string
  truncated: boolean
}

/** 镜像相对创建时的变化：三列相对路径（删除列永远完整），文本差量有界；gitChanged 表示 .git 里有东西变了。 */
export interface ProjectSandboxDiff {
  sandboxId: string
  source: string
  created: string[]
  modified: string[]
  deleted: string[]
  truncated: boolean
  gitChanged: boolean
  textDiffs: ProjectSandboxTextDiff[]
  omittedDiffs: number
  note?: string
}

/** 落回项目的选项：paths 只落这些相对路径，不给就全部。 */
export interface ProjectSandboxApplyOptions {
  sandboxId: string
  paths?: string[]
}

/** 落回的结果：三列是真正写进项目的相对路径；skippedGit 表示 .git 里的变化没有落（永远不落）。 */
export interface ProjectSandboxApplyResult {
  sandboxId: string
  created: string[]
  modified: string[]
  deleted: string[]
  skippedGit: boolean
}

/** 丢弃的结果：沙箱本来就不在时 removed 为 false。 */
export interface ProjectSandboxDiscardResult {
  sandboxId: string
  removed: boolean
}
