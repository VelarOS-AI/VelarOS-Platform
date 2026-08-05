import type { ModelMessage } from 'ai'

import type {
  AgentRoleId,
  CustomSubAgentDefinition,
  CustomSubAgentDescriptor,
  SubAgentStructuredOutputContract,
  SubAgentUsage,
  TeamModelRouteCategory,
  ThinkingDepth,
  ToolCategoryId,
  ToolExecutionApi,
} from '@velaros-ai/agent/protocol'

import type {
  AgentChatRuntimeConfig,
  AgentSystemRuntimeConfig,
} from '../../agent/RuntimeConfiguration'
import type { SubAgentRuntimeOverride } from '../../team'
import type { ExecutionEventBus } from '../execution/ExecutionEventBus'

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
}
