import type {
  ChatContextEvidenceRecord,
  ChatRuntimeEvent,
  StreamReconnectingPayload,
} from './chatRuntime'
import type {
  ExecutionTaskExecutionAdvice,
  ExecutionTaskPlanStep,
  ExecutionTaskPlanStepStatus,
  ExecutionTaskRecord,
  ExecutionTaskStatus,
} from './execution'
import type { RunProfileId, RunProfileSelectionId } from './runProfile'
import type { SessionLineageContext } from './storage'
import type { SubAgentTaskResult } from './subAgentTask'
import type {
  AgentRoleExpectedOutputKind,
  AgentRoleId,
  AppLocale,
  PermissionConfirmationMode,
  ToolApprovalRiskLevel,
  WorkflowType,
} from './system'
import type {
  CapabilityTaskTarget,
  PlanTaskDagContract,
  ReasoningLevel,
  TeamExecutionPhase,
  ThinkingDepth,
} from './team'
import type { CapabilityScopeId } from './tool'
import type { ToolCategoryId, ToolPermission, ToolSurfaceProfileId, UserActionCard } from './tool'

export type { RunProfileId, RunProfileSelectionId } from './runProfile'

export interface DebugModelMessage {
  role: string
  content: unknown
}

/** Opaque prompt feature id registered by a product or capability package. */
export type ChatPromptFeatureId = string

/** 迁移期字段已清空；新场景只使用 AgentSurfaceId。 */
export type AgentDeveloperContext = never

/** Opaque product surface id. */
export type AgentSurfaceId = string

export interface PromptSegmentTrace {
  id: string
  label?: string
  stability: 'stable' | 'dynamic'
  source: string
  priority: number
  text: string
}

export interface SkippedPromptSegmentTrace {
  id: string
  label?: string
  stability: 'stable' | 'dynamic'
  source: string
  priority: number
  reason: string
}

export interface RunProfileBudget {
  maxToolCount: Nullable<number>
  maxSystemPromptChars: Nullable<number>
  /**
   * 单次运行的累计输入工作集上限，独立于模型声明的物理 context window。
   * 大窗口模型仍需受 profile 认知/成本预算约束；达到上限后由 ContextOS 压缩和降级阶梯回收历史。
   */
  maxInputWorkingSetTokens: Nullable<number>
  /**
   * 本轮直接暴露给模型的工具 `JSON Schema` 总字节上限（含 `name`/`description`/`wrapper`）。
   * 作为“工具换页”的硬天花板：工具空间先按每个工具的实际 `schema` 占用做驻留集选择，
   * `maxToolCount` 只作为带容错的软护栏。
   * 为 `null` 表示不施加字节预算并退回 `maxToolCount` 裁剪。
   * 仅当调用方提供各工具的 `schema` 字节实测时才会生效。
   */
  maxToolSchemaChars: Nullable<number>
}

/** Provider-neutral generation limits selected by a runtime profile. */
export interface GenerationRequestPolicy {
  temperature?: number
  topP?: number
  maxOutputTokens?: number
}

export interface RunProfileDefaults {
  thinkingDepth: ThinkingDepth
  toolSurfaceProfile: ToolSurfaceProfileId
  modelRequestPolicy: GenerationRequestPolicy
}

export interface RunProfileDefinition {
  id: RunProfileId
  label: string
  description: string
  budget: RunProfileBudget
  defaults: RunProfileDefaults
  automaticToolCategories: readonly ToolCategoryId[]
}

export interface RunProfileRuntimePolicy {
  requested: RunProfileSelectionId
  profile: RunProfileId
  reason: string
  contextWindow: number
  defaults: RunProfileDefaults
  budget: RunProfileBudget
}

export interface ToolSchemaTelemetryPayload {
  currentProfile: ToolSurfaceProfileId
  baselineProfile: ToolSurfaceProfileId
  currentSerializedChars: number
  baselineSerializedChars: number
  savedChars: number
  overheadChars: number
  savedPercent: number
  currentEstimatedTokens: number
  baselineEstimatedTokens: number
  savedTokens: number
}

export interface RunProfileTelemetryPayload {
  profile: RunProfileId
  reason: string
  /** ContextOS 本轮实际采用的有界工作集窗口。 */
  contextWindow: Nullable<number>
  /** Provider/模型声明的物理窗口，不参与 profile 成本上限的替代。 */
  physicalContextWindow: Nullable<number>
  maxInputWorkingSetTokens: Nullable<number>
  maxToolCount: Nullable<number>
  maxSystemPromptChars: Nullable<number>
  baseAllowedToolCount: number
  exposedToolCount: number
  droppedToolCount: number
  droppedTools: string[]
  systemPromptChars: number
  promptTrimmedSegmentCount: number
}

