import type { ModelMessage } from 'ai'

import type { Logger } from '@velaros-ai/core/logger'

import type { ContextPayloadStore } from '../impl/context/InMemoryContextPayloadStore'
import type { SubAgentRuntimeOverride } from '../impl/delegation/TeamModelRouter'
import type { ExecutionEventBus } from '../impl/records/ExecutionEventBus'
import type { ApprovalPort } from '../impl/tools/DefaultDenyApprovalPort'
import type { InteractionPort } from '../impl/tools/UnsupportedInteractionPort'
import type { AgentRuntimeCapabilityPorts } from '../utils/capabilities'
import type { SubAgentDispatchCatalog } from '../utils/delegation/sub-agent-type-registry'

import type { ToolActiveContextApi } from './active-context-types'
import type {
  AgentDeveloperContext,
  AgentSurfaceId,
  ToolExecutionApi,
} from './agent'
import type {
  AgentWorkflowDefinition,
  AgentWorkflowRunResult,
  SubAgentStructuredOutputContract,
} from './agent-workflow'
import type { ToolCapabilityPage } from './capability-types'
import type { ToolCodingSessionApi } from './coding-session-types'
import type { ToolConversationContextApi } from './conversation-context-types'
import type {
  SubAgentDispatchInput,
  SubAgentToolCategoryRequestResult,
} from './dispatch-host-ports'
import type { ToolRoleApi } from './role-context-types'
import type { ToolRuntimeApi } from './runtime-context-types'
import type { AgentSkillDescriptor } from './skill'
import type { SessionLineageContext } from './storage'
import type { SubAgentUsage } from './sub-agent-task'
import type { AgentDelegationContract, AgentRoleId, AppLocale } from './system'
import type {
  AgentModelInputModality,
  ToolAvailabilityScope,
  ToolCategoryId,
  ToolCategoryOverview,
  ToolDescriptor,
  ToolSurfaceProfileId,
} from './tool'

export type { ToolActiveContextApi } from './active-context-types'
export type { ToolCodingSessionApi } from './coding-session-types'
export type { ToolConversationContextApi } from './conversation-context-types'
export type { ToolRoleApi } from './role-context-types'
export type { ToolRuntimeApi } from './runtime-context-types'

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
  planningMode: boolean
  isToolSystemEnabled: (toolName: string) => boolean
  codingSession: ToolCodingSessionApi
  skills: ToolSkillsApi
  activeContext: ToolActiveContextApi
  conversation: ToolConversationContextApi
  contextPayloadStore?: ContextPayloadStore
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
  /** 本轮实际模型可消费的输入类型；由 loop 在模型解析后、工具发现前刷新。 */
  getSupportedModelInputModalities: () => readonly AgentModelInputModality[]
  setSupportedModelInputModalities: (
    modalities: readonly AgentModelInputModality[]
  ) => void
  /** provider 传输名 → canonical tool id；只对本轮已曝光工具有效。 */
  resolveCurrentVisibleCanonicalToolName?: (providerToolName: string) => Nullable<string>
  /**
   * provider 传输名 → 已注册 canonical id；用于把未驻留调用归入正确工具页，绝不授予执行权。
   */
  resolveKnownCanonicalToolName?: (providerToolName: string) => Nullable<string>
  /** canonical tool id → provider 传输名；编译历史回放时使用。 */
  getCurrentVisibleProviderToolName?: (canonicalToolName: string) => Nullable<string>
  getCurrentVisibleToolTransportNames?: () => Readonly<Record<string, string>>
  setCurrentVisibleToolTransportNames?: (canonicalToProvider: Record<string, string>) => void
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
  getSubAgentDispatchCatalog?: () => SubAgentDispatchCatalog
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
  consumeRelayedGuidance?: () => Nullable<string>
  initialHistory?: ModelMessage[]
  onHistoryUpdate?: (history: ModelMessage[]) => void
  workerAbortSignal?: AbortSignal
  structuredOutputContract?: SubAgentStructuredOutputContract
  onStructuredOutput?: (value: unknown) => void
  onUsage?: (usage: SubAgentUsage) => void
}
