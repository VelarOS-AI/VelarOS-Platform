// 工作区沙箱事务契约：把源工作区 overlay 成隔离沙箱、在其中改动、再经 git 基线校验写回源。
// 语义属工作区域（文件事务的一种作用域形态），是全仓单一权威；tool-library 借它拼 ToolWorkspaceSandboxApi
// 端口、产品宿主的 WorkspaceSandboxService 结构化满足本契约，两侧都不重复定义。

/** 创建沙箱的入参：源根 + 归属（会话/执行/agent/task/父沙箱）。 */
interface WorkspaceSandboxCreateInput {
  sourceRoot: string
  sessionId: string
  ownerExecutionId: string
  ownerAgentId?: LooseOptional<string>
  ownerTaskId?: LooseOptional<string>
  parentSandboxId?: LooseOptional<string>
}

/** Child sandbox request accepted by an injected Workspace sandbox port. */
interface WorkspaceSandboxChildInput {
  sourceRoot?: string
  sessionId?: string
  ownerExecutionId: string
  ownerAgentId?: LooseOptional<string>
  ownerTaskId?: LooseOptional<string>
  parentSandboxId?: LooseOptional<string>
}

/** 沙箱创建时对源工作区拍下的基线指纹，用于写回时检测源是否已漂移。 */
interface WorkspaceSandboxBaseFingerprint {
  sourceRoot: string
  sourceHead: Nullable<string>
  baseCommit: string
  pathHashes: Record<string, string>
  capturedAt: number
}

/** 一个隔离沙箱实例。 */
interface WorkspaceSandbox {
  id: string
  branchKey: string
  root: string
  sourceRoot: string
  sourceBranch: Nullable<string>
  sessionId: string
  ownerExecutionId: string
  ownerAgentId: Nullable<string>
  ownerTaskId: Nullable<string>
  parentSandboxId: Nullable<string>
  baseCommit: string
  baseFingerprint: WorkspaceSandboxBaseFingerprint
  createdAt: number
}

/** 沙箱相对基线的变更集。 */
interface WorkspaceSandboxChanges {
  sandboxId: string
  sandboxRoot: string
  sourceRoot: string
  baseCommit: string
  changedPaths: string[]
  diff: string
  hasChanges: boolean
}

/** 写回前的校验上下文；宿主可据此在写回前跑验证。 */
interface WorkspaceWritebackVerificationContext {
  sourceRoot: string
  sandbox: WorkspaceSandbox
  changedPaths: string[]
}

/** 写回校验结果。 */
interface WorkspaceWritebackVerificationResult {
  passed: boolean
  summary?: string
  logs?: string[]
}

/** 把沙箱写回源工作区的入参。 */
interface WorkspaceWritebackInput {
  sandbox: WorkspaceSandbox
  verify?: (
    context: WorkspaceWritebackVerificationContext
  ) => Promise<WorkspaceWritebackVerificationResult>
}

/** 写回时检测到的冲突项（源自沙箱基线后被外部改动）。 */
interface WorkspaceWritebackConflict {
  path: string
  baseHash: Nullable<string>
  sourceHash: Nullable<string>
  reason: 'source-changed-since-sandbox-base'
}

/** 写回终态。 */
type WorkspaceWritebackStatus =
  | 'applied'
  | 'noop'
  | 'conflict'
  | 'apply_failed'
  | 'verification_failed'

/** 写回结果。 */
interface WorkspaceWritebackResult {
  status: WorkspaceWritebackStatus
  changedPaths: string[]
  conflicts: WorkspaceWritebackConflict[]
  verification?: WorkspaceWritebackVerificationResult
  errorMessage?: string
}

type WorkspaceSandboxMode = 'primary' | 'shared-child' | 'isolated-child'

/** Host-injected sandbox lifecycle. Workspace owns this contract; hosts own the implementation. */
interface WorkspaceSandboxPort {
  mode: WorkspaceSandboxMode
  current: WorkspaceSandbox
  createChildSandbox(input: WorkspaceSandboxChildInput): Promise<WorkspaceSandbox>
  writeBackSandbox(
    sandbox: WorkspaceSandbox,
    verify?: (
      context: WorkspaceWritebackVerificationContext
    ) => Promise<WorkspaceWritebackVerificationResult>
  ): Promise<{
    status: WorkspaceWritebackStatus
    changedPaths: string[]
    conflicts: readonly unknown[]
    verification?: unknown
    errorMessage?: string
  }>
  cleanupSandbox(sandbox: WorkspaceSandbox): Promise<void>
}

export type {
  WorkspaceSandbox,
  WorkspaceSandboxBaseFingerprint,
  WorkspaceSandboxChanges,
  WorkspaceSandboxChildInput,
  WorkspaceSandboxCreateInput,
  WorkspaceSandboxMode,
  WorkspaceSandboxPort,
  WorkspaceWritebackConflict,
  WorkspaceWritebackInput,
  WorkspaceWritebackResult,
  WorkspaceWritebackStatus,
  WorkspaceWritebackVerificationContext,
  WorkspaceWritebackVerificationResult,
}
