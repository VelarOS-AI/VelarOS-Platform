// 工作区沙箱事务契约：把源工作区 overlay 成隔离沙箱、在其中改动、再经 git 基线校验写回源。
// 项目文件事务的隔离作用域合同；宿主可将其组合进自己的完整工具上下文。
// 端口、产品宿主的 ProjectSandboxService 结构化满足本契约，两侧都不重复定义。

/** 创建沙箱的入参：源根 + 归属（会话/执行/agent/task/父沙箱）。 */
interface ProjectSandboxCreateInput {
  sourceRoot: string
  sessionId: string
  ownerExecutionId: string
  ownerAgentId?: LooseOptional<string>
  ownerTaskId?: LooseOptional<string>
  parentSandboxId?: LooseOptional<string>
}

/** Child sandbox request accepted by an injected Project sandbox port. */
interface ProjectSandboxChildInput {
  sourceRoot?: string
  sessionId?: string
  ownerExecutionId: string
  ownerAgentId?: LooseOptional<string>
  ownerTaskId?: LooseOptional<string>
  parentSandboxId?: LooseOptional<string>
}

/** 沙箱创建时对源工作区拍下的基线指纹，用于写回时检测源是否已漂移。 */
interface ProjectSandboxBaseFingerprint {
  sourceRoot: string
  sourceHead: Nullable<string>
  baseCommit: string
  pathHashes: Record<string, string>
  capturedAt: number
}

/** 一个隔离沙箱实例。 */
interface ProjectSandbox {
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
  baseFingerprint: ProjectSandboxBaseFingerprint
  createdAt: number
}

/** 沙箱相对基线的变更集。 */
interface ProjectSandboxChanges {
  sandboxId: string
  sandboxRoot: string
  sourceRoot: string
  baseCommit: string
  changedPaths: string[]
  diff: string
  hasChanges: boolean
}

/** 写回前的校验上下文；宿主可据此在写回前跑验证。 */
interface ProjectWritebackVerificationContext {
  sourceRoot: string
  sandbox: ProjectSandbox
  changedPaths: string[]
}

/** 写回校验结果。 */
interface ProjectWritebackVerificationResult {
  passed: boolean
  summary?: string
  logs?: string[]
}

/** 把沙箱写回源工作区的入参。 */
interface ProjectWritebackInput {
  sandbox: ProjectSandbox
  verify?: (
    context: ProjectWritebackVerificationContext
  ) => Promise<ProjectWritebackVerificationResult>
}

/** 写回时检测到的冲突项（源自沙箱基线后被外部改动）。 */
interface ProjectWritebackConflict {
  path: string
  baseHash: Nullable<string>
  sourceHash: Nullable<string>
  reason: 'source-changed-since-sandbox-base'
}

/** 写回终态。 */
type ProjectWritebackStatus =
  | 'applied'
  | 'noop'
  | 'conflict'
  | 'apply_failed'
  | 'verification_failed'

/** 写回结果。 */
interface ProjectWritebackResult {
  status: ProjectWritebackStatus
  changedPaths: string[]
  conflicts: ProjectWritebackConflict[]
  verification?: ProjectWritebackVerificationResult
  errorMessage?: string
}

type ProjectSandboxMode = 'primary' | 'shared-child' | 'isolated-child'

/** Host-injected sandbox lifecycle. Project owns this contract; hosts own the implementation. */
interface ProjectSandboxPort {
  mode: ProjectSandboxMode
  current: ProjectSandbox
  createChildSandbox(input: ProjectSandboxChildInput): Promise<ProjectSandbox>
  writeBackSandbox(
    sandbox: ProjectSandbox,
    verify?: (
      context: ProjectWritebackVerificationContext
    ) => Promise<ProjectWritebackVerificationResult>
  ): Promise<{
    status: ProjectWritebackStatus
    changedPaths: string[]
    conflicts: readonly unknown[]
    verification?: unknown
    errorMessage?: string
  }>
  cleanupSandbox(sandbox: ProjectSandbox): Promise<void>
}

export type {
  ProjectSandbox,
  ProjectSandboxBaseFingerprint,
  ProjectSandboxChanges,
  ProjectSandboxChildInput,
  ProjectSandboxCreateInput,
  ProjectSandboxMode,
  ProjectSandboxPort,
  ProjectWritebackConflict,
  ProjectWritebackInput,
  ProjectWritebackResult,
  ProjectWritebackStatus,
  ProjectWritebackVerificationContext,
  ProjectWritebackVerificationResult,
}