export type AgentContextPhase = 'bootstrap' | 'operational'

export type AgentContextPhaseReason =
  | 'initial-interactive-request'
  | 'continued-provider-loop'
  | 'existing-conversation-history'
  | 'missing-user-request'
  | 'scheduled-task'
  | 'unattended-execution'
  | 'goal-mode'
  | 'selected-skill'
  | 'selected-capability'
  | 'active-context'
  | 'pure-chat'

export interface AgentContextPhaseTelemetryPayload {
  phase: AgentContextPhase
  reason: AgentContextPhaseReason
  systemPromptChars: number
  allowedToolCount: number
  toolSchemaChars: number
  estimatedToolSchemaTokens: number
}

export interface TurnPlanningTelemetryPayload {
  turn: number
  runProfile: RunProfileId
  cacheHit: boolean
  signature: string
  durationMs: number
  categoryListCalls: number
  schemaEstimateCalls: number
  runtimeToolCategoryCount: number
  allocatorCatalogCategoryCount: number
  visibleEnabledCategoryCount: number
  toolSchemaCandidateCount: number
  estimatedToolSchemaChars: number
  toolSchemaBudgetScale: number
  residentToolCount: number
  droppedToolCount: number
  expiredToolNameLeases: string[]
  categorySummary: Array<{
    id: ToolCategoryId
    toolCount: number
  }>
}

export interface ToolAllocatorTelemetryPayload {
  advisorCalled: boolean
  advisorMessage: Nullable<string>
  advisorError: Nullable<string>
  fuseTripped: boolean
  fuseMessage: Nullable<string>
  grantedCategoryIds: ToolCategoryId[]
  grantedToolCount: number
  deniedRequests: Array<{
    operation: string
    categoryId: ToolCategoryId
    code: string
    message: string
  }>
  enableToolsPerSession: number
  dedupeHitCount: number
  invisibleToolCallCount: number
  confirmCardsPerSession: number
  toolsBlockCacheInvalidationRate: Nullable<number>
  turnsPerCompletedTask: Nullable<number>
}

export type ToolLayerTelemetryMetrics = Pick<
  ToolAllocatorTelemetryPayload,
  | 'enableToolsPerSession'
  | 'dedupeHitCount'
  | 'invisibleToolCallCount'
  | 'confirmCardsPerSession'
  | 'toolsBlockCacheInvalidationRate'
  | 'turnsPerCompletedTask'
>

export type ControlPlaneLedgerSource =
  | 'intent'
  | 'capability'
  | 'context'
  | 'prompt'
  | 'recovery'
  | 'verification'

export interface ControlPlaneLedgerEntry {
  id: string
  source: ControlPlaneLedgerSource
  action: string
  reason: string
  details?: Record<string, unknown>
}

export interface AgentTurnRouteIdentity {
  roleId: Nullable<AgentRoleId>
  workflowType: Nullable<WorkflowType>
  expectedOutput: Nullable<AgentRoleExpectedOutputKind>
}

export interface StreamTurnContextPayload {
  kind: 'turn-context'
  turn: number
  roleId: AgentRoleId
  roleLabel: string
  roleDescription: string
  workflowType: WorkflowType
  roleExpectedOutput: AgentRoleExpectedOutputKind
  activeSkillMarkdown: string
  roleRouteNote: string
  roleRuntimeModel: LooseOptional<{
    provider: string
    /** 用户/路由层选择的模型或档位。 */
    model: string
    /** 实际 provider 请求使用的底层模型；注入式网关可把逻辑档位解析成真实模型。 */
    providerModel?: LooseOptional<string>
    contextWindow?: LooseOptional<number>
    resolutionSource: string
    resolutionTrace: readonly unknown[]
    fallbackReason?: LooseOptional<string>
  }>
  systemPrompt: string
  devEnvironmentContext: Nullable<string>
  stableCutoff: number
  promptSegments: PromptSegmentTrace[]
  skippedPromptSegments: SkippedPromptSegmentTrace[]
  capabilityContextAudit: readonly unknown[]
  messages: DebugModelMessage[]
  allowedTools: string[]
  enabledToolCategories: ToolCategoryId[]
  contextPhaseTelemetry: AgentContextPhaseTelemetryPayload
  toolSchemaTelemetry?: LooseOptional<ToolSchemaTelemetryPayload>
  runProfileTelemetry?: LooseOptional<RunProfileTelemetryPayload>
  toolAllocatorTelemetry?: LooseOptional<ToolAllocatorTelemetryPayload>
  turnPlanningTelemetry?: LooseOptional<TurnPlanningTelemetryPayload>
  controlPlaneLedger?: ControlPlaneLedgerEntry[]
}

