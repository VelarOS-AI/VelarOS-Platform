import type {
  AgentDeveloperContext,
  AgentSurfaceId,
  AgentWorkflowDefinition,
  AgentWorkflowRunResult,
  CapabilityScopeId,
  ChatContextEvidenceRecord,
  ChatPromptFeatureId,
  SessionLineageContext,
  ToolCategoryId,
  ToolExecutionApi,
} from '@velaros-ai/agent/protocol'
import type { ScopedLog } from '@velaros-ai/core/logger'

import type {
  AgentRuntimeCapabilityPorts,
  CapabilityValidationInterpreter,
} from '../../capabilities'
import type { SubAgentDispatchInput } from '../../kernel/dispatch/host-ports'
import type { ExecutionEventBus } from '../../kernel/execution/ExecutionEventBus'
import type { CodingSessionSnapshot, RuntimeReminderProducer } from '../../reminders'
import type { RuntimePromptFeaturePolicy } from '../../tools'
import type {
  CodingSessionToolCategoryToolNames,
  CodingSessionToolContext,
} from '../CodingSessionTracker'
import type {
  AgentModelProvider,
  AgentModelResolverPort,
  ResolvedAgentModelRuntime,
} from '../model'
import type { PrimaryAgentProfile } from '../PrimaryAgentProfile'
import type { QueryLoopSubAgentOptions, QueryLoopToolContext } from '../QueryLoop'
import type {
  AgentChatRuntimeConfig,
  AgentExecutionConfig,
  AgentSystemRuntimeConfig,
} from '../RuntimeConfiguration'
import type { SoloLoopToolContext } from '../SoloLoop'

export type RunnerAgentProvider = AgentModelProvider
export type RunnerResolvedAgentRuntime = ResolvedAgentModelRuntime
export type RunnerModelCapabilityPort = AgentModelResolverPort

export interface RunnerModelRuntimePort extends RunnerModelCapabilityPort {
  handleStreamError(
    error: unknown,
    turn: number,
    abortSignal: AbortSignal,
    events: ExecutionEventBus,
    log: ScopedLog
  ): void
  emitDone(events: ExecutionEventBus): void
  emitAbort(events: ExecutionEventBus, message?: string): void
}

export interface RunnerConfigService {
  readonly systemConfig: AgentSystemRuntimeConfig
  readonly chatConfig: AgentChatRuntimeConfig
}

export interface RunnerSessionContextSnapshot {
  evidenceLedger: readonly ChatContextEvidenceRecord[]
  contextView: unknown
}

export interface RunnerChatStateStore {
  loadSessionContextSnapshot(sessionId: string): Promise<RunnerSessionContextSnapshot>
}

export interface RunnerToolRegistry {
  readonly names: string[]
}

export interface RunnerSubAgentDispatcher<TToolContext extends RunnerToolContext> {
  dispatch(request: {
    input: SubAgentDispatchInput
    parentCtx: TToolContext
    events: ExecutionEventBus
    config: AgentExecutionConfig
  }): Promise<string>
  clearExecution(executionKey: string): void
}

export interface RunnerCodingSessionPolicyBundle {
  promptFeaturePolicy: RuntimePromptFeaturePolicy
  toolCategoryToolNames: CodingSessionToolCategoryToolNames
  externalTouchCooldownMs?: number
  normalizeResourceId?: (raw: string) => LooseOptional<string>
  validationInterpreters?: readonly CapabilityValidationInterpreter[]
  reminderProducers?: readonly RuntimeReminderProducer[]
  activityCategories?: {
    inspection?: readonly ToolCategoryId[]
    mutation?: readonly ToolCategoryId[]
    validation?: readonly ToolCategoryId[]
    nonCodeMutation?: readonly ToolCategoryId[]
  }
}

export type RunnerSubAgentOptions = QueryLoopSubAgentOptions<ExecutionEventBus>

export type RunnerReadBackgroundJobOutput = (input: {
  jobId: string
  mode: 'incremental' | 'snapshot'
}) => Promise<unknown>
export type RunnerWaitBackgroundJobs = (input: {
  jobIds?: readonly string[]
  timeoutMs?: number
}) => Promise<unknown>
export type RunnerCancelBackgroundJob = (input: { jobId: string }) => Promise<unknown>

export interface RunnerContextCodingSession {
  getActiveCapabilityScope: () => CapabilityScopeId
  getSnapshot: () => CodingSessionSnapshot
  mergeSnapshot?: (snapshot: CodingSessionSnapshot) => void
  forkForSubAgent?: () => this
  hasPromptFeatureAccess: (feature: ChatPromptFeatureId) => boolean
}

export type RunnerToolContext = SoloLoopToolContext &
  QueryLoopToolContext & {
    sessionId: string
    resourceId?: LooseOptional<string>
    proposalMode: boolean
    agentSurfaceId?: LooseOptional<AgentSurfaceId>
    developerContext?: LooseOptional<AgentDeveloperContext>
    sessionLineage?: LooseOptional<SessionLineageContext>
    execution?: LooseOptional<ToolExecutionApi>
    codingSession: RunnerContextCodingSession
    readBackgroundJobOutput?: RunnerReadBackgroundJobOutput
    waitBackgroundJobs?: RunnerWaitBackgroundJobs
    cancelBackgroundJob?: RunnerCancelBackgroundJob
  }

export interface RunnerToolContextBuilder<TToolContext extends RunnerToolContext> {
  buildToolContext(args: RunnerBuildToolContextArgs): TToolContext
}

export interface RunnerBuildToolContextArgs {
  abortController: AbortController
  config: Partial<AgentExecutionConfig>
  codingSession: object
  sessionContext?: {
    evidenceLedger?: readonly ChatContextEvidenceRecord[]
  }
  roleState: {
    getAllowedToolNames: () => string[]
    getEnabledToolCategories: () => ToolCategoryId[]
    getResolution: () => ReturnType<PrimaryAgentProfile['resolve']>
  }
  disabledToolNames: string[]
  capabilityPorts?: AgentRuntimeCapabilityPorts
  resourceId?: LooseOptional<string>
  execution?: LooseOptional<ToolExecutionApi>
  events?: ExecutionEventBus
  query(task: string, opts?: RunnerSubAgentOptions): Promise<string>
  dispatchSubAgent?(input: SubAgentDispatchInput): Promise<string>
  runAgentWorkflow?(input: AgentWorkflowDefinition): Promise<AgentWorkflowRunResult>
  readBackgroundJobOutput?: RunnerReadBackgroundJobOutput
  waitBackgroundJobs?: RunnerWaitBackgroundJobs
  cancelBackgroundJob?: RunnerCancelBackgroundJob
}

export type CodingSessionTrackerLike = RunnerContextCodingSession & {
  enableToolCategories: (categories: ToolCategoryId[], reason?: string) => ToolCategoryId[]
  enableToolNames: (toolNames: string[], reason?: string) => string[]
  getBudgetOverrideToolNames: () => string[]
  getBudgetOverrideToolCategories: () => ToolCategoryId[]
  getSessionApprovedToolCategories: () => ToolCategoryId[]
  attachToolContext: (toolContext: CodingSessionToolContext) => void
}

export interface RunnerExecutionScope {
  resourceId?: LooseOptional<string>
  metadata?: Readonly<Record<string, unknown>>
}

/** Product-owned execution scope and isolation boundary. */
export interface RunnerExecutionEnvironmentPort {
  run<T>(
    input: {
      sessionId: string
      config: AgentExecutionConfig
    },
    action: (scope: RunnerExecutionScope) => Promise<T>
  ): Promise<T>
}
