import type { ModelMessage } from 'ai'

import type { Logger } from '@velaros-ai/core/logger'
import type { ApprovalPort, InteractionPort } from '@velaros-ai/core/tool-contract'
import type {
  AgentDelegationContract,
  AgentDeveloperContext,
  AgentRoleId,
  AgentSkillDescriptor,
  AgentSurfaceId,
  AgentWorkflowDefinition,
  AgentWorkflowRunResult,
  AppLocale,
  ChatContextEvidenceRecord,
  SessionLineageContext,
  SubAgentStructuredOutputContract,
  SubAgentUsage,
  ToolAvailabilityScope,
  ToolCategoryId,
  ToolCategoryOverview,
  ToolDescriptor,
  ToolExecutionApi,
  ToolPermission,
  ToolSurfaceProfileId,
} from '@velaros-ai/core/types'

import type { ContextPayloadStore } from '../agent/context/ContextPayloadStore'
import type { AgentRuntimeCapabilityPorts } from '../capabilities'
import type {
  SubAgentDispatchInput,
  SubAgentToolCategoryRequestResult,
} from '../kernel/dispatch/host-ports'
import type { ExecutionEventBus } from '../kernel/execution/ExecutionEventBus'
import type { SubAgentRuntimeOverride } from '../team/model-router'
import type { ToolCapabilityPage } from '../tools/capability-types'

import type { ToolActiveContextApi } from './context/ActiveContextTypes'
import type { ToolCodingSessionApi } from './context/CodingSessionTypes'
import type { ToolConversationContextApi } from './context/ConversationContextTypes'
import type { ToolRoleApi } from './context/RoleContextTypes'
import type { ToolRuntimeApi } from './context/RuntimeContextTypes'

export type { ToolActiveContextApi } from './context/ActiveContextTypes'
export type { ToolCodingSessionApi } from './context/CodingSessionTypes'
export type { ToolConversationContextApi } from './context/ConversationContextTypes'
export type { ToolRoleApi } from './context/RoleContextTypes'
export type { ToolRuntimeApi } from './context/RuntimeContextTypes'

export interface ToolRuntimeEvidenceApi {
  record: (records: readonly ChatContextEvidenceRecord[]) => void
  list: () => readonly ChatContextEvidenceRecord[]
}

export interface ToolRoleSkillReadResult {
  descriptor: AgentSkillDescriptor
  markdown: string
}

export interface ToolSkillsApi {
  listRoleSkills: () => AgentSkillDescriptor[]
  readRoleSkill: (skillId: string) => Nullable<ToolRoleSkillReadResult>
  isSkillSelected?: (skillId: string) => boolean
}

export interface ToolBackgroundJobOutputSnapshot {
  id: string
  sessionId: string
  parentSessionId?: string
  kind: string
  label: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  truncated?: boolean
  omittedChars?: number
  artifactError?: string
  output: string
}

export interface ReadToolBackgroundJobOutputInput {
  jobId: string
  mode: 'incremental' | 'snapshot'
}

export interface WaitToolBackgroundJobsInput {
  jobIds?: readonly string[]
  timeoutMs?: number
}

export interface CancelToolBackgroundJobInput {
  jobId: string
}

/**
 * Host-neutral tool execution context.
 *
 * Concrete product APIs are deliberately not members of this contract. Capability packages
 * extend the product context and register behavior through AgentRuntimeCapabilityPorts.
 */
export interface KernelToolContext {
  abortSignal: AbortSignal
  log: Logger
  windowId: number
  sessionId: string
  capabilityScope?: LooseOptional<string>
  capabilityPorts?: AgentRuntimeCapabilityPorts
  sessionLineage?: LooseOptional<SessionLineageContext>
  locale: AppLocale
  selectedSkillIds: string[]
  developerContext?: LooseOptional<AgentDeveloperContext>
  agentSurfaceId?: LooseOptional<AgentSurfaceId>
  runtime?: ToolRuntimeApi
  grantedPermissions: ReadonlySet<ToolPermission>
  planningMode: boolean
  proposalMode: boolean
  isToolSystemEnabled: (toolName: string) => boolean
  codingSession: ToolCodingSessionApi
  skills: ToolSkillsApi
  activeContext: ToolActiveContextApi
  conversation: ToolConversationContextApi
  contextPayloadStore?: ContextPayloadStore
  evidenceLedger?: readonly ChatContextEvidenceRecord[]
  runtimeEvidence?: ToolRuntimeEvidenceApi
  role: ToolRoleApi
  approval: ApprovalPort
  interaction: InteractionPort
  execution: Nullable<ToolExecutionApi>
  listTools: (scope?: ToolAvailabilityScope) => ToolDescriptor[]
  listToolCategories: (scope?: ToolAvailabilityScope) => ToolCategoryOverview[]
  listCapabilityPages?: () => ToolCapabilityPage[]
  describeToolInputSchema?: (
    toolName: string
  ) => Nullable<{ profileId: ToolSurfaceProfileId | 'base'; description: string; schema: unknown }>
  getEnabledToolCategories: () => ToolCategoryId[]
  getCurrentVisibleToolNames: () => string[]
  setCurrentVisibleToolNames: (toolNames: string[]) => void
  getCurrentVisibleToolRegistrationSignature?: (toolName: string) => Nullable<string>
  setCurrentVisibleToolRegistrationSignatures?: (signatures: Record<string, string>) => void
  getCurrentVisibleToolSurfaceProfile: (
    toolName: string
  ) => Nullable<ToolSurfaceProfileId | 'base'>
  setCurrentVisibleToolSurfaceProfiles: (
    profiles: Record<string, ToolSurfaceProfileId | 'base'>
  ) => void
  query: (task: string, opts?: SubAgentOptions) => Promise<string>
  dispatchSubAgent?: (input: SubAgentDispatchInput) => Promise<string>
  runAgentWorkflow?: (input: AgentWorkflowDefinition) => Promise<AgentWorkflowRunResult>
  readBackgroundJobOutput?: (
    input: ReadToolBackgroundJobOutputInput
  ) => Promise<Nullable<ToolBackgroundJobOutputSnapshot>>
  waitBackgroundJobs?: (
    input: WaitToolBackgroundJobsInput
  ) => Promise<ToolBackgroundJobOutputSnapshot[]>
  cancelBackgroundJob?: (
    input: CancelToolBackgroundJobInput
  ) => Promise<Nullable<ToolBackgroundJobOutputSnapshot>>
  requestToolCategoryAccess?: (
    categories: ToolCategoryId[],
    reason: string
  ) => Promise<SubAgentToolCategoryRequestResult>
}

export interface SubAgentOptions {
  toolCategories?: ToolCategoryId[]
  allowedTools?: string[]
  identity?: string
  contextEpochScope?: string
  context?: string
  roleId?: AgentRoleId
  delegation?: AgentDelegationContract
  runtimeOverride?: SubAgentRuntimeOverride
  events?: ExecutionEventBus
  requestToolCategories?: (
    categories: ToolCategoryId[],
    reason: string,
    options?: { childRoleId?: AgentRoleId }
  ) => Promise<SubAgentToolCategoryRequestResult>
  streamTextDeltas?: boolean
  softDeadlineAt?: number
  turnCapDisabled?: boolean
  consumeRelayedGuidance?: () => Nullable<string>
  initialHistory?: ModelMessage[]
  onHistoryUpdate?: (history: ModelMessage[]) => void
  workerAbortSignal?: AbortSignal
  structuredOutputContract?: SubAgentStructuredOutputContract
  onStructuredOutput?: (value: unknown) => void
  onUsage?: (usage: SubAgentUsage) => void
}
