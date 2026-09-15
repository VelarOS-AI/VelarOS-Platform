import type { ModelMessage } from 'ai'

import type { SubAgentRuntimeOverride } from '../impl/delegation/TeamModelRouter'
import type { ExecutionEventBus } from '../impl/records/ExecutionEventBus'

import type { ToolExecutionApi } from './agent'
import type { SubAgentStructuredOutputContract } from './agent-workflow'
import type {
  AgentChatRuntimeConfig,
  AgentSystemRuntimeConfig,
} from './runtime-configuration'
import type {
  CustomSubAgentDefinition,
  CustomSubAgentDescriptor,
  SubAgentUsage,
} from './sub-agent-task'
import type { AgentRoleId } from './system'
import type { TeamModelRouteCategory, ThinkingDepth } from './team'
import type { ToolCategoryId } from './tool'

export interface SubAgentConfigPort {
  readonly systemConfig: AgentSystemRuntimeConfig
  readonly chatConfig: AgentChatRuntimeConfig
}

export interface SubAgentQueryOptions {
  roleId?: AgentRoleId
  toolCategories?: ToolCategoryId[]
  allowedTools?: string[]
  requestToolCategories?: (
    categories: ToolCategoryId[],
    reason: string
  ) => Promise<SubAgentToolCategoryRequestResult>
  runtimeOverride?: SubAgentRuntimeOverride
  events?: ExecutionEventBus
  streamTextDeltas?: boolean
  identity?: string
  contextEpochScope?: string
  context?: string
  softDeadlineAt?: number
  consumeRelayedGuidance?: () => Nullable<string>
  initialHistory?: ModelMessage[]
  onHistoryUpdate?: (history: ModelMessage[]) => void
  workerAbortSignal?: AbortSignal
  structuredOutputContract?: SubAgentStructuredOutputContract
  onStructuredOutput?: (value: unknown) => void
  onUsage?: (usage: SubAgentUsage) => void
}

export interface SubAgentQueryRunner {
  query(
    task: string,
    parentCtx: SubAgentToolContext,
    opts: SubAgentQueryOptions
  ): Promise<string>
}

export interface CustomSubAgentRegistry {
  get(id: string): Nullable<CustomSubAgentDefinition>
  listDescriptors(): readonly CustomSubAgentDescriptor[]
}

export interface SubAgentDispatchInput {
  agentName?: string
  subagentType?: string
  toolScope?: 'type_default' | 'inherit' | 'custom'
  toolCategories?: ToolCategoryId[]
  prompt: string
  description?: string
  threadId?: string
  mode?: 'sync' | 'async'
  readonly?: boolean
  model?: string
  effort?: ThinkingDepth
  routeCategory?: TeamModelRouteCategory
  attachments?: string[]
  interrupt?: boolean
  structuredOutputContract?: SubAgentStructuredOutputContract
}

export interface SubAgentToolCategoryRequestResult {
  enabled: boolean
  approved: boolean
  autoApproved?: boolean
  reason?: string
  requestedCategories: ToolCategoryId[]
  enabledCategories: ToolCategoryId[]
  skippedCategories: ToolCategoryId[]
  message: string
}

export interface SubAgentCodingSession {
  getEnabledToolCategories: () => ToolCategoryId[]
  enableToolCategories: (categories: ToolCategoryId[], reason?: string) => ToolCategoryId[]
}

/**
 * Host-neutral delegation context.
 * Capability packages may extend the value structurally, but Agent Runtime only
 * reads the opaque resource identity and generic execution/session ports.
 */
export interface SubAgentToolContext {
  abortSignal: AbortSignal
  sessionId: string
  resourceId?: LooseOptional<string>
  codingSession: SubAgentCodingSession
  execution: Nullable<ToolExecutionApi>
  approval?: Pick<ToolExecutionApi, 'awaitConfirmation' | 'awaitConfirmationDecision'>
}
