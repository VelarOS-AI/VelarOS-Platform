// Agent Host 仅看到精简的 `project:*` 项目能力面，事务阶段留在领域内部。
export type {
  ProjectAuthorizationDecision,
  ProjectToolApi,
  ProjectToolContext,
} from '../contract/requires'
export type { AgentProjectKernelPort } from '../contract/requires.js'
export { projectCodeOperations } from '../impl/operations/ProjectCodeOperations.js'
export { createProjectCodeAnalysisTools, projectChangeTools, projectCodeTools, projectExecutionTools, projectFileTools, projectTools } from '../impl/ProjectTools.js'
export type { AgentProjectApplyResult, AgentProjectCommandToolRequirement, AgentProjectDiagnostic, AgentProjectDiffResult, AgentProjectErrorLike,AgentProjectFileSnapshot, AgentProjectFixResult, AgentProjectKernelReadResult, AgentProjectPreparedPatch, AgentProjectPreparedTransaction, AgentProjectReadContinuation, AgentProjectReadIssue, AgentProjectReadRequest, AgentProjectReadResult, AgentProjectResolveTargetResult, AgentProjectSearchHit, AgentProjectSearchRequest, AgentProjectSearchResult, AgentProjectStoredTransaction, AgentProjectValidationResult } from '../types/agent-port.js'
export { registerProjectFileContext } from '../utils/agent/file-context'
export * from '../utils/agent/kernel-port'
export { finalizeProjectModelResult } from '../utils/agent/source-window'
export type {
  ProjectCodeIndexQuery,
  ProjectCodeLanguageQuery,
  ProjectCodeQuery,
} from '../utils/schemas/code-query.js'