export interface StreamAssistantRawPayload {
  kind: 'assistant-raw'
  turn: number
  content: unknown
}

export type StreamWorkerThreadEventKind =
  | 'started'
  | 'status'
  | 'delta'
  | 'chat-event'
  | 'output'
  | 'completed'
  | 'failed'

export type StreamWorkerThreadChatEvent =
  | { type: 'runtime-state'; payload: StreamReconnectingPayload }
  | { type: 'reasoning-delta'; id: string; text: string }
  | {
      type: 'tool-start'
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
      categoryId?: ToolCategoryId
    }
  | {
      type: 'tool-progress'
      toolCallId: string
      chunk: string
      timestamp?: number
    }
  | {
      type: 'tool-metadata'
      toolCallId: string
      title?: string
      metadata?: Record<string, unknown>
      timestamp?: number
    }
  | {
      type: 'tool-done'
      toolCallId: string
      result: unknown
      error?: string
      effects?: StreamToolResultEffects
      evidence?: ChatContextEvidenceRecord[]
      modelImage?: StreamToolResultModelImage
    }
  | {
      type: 'notice'
      kind: string
      payload: unknown
    }

export interface StreamWorkerThreadPayload {
  kind: 'worker-thread'
  event: StreamWorkerThreadEventKind
  threadId: string
  /** 前端展示实例 id；同一个后端 threadId 被唤醒多次时，每次 activation 单独渲染。 */
  activationId?: LooseOptional<string>
  taskId?: LooseOptional<string>
  nodeId?: LooseOptional<string>
  title: string
  agentName?: LooseOptional<string>
  roleId?: LooseOptional<AgentRoleId>
  phase?: LooseOptional<TeamExecutionPhase>
  status?: LooseOptional<ExecutionTaskStatus>
  capabilityTarget?: LooseOptional<CapabilityTaskTarget>
  dag?: LooseOptional<PlanTaskDagContract>
  timestamp: number
  input?: LooseOptional<string>
  text?: LooseOptional<string>
  summary?: LooseOptional<string>
  error?: LooseOptional<string>
  chatEvent?: LooseOptional<StreamWorkerThreadChatEvent>
  /** dispatch schema v2：worker thread 投影使用的 sub-agent 类型 id（自定义 agent 为其 slug id）。 */
  subagentType?: LooseOptional<string>
  /** 文件式自定义 agent 的展示名；内置类型派发时为空，UI 用它替代 subagentType id 显示。 */
  customAgentName?: LooseOptional<string>
  /** dispatch schema v2：sync 表示主链路需要较快收束，async 表示长尾后台任务。 */
  mode?: LooseOptional<'sync' | 'async'>
  /** dispatch schema v2：已解析或覆写后的 model id。 */
  model?: LooseOptional<string>
  /** dispatch schema v2：可用时写入结构化任务结果。 */
  result?: LooseOptional<SubAgentTaskResult>
}

export type ToolExecutionPlanItemStatus = ExecutionTaskPlanStepStatus | 'in_progress'

export interface ToolExecutionPlanItem {
  id?: string
  step: string
  objective?: string
  status: ToolExecutionPlanItemStatus
  roleId?: AgentRoleId
  kind?: ExecutionTaskPlanStep['kind']
  mode?: ExecutionTaskPlanStep['mode']
  dependsOn?: string[]
  required?: boolean
}

export interface ToolExecutionPlanUpdate {
  explanation?: LooseOptional<string>
  lifecycle?: 'active' | 'completed' | 'archived'
  plan: ToolExecutionPlanItem[]
}

export interface ToolConfirmationDecisionOptions {
  /** 需要用户亲自点击确认；不能被会话风险确认自动批准短路。 */
  requireManualApproval?: boolean
  /** 本次确认的风险等级；未声明时按高风险处理。 */
  approvalRisk?: ToolApprovalRiskLevel
  /** 本会话内可复用的稳定风险分类；相同 scope 用户批准一次后可自动放行。 */
  riskScope?: string
  /** 是否在用户批准后记住 riskScope；默认记住，manual confirmation 不会被记住或复用。 */
  rememberRiskScope?: boolean
  /** 使用一组通用用户动作卡片渲染本次确认。 */
  userActionCards?: UserActionCard[]
}

/** 一次工具执行审批的结构化决策（审批通道与 execution 确认机制共用的单一形状）。 */
export interface ApprovalDecision {
  /** 是否放行本次操作。 */
  approved: boolean
  /** 拒绝原因或用户批注；无则为 null。 */
  message: Nullable<string>
  /** 是否由策略自动放行（standard-open 低风险等），未经用户交互。 */
  autoApproved?: boolean
}

