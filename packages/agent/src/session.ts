export type {
  AgentBackgroundAgent,
  AgentBackgroundAgentControlPort,
  AgentBackgroundAgentPort,
  AgentBackgroundAgentState,
  AgentSessionCatalogPort,
  AgentSessionCatalogQuery,
  AgentSessionLease,
  AgentSessionLeaseClaim,
  AgentSessionLeasePort,
  AgentSessionLifecycleStatus,
  AgentSessionMetadata,
  AgentSessionResourceReference,
  CreateAgentSessionMetadataInput,
} from './contract/requires'
export type { AgentSessionEventPort } from './contract/requires.js'
export {
  AgentSessionLeaseConflictError,
  isTerminalAgentBackgroundState,
  normalizeAgentSessionListLimit,
  resolveAgentSessionLeaseClaim,
} from './impl/errors/AgentSessionLeaseConflictError'
export { AgentGoalService } from './impl/product-session/AgentGoalService'
export { AgentPlanService } from './impl/product-session/AgentPlanService'
export { AgentQuestionService } from './impl/product-session/AgentQuestionService'
export type { AgentSessionApplicationEvent } from './types/product-session.js'
export type { AgentPlan, AgentPlanStatus, AgentPlanStep, AgentPlanStepStatus } from './types/product-session.js'
export type { AgentGoal, AgentGoalStatus } from './types/product-session.js'
export type { AgentQuestionRequest, AskAgentQuestionInput } from './types/product-session.js'
export type { AgentSessionArchiveEnvelope, AgentSessionArchiveEvent } from './types/product-session.js'
export type { AgentPermissionAction, AgentPermissionReply, AgentPermissionRequest, AgentPermissionRisk, AgentPermissionRule, RequestAgentPermissionInput } from './types/product-session.js'
export {
  createAgentSessionArchiveEnvelope,
  parseAgentSessionArchiveEnvelope,
  VelarosAgentSessionArchiveFormat,
  VelarosAgentSessionArchiveSchemaVersion,
} from './utils/product-session/archive'
export {
  agentPermissionWildcardMatch,
  evaluateAgentPermissionRules,
  findLastMatchingAgentPermissionRule,
  normalizeAgentPermissionPatterns,
  normalizeAgentPermissionRequest,
} from './utils/product-session/permissions'
export { AgentBackgroundAgentStateSchema, AgentSessionLifecycleStatusSchema } from './utils/wire/product-session.js'