export interface ToolExecutionApi {
  executionId: string
  awaitConfirmation: (
    message: string,
    abortSignal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ) => Promise<void>
  awaitConfirmationDecision: (
    message: string,
    abortSignal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ) => Promise<ApprovalDecision>
  awaitUserInput: (question: string, abortSignal?: AbortSignal) => Promise<string>
  startTask: (taskId: string) => void
  completeTask: (taskId: string, result?: LooseOptional<string>) => void
  failTask: (taskId: string, error: string) => void
  getCurrentTaskId: () => string
  getCurrentTask: () => ExecutionTaskRecord
  getCurrentPlan: () => ExecutionTaskPlanStep[]
  updateCurrentPlan: (input: ToolExecutionPlanUpdate) => ExecutionTaskPlanStep[]
  getCurrentRecommendedAction: () => ExecutionTaskRecord['recommendedAction']
  getCurrentExecutionAdvice: () => Nullable<ExecutionTaskExecutionAdvice>
}

export interface AgentConfig {
  /** Product-owned model selection; interpreted by an injected model package. */
  modelSelection?: unknown
  locale?: AppLocale
  sessionId?: string
  tools?: string[]
  thinkingDepth?: ThinkingDepth
  /** 本次请求的 Composer 思考力度 5 档；adapter 会据此决定 reasoning 开关/力度/预算。 */
  reasoningLevel?: ReasoningLevel
  sessionLineage?: LooseOptional<SessionLineageContext>
  grantedPermissions?: ToolPermission[]
  promptFeatures?: ChatPromptFeatureId[]
  goalMode?: boolean
  scope?: CapabilityScopeId
  toolSurfaceProfile?: ToolSurfaceProfileId
  runProfile?: RunProfileSelectionId
  permissionConfirmationMode?: PermissionConfirmationMode
  /**
   * 无人值守执行（定时任务等）：不会创建等待 UI 应答的确认卡。显式低风险确认可按
   * permissionConfirmationMode 自动处理；高风险或要求人工确认的操作直接拒绝，避免后台挂起。
   */
  unattended?: boolean
  windowId?: number
  abortController?: AbortController
  execution?: LooseOptional<ToolExecutionApi>
  selectedSkillIds?: string[]
  /** 选中技能的调用参数（携带选择的那条用户消息文本）；技能正文 $ARGUMENTS 占位符按需替换。 */
  skillArguments?: string
  agentSurfaceId?: LooseOptional<AgentSurfaceId>
  developerContext?: LooseOptional<AgentDeveloperContext>
}

export interface StreamToolResultEffects {
  /** Capability-owned context invalidation signal. */
  contextInvalidated?: boolean
  /** Whether the capability changed an external resource. */
  resourceChanged?: boolean
  /** Opaque resource identity associated with the change. */
  changedResourceId?: string
  metadata?: Readonly<Record<string, unknown>>
}

export interface StreamToolResultModelImage {
  data: string
  mediaType: 'image/png' | 'image/jpeg'
}

export interface StreamAssistantGeneratedFilePayload {
  id: string
  mediaType: string
  data: string
  size: number
  filename?: string
}

export interface StreamAssistantSourcePayload {
  id: string
  sourceType: 'url'
  url: string
  title?: string
}

export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; id: string; text: string }
  | { type: 'assistant-generated-file'; payload: StreamAssistantGeneratedFilePayload }
  | { type: 'assistant-source'; payload: StreamAssistantSourcePayload }
  | { type: 'turn-context'; payload: StreamTurnContextPayload }
  | { type: 'assistant-raw'; payload: StreamAssistantRawPayload }
  | { type: 'worker-thread'; payload: StreamWorkerThreadPayload }
  | { type: 'runtime'; payload: ChatRuntimeEvent }
  | {
      type: 'tool-start'
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
      /** 工具所属类别，后端注入 */
      categoryId?: ToolCategoryId
    }
  | {
      type: 'tool-progress'
      toolCallId: string
      chunk: string
      timestamp?: number
    }
  | {
      type: 'tool-metadata'
      toolCallId: string
      title?: string
      metadata?: Record<string, unknown>
      timestamp?: number
    }
  | {
      type: 'tool-done'
      toolCallId: string
      result: unknown
      error?: string
      /** 工具副作用语义，后端计算后附加 */
      effects?: StreamToolResultEffects
      /** 工具结果抽取出的上下文证据 */
      evidence?: ChatContextEvidenceRecord[]
      /** 工具提供给模型读取的图片数据，renderer 用它做聊天内预览。 */
      modelImage?: StreamToolResultModelImage
    }
  | {
      type: 'notice'
      /** notice 种类 */
      kind: string
      /** notice 载荷，根据 kind 取不同类型 */
      payload: unknown
    }
