import type { generateText, LanguageModel, ModelMessage, streamText, TextStreamPart,ToolChoice, ToolSet } from 'ai'

import type { AppError } from '@velaros-ai/core/error'
import type { ScopedLog } from '@velaros-ai/core/logger'

import type { AgentChatRuntimeConfig, AgentExecutionConfig, AgentModelProvider, AgentModelRequestOptions, AgentModelRetryPolicy, AgentRunLifecycle, AgentRuntimeCapabilityPorts, AgentRuntimeInputPort, AgentSystemRuntimeConfig, AgentTurnCapabilitySnapshotSource,ContextPayloadStore } from '../contract/requires.js'
import type { LoopWindDownGuard } from '../impl/loop/LoopWindDownGuard.js'
import type { AgentModSeamDispatcher } from '../impl/mods/AgentModSeamDispatcher.js'
import type { ProviderTurnEventReducer } from '../impl/records/ProviderTurnEventReducer.js'
import type { ContextGovernanceSessionRegistry } from '../impl/residency/ContextGovernanceSession.js'
import type { KernelToolLoopGuard } from '../impl/tools/KernelToolLoopGuard.js'

import type { ActiveContextArtifact, ActiveContextArtifactKind, ActiveContextArtifactStatus, ActiveContextUpsertInput, AgentContextPhase, AgentContextPhaseReason,AgentDelegationContract, AgentEvent, AgentModelInputModality, AgentRoleId, AgentSurfaceId, AppLocale, CapabilityScopeId, ChatPromptFeatureId, ChatRuntimeEvent, ControlPlaneLedgerEntry, ControlPlaneLedgerSource, ExecutionModeId, PromptSegmentTrace, RunProfileDefinition, RunProfileId, RunProfileRuntimePolicy, RunProfileSelectionId, SkippedPromptSegmentTrace, StreamAssistantGeneratedFilePayload, StreamAssistantRawPayload, StreamAssistantSourcePayload, StreamReasoningPayload, StreamToolCallPayload, StreamToolMetadataPayload, StreamToolProgressPayload, StreamToolResultPayload, StreamTurnContextPayload, StreamTurnEndPayload, SubAgentStructuredOutputContract, SubAgentUsage, ThinkingDepth, ToolAvailabilityScope, ToolCategoryId, ToolCategoryOverview, ToolDescriptor, ToolLayerTelemetryMetrics, ToolSurfaceProfileId, TurnPlanningTelemetryPayload } from './agent.js'
import type { GoalStatus } from './builtin.js'
import type { AgentLoopToolRegistry,ContextActiveTaskInput, ContextPinnedEvidenceInput, ContextWorkingSetBudgetAllocation, EstimateContextUsageOptions, ProviderRequestPressureKind, ProviderRequestSnapshot } from './context.js'
import type { AgentHistoryToolContext, AgentTurnToolExecutor, AgentTurnToolResult, AssistantContentPart } from './history.js'
import type { ModelSpanHandle,ToolSpanOpener, TurnSpanScope } from './ledgers.js'
import type { ProviderTurnSnapshot } from './records.js'
import type { AgentRoleResolution, PromptStatePreparedToolCategories, ResolveAgentRoleOptions } from './runner.js'
import type { AutoVerificationEvents, AutoVerificationGateResult,AutoVerificationToolContext, CodingSessionSnapshot } from './session.js'
import type { SessionToolAllocatorPlan, ToolAllocatorRequest, ToolExecutionPolicyContext, ToolExecutionPolicyRegistry, ToolExecutorEvents } from './tools.js'

/** 产品自持的模型提供方集合解析出来的、可直接执行的模型运行时。 */
export interface ResolvedAgentModelRuntime {
  provider: AgentModelProvider
  providerId: string
  model: string
  providerModel: string
  contextWindow?: number
  supportedInputModalities: readonly AgentModelInputModality[]
  modelRequestOptions?: AgentModelRequestOptions
  /** Optional Agent-owned runtime policy supplied by richer injected model capabilities. */
  runProfilePolicy?: RunProfileRuntimePolicy
  resolutionSource: string
  resolutionTrace: readonly unknown[]
  fallbackReason?: string
}

export interface StreamRawChunkDiagnostic {
  type: Nullable<string>
  keys: string[]
  choiceCount: Nullable<number>
  deltaType: Nullable<string>
  deltaKeys: string[]
  contentBlockType: Nullable<string>
  contentBlockKeys: string[]
  messageStopReason: Nullable<string>
  messageModel: Nullable<string>
  messageContentCount: Nullable<number>
  messageUsageInputTokens: Nullable<number>
  messageUsageOutputTokens: Nullable<number>
  messageKeys: string[]
  messageContentTypes: string[]
  itemType: Nullable<string>
  itemKeys: string[]
}

export interface StreamDiagnostics {
  totalChunks: number
  partTypes: Record<string, number>
  textDeltaChars: number
  reasoningDeltaChars: number
  rawVisibleChars: number
  rawReasoningChars: number
  toolCallCount: number
  finishReasons: string[]
  rawFinishReasons: string[]
  inputTokens: Nullable<number>
  outputTokens: Nullable<number>
  visibleOutputTokens: Nullable<number>
  totalTokens: Nullable<number>
  reasoningTokens: Nullable<number>
  cachedInputTokens: Nullable<number>
  cacheReadInputTokens?: LooseOptional<number>
  cacheWriteInputTokens?: LooseOptional<number>
  costUsd: Nullable<number>
  rawSamples: StreamRawChunkDiagnostic[]
}

export interface StreamFinishReasonDiagnostic {
  code: 'provider-finish-reason'
  message: string
  details: {
    finishReason: string
    normalizedFinishReason: string
    finishReasons: string[]
    rawFinishReasons: string[]
  }
}

export type StreamDiagnosticsSummary = Omit<StreamDiagnostics, 'rawSamples'> & {
  rawSamples: StreamRawChunkDiagnostic[]
  rawSampleSummaries: string[]
}

export type AgentIntentDomain = string

export interface AgentIntentPlan {
  latestUserText: string
  domains: AgentIntentDomain[]
  complexity: 'low' | 'single-domain' | 'multi-domain'
  confidence: 'low' | 'medium' | 'high'
  requiresCapabilityEvidence: boolean
  requiresToolDiscovery: boolean
}

export interface AgentRuntimePlan {
  providerId: string
  model: string
  contextWindow?: number
  runProfile: RunProfileId
  runProfileReason: string
  modelRequestOptions?: AgentModelRequestOptions
}

export interface ToolPageFault {
  toolName: string
  categoryId?: ToolCategoryId
  reason: 'schema-budget' | 'role-boundary' | 'permission' | 'runtime-unavailable'
  recoveryHint: 'page-out-other-tools' | 'request-approval' | 'request-user-action' | 'stop'
}

export interface CapabilityRunPlan {
  requestedCategories: ToolCategoryId[]
  enabledCategories: ToolCategoryId[]
  protectedToolNames: string[]
  baseAllowedToolNames: string[]
  residentToolNames: string[]
  droppedToolNames: string[]
  forcedToolChoice?: { type: 'tool'; toolName: string }
  pageFaults: ToolPageFault[]
  bootstrapState: ToolSpaceBootstrapState
  bootstrapReminder?: string
}

export interface ContextRunPlan {
  contextWindow: number
  usableContextWindow: number
  zoneAllocation: ContextWorkingSetBudgetAllocation
  toolSchemaCharBudget: number
  toolSchemaBudgetScale: number
  expectedInputTokens?: number
  payloadPolicy: 'inline' | 'reference-large' | 'dedupe-and-reference'
  pressure: ProviderRequestPressureKind
}

export interface PromptRunPlan {
  runProfile: RunProfileId
  promptBudget?: { profile: RunProfileId; maxChars: number }
  internalReminders: Array<{
    id: string
    phase: 'before-model' | 'after-tool' | 'finishing'
    reason: string
    text: string
    dedupeKey?: string
  }>
}

export interface RecoveryRunPlan {
  ignoredToolChoice: {
    enabled: boolean
    maxRetries: number
    fallbackReminderId?: string
  }
  contextOverflow: {
    ladder: ContextDegradeAction[]
  }
  missingCapability: {
    action: 'discover' | 'read-page' | 'request-user-action' | 'stop'
  }
  staleEvidence: {
    action: 'refresh-capability-context' | 'none'
  }
}

export type AgentRunPlanLedgerSource = ControlPlaneLedgerSource

export type AgentRunPlanLedgerEntry = ControlPlaneLedgerEntry

export interface AgentRunPlan {
  id: string
  turn: number
  intent: AgentIntentPlan
  runtime: AgentRuntimePlan
  capabilities: CapabilityRunPlan
  context: ContextRunPlan
  prompt: PromptRunPlan
  recovery: RecoveryRunPlan
  ledger: AgentRunPlanLedgerEntry[]
}

export interface AgentRunPlannerInput<TToolContext = unknown> {
  turn: number
  history: ModelMessage[]
  roleRuntime: AgentRuntimePlan
  requestedRunProfile: RunProfileSelectionId
  toolContext: TToolContext
  roleAllowedTools: string[]
  configuredTools?: string[]
  toolDescriptors?: ToolDescriptor[]
}

export type QueryTurnProvider = (modelId: string, options?: AgentModelRequestOptions) => LanguageModel

export type QueryTurnToolContext = ToolExecutionPolicyContext &
  AgentHistoryToolContext & {
    abortSignal: AbortSignal
    sessionId?: string
    /** 非可展示响应兜底文案的语言；缺省时 StreamConsumer 回落 zh-CN。 */
    locale?: AppLocale
    contextPayloadStore?: ContextPayloadStore
  }

export interface QueryTurnToolRegistry<
  TToolContext extends QueryTurnToolContext = QueryTurnToolContext,
> extends ToolExecutionPolicyRegistry {
  toAiTools(
    toolContext: TToolContext,
    allowList: string[],
    options?: {
      toolSchemaChars?: Readonly<Record<string, number>>
      historyToolNames?: readonly string[]
    }
  ): ToolSet
  estimateToolSerializedCharsByName?: (
    toolContext: TToolContext,
    allowedTools?: string[]
  ) => Record<string, number>
  estimateToolSchemaHashesByName?: (
    toolContext: TToolContext,
    allowedTools?: string[]
  ) => Record<string, string>
}

export interface QueryTurnEvents {
  emitRuntime(event: ChatRuntimeEvent): void
  emitTextDelta?(text: string): void
  emitGeneratedFile?(payload: StreamAssistantGeneratedFilePayload): void
  emitSource?(payload: StreamAssistantSourcePayload): void
  /**
   * 可选：推理模型的增量内容转发入口。
   * 子智能体默认不向界面投影推理内容，但调试面板可以注册监听器，
   * 否则推理 token 会"只付费、看不见"。
   */
  emitReasoningDelta?(payload: StreamReasoningPayload): void
  emitToolStart?(payload: StreamToolCallPayload): void
  emitToolProgress?(payload: StreamToolProgressPayload): void
  emitToolMetadata?(payload: StreamToolMetadataPayload): void
  emitToolDone?(payload: StreamToolResultPayload): void
  emitNotice?(event: Extract<AgentEvent, { type: 'notice' }>): void
}

export interface ExecuteQueryTurnArgs<
  TToolContext extends QueryTurnToolContext = QueryTurnToolContext,
> {
  provider: QueryTurnProvider
  model: string
  turn?: number
  modelRequestOptions?: AgentModelRequestOptions
  systemPrompt: string
  history: ModelMessage[]
  contextWindow?: LooseOptional<number>
  /** Concrete inputs accepted by the selected model. Missing means unknown, not unsupported. */
  supportedInputModalities?: readonly AgentModelInputModality[]
  contextUsageOptions?: EstimateContextUsageOptions
  toolSchemaChars?: Readonly<Record<string, number>>
  toolContext: TToolContext
  /** 本轮开始时捕获的工具能力快照；缺省兼容使用构造时注册表。 */
  toolRegistry?: QueryTurnToolRegistry<TToolContext>
  allowedTools: string[]
  events?: QueryTurnEvents
  streamTextDeltas?: boolean
  /** 测试/运行时覆盖：模型流多久没有新 chunk 就判定 provider 半开停滞。 */
  idleStallTimeoutMs?: LooseOptional<number>
  contextEpochScope?: LooseOptional<string>
  /**
   * 治理账本键（缺省 = 会话 id）。
   *
   * 子 agent 的 `toolContext` 是父 ctx 的展开，sessionId 与父会话逐字相同，但它跑的是另一条消息
   * 序列——共用一本账本会让父子交替编译每次都在第 0 条指纹分叉、整本重建（审计 U12）。派发面
   * 传一个"每次派发唯一、跨该子 agent 全部轮次稳定"的键进来。
   */
  governanceSessionId?: LooseOptional<string>
  contextEpochGuard?: LooseOptional<KernelContextEpochGuardLike>
  onProviderTurnSnapshot?: LooseOptional<(snapshot: ProviderTurnSnapshot) => void>
  /** 每次真实 provider 请求将被连接重试替换前，记录该失败尝试。 */
  modelRetry?: AgentModelRetryPolicy
  onModelRequestRetry?: LooseOptional<(error: AppError, attempt: number) => void>
  /**
   * 可选观测 tool span 开启器（#37 阶段 C 片 2）。子 Agent 的 QueryLoop 每轮把 turn scope 作开启器注入，
   * 令本轮内 ToolExecutor 产 tool span（挂在子 Agent 自己的 turn span 下）；缺省 no-op（零观测零付费）。
   */
  toolSpanOpener?: LooseOptional<ToolSpanOpener>
  toolLoopGuard?: KernelToolLoopGuard
  /**
   * 可选 mod 拦截 seam 派发器（裁决 9 机制②）；由 QueryLoop 逐轮透传。缺省 null → 本轮
   * ToolExecutor 全链 no-op，行为逐字节不变。子面与主面共用同一派发器，钩子的「拦下/改写」
   * 才不会在委派边界上出现盲区。
   */
  seams?: LooseOptional<AgentModSeamDispatcher>
}

export interface ProviderTurnPayloadContext {
  sessionId?: string;
  contextPayloadStore?: ContextPayloadStore;
}

export interface ProviderTurnActiveContextArtifact {
  id: string;
  kind: "plan" | "decision" | "requirement";
  title?: LooseOptional<string>;
  content: string;
  status?: LooseOptional<string>;
  updatedAt?: LooseOptional<number>;
  metadata?: LooseOptional<Record<string, unknown>>;
}

export interface ProviderTurnActiveContextProvider {
  activeContext?: {
    listActiveContextArtifacts(options?: {
      status?: "active" | "completed" | "archived" | "all";
      kinds?: Array<"plan" | "decision" | "requirement">;
    }): Promise<ProviderTurnActiveContextArtifact[]>;
  };
}

export interface ProviderTurnContextWorkingSetInputs {
  activeTask?: ContextActiveTaskInput;
  pinnedEvidence?: ContextPinnedEvidenceInput[];
}

export type ProviderTurnActiveContext = NonNullable<
  ProviderTurnActiveContextProvider["activeContext"]
>;

export interface ToolSchemaCharEstimatorRegistry<TContext> {
  estimateToolSerializedCharsByName?: (
    toolContext: TContext,
    allowedTools?: string[],
  ) => Record<string, number>;
}

export interface ToolSchemaHashEstimatorRegistry<TContext> {
  estimateToolSchemaHashesByName?: (
    toolContext: TContext,
    allowedTools?: string[],
  ) => Record<string, string>;
}

export interface ProviderToolTransportContext {
  /** canonical tool id 到供应方安全的请求内名称。 */
  getCurrentVisibleToolTransportNames?: () => Readonly<Record<string, string>>;
}

export interface ContextUsageEmitTarget {
  events?: { emitRuntime?: (event: ChatRuntimeEvent) => void };
  turn: LooseOptional<number>;
  model: string;
}

export interface ProviderToolNamePlan {
  providerToolNames?: string[];
  historyToolNames: string[];
}

export interface ProviderToolTransportPlan {
  /** canonical tool id -> provider request name for exactly one provider request. */
  canonicalToProvider: Readonly<Record<string, string>>;
  /** provider request name -> canonical tool id for exactly the matching response stream. */
  providerToCanonical: Readonly<Record<string, string>>;
}

export type SoloGoalLifecycleStatus = GoalStatus

export interface SystemPromptDelivery {
  system?: string
  leadingMessages: ModelMessage[]
  /** 系统提示词 dynamic 层：排在历史**之后**的活动尾块（P7-1）。 */
  tailBlocks: ModelMessage[]
}

export type StreamTurnProvider = (modelId: string, options?: AgentModelRequestOptions) => LanguageModel

export type StreamTurnToolContext = AgentHistoryToolContext & {
  abortSignal: AbortSignal
  locale?: AppLocale
  sessionId?: string
  contextPayloadStore?: ContextPayloadStore
}

export interface StreamTurnToolRegistry<
  TToolContext extends StreamTurnToolContext = StreamTurnToolContext,
> extends ToolExecutionPolicyRegistry {
  toAiTools(
    toolContext: TToolContext,
    allowList?: string[],
    options?: {
      toolSchemaChars?: Readonly<Record<string, number>>
      historyToolNames?: readonly string[]
    }
  ): ToolSet
  estimateToolSerializedCharsByName?: (
    toolContext: TToolContext,
    allowedTools?: string[]
  ) => Record<string, number>
  estimateToolSchemaHashesByName?: (
    toolContext: TToolContext,
    allowedTools?: string[]
  ) => Record<string, string>
}

export interface StreamTurnEvents extends StreamConsumerEvents {
  emitRuntime(event: ChatRuntimeEvent): void
  emitAssistantRaw(payload: StreamAssistantRawPayload): void
}

export interface ExecuteStreamTurnArgs<
  TToolContext extends StreamTurnToolContext = StreamTurnToolContext,
> {
  /** 当前 provider 的 LanguageModel factory。 */
  provider: StreamTurnProvider
  /** 具体模型 id。 */
  model: string
  /** 温度、推理强度等模型请求选项。 */
  modelRequestOptions?: AgentModelRequestOptions
  /** 本轮 system prompt。 */
  systemPrompt: string
  /**
   * 系统提示词内「稳定层 / 动态层」的字符分界偏移（来自 ContextBuilder）。
   * 提供且稳定层足够大时，会把系统提示词拆块并在稳定块上打 provider-neutral 缓存断点；缺省则原样下发。
   */
  stableCutoff?: LooseOptional<number>
  /** 当前消息历史；本 helper 会在成功后追加 assistant 消息。 */
  history: ModelMessage[]
  /** 当前模型上下文窗口；用于最终 provider payload send gate。 */
  contextWindow?: LooseOptional<number>
  /** Concrete inputs accepted by the selected model. Missing means unknown, not unsupported. */
  supportedInputModalities?: readonly AgentModelInputModality[]
  /** loop 侧已经带上输出预留、安全余量和校准系数的估算配置。 */
  contextUsageOptions?: EstimateContextUsageOptions
  /** 工具执行上下文。 */
  toolContext: TToolContext
  /** 本轮开始时捕获的工具能力快照；缺省兼容使用构造时注册表。 */
  toolRegistry?: StreamTurnToolRegistry<TToolContext>
  /** 本轮允许暴露给模型的工具名。 */
  allowTools?: string[]
  /** 本轮 run planner 已经测得的工具 schema 字符数，避免 provider request 阶段重复估算。 */
  toolSchemaChars?: Readonly<Record<string, number>>
  /** 本轮工具选择策略；缺省时由模型自动决定是否调用工具。 */
  toolChoice?: ToolChoice<ToolSet>
  /** 本轮工具执行器。 */
  executor: StreamConsumerToolExecutor
  /** 向 UI 输出事件。 */
  events: StreamTurnEvents
  /** 取消信号。 */
  abortSignal: AbortSignal
  /** 新运行时输入到达时只抢占当前 provider 回合，不取消整个 execution。 */
  runtimeInputInterruptSignal?: AbortSignal
  /** 模型流连续无任何活动时的超时；缺省使用统一运行时策略。 */
  idleStallTimeoutMs?: LooseOptional<number>
  /** 当前轮次。 */
  turn: number
  contextEpochScope?: LooseOptional<string>
  contextEpochGuard?: LooseOptional<KernelContextEpochGuardLike>
  onProviderTurnSnapshot?: LooseOptional<(snapshot: ProviderTurnSnapshot) => void>
  /** 每次真实 provider 请求将被连接重试替换前，记录该失败尝试。 */
  modelRetry?: AgentModelRetryPolicy
  onModelRequestRetry?: LooseOptional<(error: AppError, attempt: number) => void>
}

export interface StreamTurnResult {
  /** 本轮 assistant 是否产生过 tool call。 */
  hasToolUse: boolean
  /** 本轮是否向用户输出过非空正文；reasoning 和 tool call 不计入。 */
  hasVisibleText?: boolean
  /** 当前 provider 回合在派发任何工具副作用前为新运行时输入让路。 */
  interruptedByRuntimeInput?: boolean
  /** 供应方返回的真实输入 token 数（若有）；用于 MMU 用量校准反馈。 */
  inputTokens?: LooseOptional<number>
  /** 与 inputTokens 同一次成功请求的编译后估算，含治理投影和实际工具面。 */
  predictedInputTokens?: LooseOptional<number>
  /**
   * 供应方回合收敛后的执行观测富化（#37 阶段 C 片 1）：输出 token / 成本 / 结束原因 / 请求指纹。
   * 与 inputTokens 走同一回传通道，交由 SoloLoop 挂到本确定 turn 的 model span（D5）。缺席用 null。
   */
  outputTokens?: LooseOptional<number>
  costUsd?: LooseOptional<number>
  /** 推理 token（含在 outputTokens 里）与输入中命中 / 写入缓存的 token；子 Agent 用量据此分项计价。 */
  reasoningTokens?: LooseOptional<number>
  cacheReadInputTokens?: LooseOptional<number>
  cacheWriteInputTokens?: LooseOptional<number>
  finishReason?: LooseOptional<string>
  requestFingerprint?: LooseOptional<string>
  providerRequestSnapshot?: LooseOptional<ProviderRequestSnapshot>
}

/** 单轮裁决：继续下一轮，或以面自己的完成值收束整个 loop。 */
export type LoopTurnVerdict<TFinish> = { kind: 'continue' } | { kind: 'finish'; value: TFinish }

export type LoopWindDownTriggerReason = 'turn-cap' | 'time-deadline'

/**
 * 引擎驱动的装配面。每次 execute 由面新建（闭包捕获本次执行的全部局部状态），
 * 引擎不持有跨执行状态。
 */
export interface AgentLoopSurface<TFinish> {
  /** 护栏 3（中止门）判定：每轮开场先查。 */
  isAborted(): boolean
  /**
   * 护栏 3（中止门）收敛：主面发 emitAbort 并返回 aborted 状态；
   * 子面收敛 run span 后抛 EXECUTION_ABORTED（允许 throw）。
   */
  onAborted(turn: number): TFinish
  /** 每轮开场注入点（运行中引导 / relay / 环境回合 note），面自装配。 */
  beforeTurn(turn: number): Promise<void>
  /** 护栏 1 装配：共享 guard + 面自己的提醒文案与触发日志。 */
  windDown: {
    guard: LoopWindDownGuard
    onTriggered(reason: LoopWindDownTriggerReason, turn: number): void
  }
  /**
   * 单轮全部内容（准备 / 请求 / 后续处置）。护栏 2（溢出恢复）与护栏 4（turn span 收敛）
   * 经 AgentLoop 的共享机制在面内装配；异常收敛策略（状态化 vs 冒泡）是面的真装配差异。
   */
  runTurn(turn: number): Promise<LoopTurnVerdict<TFinish>>
}

export interface NonConnectionApiErrorMatcher {
  pattern: RegExp
  reason: string
}

export interface ContextOverflowReplayUnsafeDetails {
  hasVisibleOutput: boolean
  hasToolUse: boolean
}

export interface ConnectionRetryOptions {
  policy?: AgentModelRetryPolicy
  phase: 'stream' | 'query'
  turn: Nullable<number>
  abortSignal: AbortSignal
  hasVisibleOutput?: () => boolean
  hasToolUse?: () => boolean
  onRetry?: (error: AppError, attempt: number) => void
}

export type ConnectionRetryBlockReason =
  | 'abort_error'
  | 'abort_signal'
  | 'max_attempts'
  | 'non_connection_api_error'
  | 'not_transient_connection_error'
  | 'stalled_retry_exhausted'
  | 'tool_use_emitted'
  | 'visible_output_emitted'

export type TurnRunnerToolContext = QueryTurnToolContext & StreamTurnToolContext

export type TurnRunnerToolRegistry<
  TToolContext extends TurnRunnerToolContext = TurnRunnerToolContext,
> = QueryTurnToolRegistry<TToolContext> &
  StreamTurnToolRegistry<TToolContext> & {
    names: Iterable<string>
  }

export interface SoloLoopRoleRuntime {
  provider: StreamTurnProvider
  providerId: string
  model: string
  providerModel?: string
  contextWindow?: number
  supportedInputModalities: readonly AgentModelInputModality[]
  modelRequestOptions?: AgentModelRequestOptions
  runProfilePolicy?: RunProfileRuntimePolicy
  resolutionSource: string
  resolutionTrace: readonly unknown[]
  fallbackReason?: LooseOptional<string>
}

export interface SoloLoopEvents extends StreamTurnEvents, ToolExecutorEvents, AutoVerificationEvents {
  emitTurnContext(payload: StreamTurnContextPayload): void
}

export type SoloLoopToolContext = StreamTurnToolContext &
  ToolExecutionPolicyContext &
  AutoVerificationToolContext & {
    codingSession: StreamTurnToolContext['codingSession'] & {
      enableToolCategories: (categories: ToolCategoryId[], reason?: string) => ToolCategoryId[]
      enableToolNames: (toolNames: string[], reason?: string) => string[]
      drainToolAllocatorRequests?: () => ToolAllocatorRequest[]
      getEnabledToolCategories: () => ToolCategoryId[]
      getBudgetOverrideToolCategories: () => ToolCategoryId[]
      getBudgetOverrideToolNames: () => string[]
      isToolCategoryAllowed: (category: ToolCategoryId) => boolean
      getToolUsageScores?: () => Readonly<Record<string, number>>
      getToolLayerTelemetryMetrics?: (turnsPerCompletedTask?: number) => ToolLayerTelemetryMetrics
      setUsableContextWindowTokens?: (tokens: Nullable<number>) => void
      getLastTurnPlanningTelemetry?: () => StreamTurnContextPayload['turnPlanningTelemetry']
      collectNewlyEvictedPagedInTools?: (evictedToolNames: readonly string[]) => string[]
    }
    activeContext: {
      listActiveContextArtifacts(options?: {
        status?: ActiveContextArtifactStatus | 'all'
        kinds?: ActiveContextArtifactKind[]
      }): Promise<ActiveContextArtifact[]>
      upsertActiveContextArtifact(input: ActiveContextUpsertInput): Promise<ActiveContextArtifact>
    }
    getCurrentVisibleToolNames: () => string[]
    setCurrentVisibleToolNames: (toolNames: string[]) => void
    setSupportedModelInputModalities: (
      modalities: readonly AgentModelInputModality[]
    ) => void
    listToolCategories(
      scope?: 'enabled' | 'all' | 'system-enabled' | 'catalog'
    ): ToolCategoryOverview[]
  }

export interface SoloLoopRuntime<TEvents extends SoloLoopEvents> {
  resolveRoleRuntime(
    selection: unknown,
    runtimeContext?: unknown,
    signal?: AbortSignal
  ): Promise<SoloLoopRoleRuntime>
  handleStreamError(
    error: unknown,
    turn: number,
    abortSignal: AbortSignal,
    events: TEvents,
    log: ScopedLog
  ): void
  emitAbort(events: TEvents, message?: string): void
}

export interface SoloLoopTurnRunner<TContext extends SoloLoopToolContext, TEvents extends SoloLoopEvents> {
  executeStreamTurn(
    args: Omit<ExecuteStreamTurnArgs<TContext>, 'toolContext' | 'events'> & {
      toolContext: TContext
      events: TEvents
    }
  ): Promise<StreamTurnResult>
  appendToolResultsToHistory(
    history: ModelMessage[],
    executor: AgentTurnToolExecutor
  ): Promise<AgentTurnToolResult[]>
}

export interface SoloLoopRunContext<TContext extends SoloLoopToolContext> {
  buildPrimaryAgentSystemPrompt(args: {
    chatConfig: AgentChatRuntimeConfig
    systemConfig: AgentSystemRuntimeConfig
    messages: ModelMessage[]
    roleResolution: AgentRoleResolution
    toolContext: TContext
    capabilityContext?: unknown
    thinkingDepth?: LooseOptional<AgentSystemRuntimeConfig['thinkingDepth']>
    promptFeatures?: AgentExecutionConfig['promptFeatures']
    preparedToolCategories?: PromptStatePreparedToolCategories
    executionModes?: AgentExecutionConfig['executionModes']
    goalMode?: AgentExecutionConfig['goalMode']
    runProfile?: RunProfileId
    promptBudget?: LooseOptional<{
      profile: RunProfileId
      maxChars: number
    }>
    contextPhase: AgentContextPhase
  }): Promise<{
    systemPrompt: string
    devEnvironmentContext: Nullable<string>
    stableCutoff: number
    promptSegments: PromptSegmentTrace[]
    skippedPromptSegments: SkippedPromptSegmentTrace[]
  }>
  buildTurnContextPayload(args: {
    turn: number
    roleResolution: AgentRoleResolution
    roleRuntimeModel: StreamTurnContextPayload['roleRuntimeModel']
    systemPrompt: string
    devEnvironmentContext: Nullable<string>
    stableCutoff: number
    promptSegments: PromptSegmentTrace[]
    skippedPromptSegments: SkippedPromptSegmentTrace[]
    history: ModelMessage[]
    toolContext: TContext
    allowedTools: string[]
    toolSchemaTelemetry?: StreamTurnContextPayload['toolSchemaTelemetry']
    runProfileTelemetry?: StreamTurnContextPayload['runProfileTelemetry']
    toolAllocatorTelemetry?: StreamTurnContextPayload['toolAllocatorTelemetry']
    turnPlanningTelemetry?: StreamTurnContextPayload['turnPlanningTelemetry']
    contextPhaseTelemetry: StreamTurnContextPayload['contextPhaseTelemetry']
  }): StreamTurnContextPayload
}

export type SoloLoopToolRegistry<TContext extends SoloLoopToolContext> = AgentLoopToolRegistry<TContext> &
  StreamTurnToolRegistry<TContext> &
  ToolExecutionPolicyRegistry & {
    listCategories?(
      toolContext: TContext,
      allowList?: string[],
      scope?: 'enabled' | 'all' | 'system-enabled' | 'catalog'
    ): ToolCategoryOverview[]
    getDescriptor(toolName: string): LooseOptional<{ categoryId?: LooseOptional<ToolCategoryId> }>
    estimateToolsSerializedCharsForProfile?: (
      toolContext: TContext,
      profile: ToolSurfaceProfileId,
      allowedTools: string[]
    ) => number
    estimateToolSerializedCharsByName?: (
      toolContext: TContext,
      allowedTools: string[]
    ) => Record<string, number>
  } & Partial<AgentTurnCapabilitySnapshotSource<SoloLoopToolRegistry<TContext>>>

export interface ExecuteSoloModeStreamLoopArgs<
  TContext extends SoloLoopToolContext = SoloLoopToolContext,
  TEvents extends SoloLoopEvents = SoloLoopEvents,
> {
  lifecycle?: AgentRunLifecycle<TContext>
  modelRetry?: AgentModelRetryPolicy
  /** 会被循环原地追加 assistant/tool/system reminder 消息的历史。 */
  history: ModelMessage[]
  /** 本次 Agent 执行配置。 */
  config: AgentExecutionConfig
  /** 聊天模型配置快照。 */
  chatConfig: AgentChatRuntimeConfig
  /** 系统配置快照。 */
  systemConfig: AgentSystemRuntimeConfig
  /** 外层 ExecutionService 传入的取消控制器。 */
  abortController: AbortController
  /** 工具能力上下文。 */
  toolContext: TContext
  /** 当前 solo profile 解析出的角色和工具能力。 */
  resolution: AgentRoleResolution
  /** 本次任务由能力扩展注入的上下文信号。 */
  capabilityContext?: unknown
  /**
   * 在长会话中按节奏刷新 codingSignals 的回调；缺省时使用初始 codingSignals 直至 loop 结束。
   * 当前轮无法刷新时保留上一份信号继续使用。
   */
  refreshCapabilityContext?: (history: ModelMessage[]) => Promise<unknown>
  /** 原子运行时输入端口；在最终收尾边界 drain 后 seal。 */
  runtimeInput?: AgentRuntimeInputPort
  /** 读取并移除运行中用户引导；有结果时作为下一轮 user message 追加到 history。 */
  consumeGuidance?: () => Nullable<ModelMessage> | Promise<Nullable<ModelMessage>>
  /**
   * 环境回合上下文 mid-run 投递点：每轮开头 peek 本会话新 delta（后台任务完成/失败、
   * 宿主能力活动、外部资源变化等），渲染成 user note 追加到 history 并立即提交 cursor。
   * 与 pre-send chips 共享同一 cursor——事件到模型恰好一次，走时间上先到的投递点。
   */
  consumeTurnContextNote?: () => Nullable<string>
  /**
   * 隐式停泊：模型申请收尾时 wait-any，任意一个后台子 Agent 收敛就唤醒主循环。
   * signal 同时覆盖 execution abort 与新 runtime input，确保停泊可中断、用户 steer 可立即被接管。
   */
  awaitPendingBackgroundJobs?: SoloAwaitPendingBackgroundJobs
  /** 向 UI 输出 agent/state/debug 事件的总线。 */
  events: TEvents
}

export type SoloModeStreamLoopResult = { status: 'completed' } | { status: 'aborted' | 'error' }

export type SoloInterruptedToolCallRecoveryKind =
  | 'output-truncation'
  | 'invalid-input'
  | 'invalid-identity'

export interface QueryLoopSubAgentRuntimeOverride {
  provider: AgentModelProvider
  providerId: string
  model: string
  supportedInputModalities?: readonly AgentModelInputModality[]
  modelRequestOptions?: AgentModelRequestOptions
  thinkingDepth?: LooseOptional<ThinkingDepth>
}

export interface QueryLoopSubAgentOptions<TEvents extends QueryTurnEvents> extends SubAgentOptionsLike {
  runtimeOverride?: QueryLoopSubAgentRuntimeOverride
  events?: TEvents
  /**
   * 软上限时间戳（epoch ms）。到点后注入一次收尾提醒让子 Agent 汇报进展并结束，
   * 而非硬杀；未设置则不施加软上限。
   */
  softDeadlineAt?: number
  /** 主 Agent relay 的运行中引导；每条消息只在子 Agent 某一轮 turn 开始时消费一次。 */
  consumeRelayedGuidance?: () => Nullable<string> | Promise<Nullable<string>>
  /**
   * 续跑：注入已有对话历史，跳过从零构造的首条 user 消息。此时 `task` 是派发器拼好的追加指令，
   * 原样作为一条内部跟进消息接在历史后，不再套委派合约外壳（外壳已在历史的首条消息里）。
   */
  initialHistory?: ModelMessage[]
  /** 每轮结束后回写 history，供 session store 持久化。 */
  onHistoryUpdate?: (history: ModelMessage[]) => void
  /** 单 worker 中断信号（与父 abort 合并生效）。 */
  workerAbortSignal?: AbortSignal
  structuredOutputContract?: SubAgentStructuredOutputContract
  onStructuredOutput?: (value: unknown) => void
  /** 子 Agent 运行结束时回报本次 token/成本用量汇总（D9 usage 回传）。 */
  onUsage?: (usage: SubAgentUsage) => void
}

export type QueryLoopToolContext = QueryTurnToolContext &
  AgentHistoryToolContext &
  AutoVerificationToolContext &
  SubAgentContextBase & {
    selectedSkillIds?: string[]
    codingSession: {
      setUsableContextWindowTokens?: (tokens: Nullable<number>) => void
      /**
       * 父会话选定的运行档（`'auto'` = 按模型窗口自动判档）。子 Agent 继承它做工具面预算——
       * 档位承诺的是「本次运行允许长期携带多少」，不是「只约束主会话」。
       */
      getRunProfile?: () => RunProfileSelectionId
    }
  }

export interface QueryLoopRoleEngine {
  resolve(options: ResolveAgentRoleOptions): AgentRoleResolution
}

export type QueryLoopToolRegistry<
  TContext extends QueryLoopToolContext,
> = AgentLoopToolRegistry<TContext> &
  QueryTurnToolRegistry<TContext> & {
  names: string[]
  estimateToolSerializedCharsByName?: (
    toolContext: TContext,
    allowedTools?: string[]
  ) => Record<string, number>
  getDescriptor(toolName: string): LooseOptional<{ categoryId?: LooseOptional<ToolCategoryId> }>
} & Partial<AgentTurnCapabilitySnapshotSource<QueryLoopToolRegistry<TContext>>>

export type QueryLoopToolCategoryResolver = (categories: ToolCategoryId[]) => string[]

export interface ExecuteQueryLoopArgs<
  TContext extends QueryLoopToolContext = QueryLoopToolContext,
  TEvents extends QueryTurnEvents = QueryTurnEvents,
  TSignals = unknown,
> {
  lifecycle?: AgentRunLifecycle<TContext>
  modelRetry?: AgentModelRetryPolicy
  /** 父 Agent 委派给子 Agent 的任务文本。 */
  task: string
  /** 子 Agent 运行选项，可限制工具类别、角色和最大步数。 */
  opts: QueryLoopSubAgentOptions<TEvents>
  /** 父工具上下文，子 Agent 会继承大部分能力并收窄工具。 */
  parentCtx: TContext
  /** 聊天模型配置快照。 */
  chatConfig: AgentChatRuntimeConfig
  /** 系统配置快照。 */
  systemConfig: AgentSystemRuntimeConfig
  /** Collect capability-owned context. Agent Runtime treats the snapshot as opaque. */
  collectCapabilityContext: (messages: ModelMessage[]) => Promise<Nullable<TSignals>>
}

export type AgentModelStreamInput<TToolSet extends ToolSet = ToolSet> = Parameters<
  typeof streamText<TToolSet>
>[0]

export type AgentModelStreamResult<TToolSet extends ToolSet = ToolSet> = ReturnType<
  typeof streamText<TToolSet>
>

export interface AgentContextSemanticSummaryInput {
  model: Parameters<typeof generateText>[0]['model']
  system: string
  prompt: string
  abortSignal?: Parameters<typeof generateText>[0]['abortSignal']
  maxOutputTokens?: Parameters<typeof generateText>[0]['maxOutputTokens']
  modelRequestOptions?: AgentModelRequestOptions
}

/**
 * Agent 消费的最小模型请求端口。
 *
 * Provider 解析和 LanguageModel 创建属于 Model 模块；Agent 只接收已解析模型并发起自己的
 * turn/summary 请求。宿主可以注入远程 transport，默认实现直接使用 AI SDK。
 */
export interface AgentModelRequestPort {
  openAgentStreamTurn<TToolSet extends ToolSet = ToolSet>(
    input: AgentModelStreamInput<TToolSet>
  ): AgentModelStreamResult<TToolSet>
  openAgentQueryTurn<TToolSet extends ToolSet = ToolSet>(
    input: AgentModelStreamInput<TToolSet>
  ): AgentModelStreamResult<TToolSet>
  summarizeContextSemantics(input: AgentContextSemanticSummaryInput): Promise<string>
}

export type ModelRequestPolicyTarget = {
  temperature?: number
  topP?: number
  maxOutputTokens?: number
}

export type KernelContextEpochPhase = 'stream' | 'query'

export interface KernelContextUsageSnapshot {
  estimatedTokens: number
  tokenPercent: number
  usableContextWindow: number
}

export interface BuildKernelContextEpochInput {
  sessionId: string
  scope?: LooseOptional<string>
  phase: KernelContextEpochPhase
  turn?: LooseOptional<number>
  model: string
  messageCount: number
  availableToolNames: readonly string[]
  requestFingerprint?: unknown
  contextUsage: KernelContextUsageSnapshot
  createdAt?: number
}

export interface KernelContextEpoch {
  sessionId: string
  scope: Nullable<string>
  phase: KernelContextEpochPhase
  turn: Nullable<number>
  model: string
  messageCount: number
  availableToolNames: string[]
  requestFingerprint?: unknown
  contextUsage: KernelContextUsageSnapshot
  createdAt: number
}

export interface KernelContextEpochClaim {
  key: string
  revision: number
  epoch: KernelContextEpoch
}

export interface KernelContextEpochGuardLike {
  claim(epoch: KernelContextEpoch): KernelContextEpochClaim
  assertCurrent(claim: KernelContextEpochClaim): void
}

export interface RecordKernelContextEpochDiagnosticOptions {
  claim?: LooseOptional<KernelContextEpochClaim>
  current?: LooseOptional<boolean>
}

export interface KernelPrefixShapeInput {
  systemPrompt: string
  availableToolNames: readonly string[]
  toolSchemaChars?: Readonly<Record<string, number>>
  toolSchemaHashes?: Readonly<Record<string, string>>
  historyRewriteFingerprint?: LooseOptional<string>
}

export interface KernelPrefixShape {
  prefixHash: string
  systemHash: string
  toolsHash: string
  toolSchemaTokens: number
  historyRewriteFingerprint?: string
}

export interface KernelPrefixShapeDiagnostic extends KernelPrefixShape {
  prefixChanged: boolean
  prefixChangeReasons: string[]
  cacheHitTokens?: number
  cacheMissTokens?: number
}

export type KernelPrefixShapePhase = 'stream' | 'query'

export interface RecordKernelPrefixShapeDiagnosticInput {
  previous?: LooseOptional<KernelPrefixShape>
  current: KernelPrefixShape
  cache?: {
    cacheHitTokens?: LooseOptional<number>
    cacheMissTokens?: LooseOptional<number>
  }
}

export interface LinkedAbortScope {
  signal: AbortSignal
  abort(reason?: unknown): void
  dispose(): void
}

export interface StreamConsumerToolExecutor {
  configureProviderTurnReducer?(
    input: ProviderTurnEventReducer,
    onSnapshot?: LooseOptional<(snapshot: ProviderTurnSnapshot) => void>,
  ): void;
  enqueue(
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>,
    isConcurrencySafe: boolean,
    authorization?: {
      requestAdvertised: boolean;
      providerToolName: string;
    },
  ): void;
}

export interface StreamConsumerEvents {
  emitRuntime?(event: ChatRuntimeEvent): void;
  emitReasoningDelta(payload: StreamReasoningPayload): void;
  emitTextDelta(text: string): void;
  emitGeneratedFile(payload: StreamAssistantGeneratedFilePayload): void;
  emitSource(payload: StreamAssistantSourcePayload): void;
  emitToolStart(payload: StreamToolCallPayload): void;
  emitToolMetadata?(payload: StreamToolMetadataPayload): void;
}

export interface InterruptedStreamPartial {
  assistantContent: AssistantContentPart[];
  hasPendingToolCalls: boolean;
}

export interface ConsumeAssistantStreamArgs {
  abortSignal: AbortSignal;
  executor: StreamConsumerToolExecutor;
  events: StreamConsumerEvents;
  /**
   * 模型流静默多久后把状态拉回「思考中」（毫秒）。字段名沿用历史叫法以保持公开 API 兼容；
   * 静默期早已不再上报重连。
   */
  idleReconnectDelayMs?: number;
  idleStallTimeoutMs?: number;
  model: string;
  contextPressure?: {
    percent: number;
    usableContextWindow: number;
  };
  requestFingerprint?: unknown;
  /** Immutable provider name -> canonical id map captured for this exact request. */
  providerToCanonicalToolNames?: Readonly<Record<string, string>>;
  contextEpoch?: KernelContextEpoch;
  contextEpochClaim?: LooseOptional<KernelContextEpochClaim>;
  contextEpochGuard?: LooseOptional<KernelContextEpochGuardLike>;
  providerTurnReducer?: ProviderTurnEventReducer;
  toolContext?: {
    locale?: AppLocale;
    resolveCurrentVisibleCanonicalToolName?: (
      providerToolName: string,
    ) => LooseOptional<string>;
    resolveKnownCanonicalToolName?: (
      providerToolName: string,
    ) => LooseOptional<string>;
  };
  /**
   * 空流恢复错误的来源标签（装配面差异）：主 Agent 流 = 'stream'，子 Agent 装配 = 'query'。
   * 它决定 reasoning-only 空响应的 `context.source`，QueryLoop 的 reasoning-only 恢复靠这个标签匹配，
   * 不能一律写死 'stream'，否则子 Agent 丢掉 reasoning-only 空流恢复抗体。缺省 'stream'。
   */
  emptyStreamSource?: "stream" | "query";
  onInterruptedPartial?: (partial: InterruptedStreamPartial) => void;
}

export interface PendingStreamToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  providerToolName: string;
  requestAdvertised: boolean;
  streamedInput?: {
    inputText: string;
  };
}

export interface StreamIdleThinkingNotifier {
  dispose(): void;
  markChunkReceived(): void;
}

export interface ReadNextStreamPartIdleTimeoutOptions {
  abortSignal: AbortSignal
  idleStallTimeoutMs?: LooseOptional<number>
  model: string
  requestFingerprint?: unknown
  source: string
  timerName: string
  turn: Nullable<number>
}

export interface OutputTruncationErrorContext {
  model: string
  turn: Nullable<number>
}

export interface EmptyStreamContextPressure {
  percent: number
  usableContextWindow: number
}

export interface EmptyAssistantStreamErrorInput {
  diagnostics: StreamDiagnostics
  contextPressure?: EmptyStreamContextPressure
  fallbackText?: string
  requestFingerprint?: unknown
  source: 'stream' | 'query'
  turn: Nullable<number>
}

export type ProviderStreamPart = TextStreamPart<ToolSet>

export interface LeakedToolMarkupFilterState {
  /** 已进入抑制态：锚点已出现，其后一切文本都丢弃。 */
  suppressing: boolean
  /** 跨 delta 承接可能是锚点前缀的尾巴。 */
  tail: string
}

export type InlineReasoningSegmentKind = 'visible' | 'reasoning'

export interface InlineReasoningSegment {
  kind: InlineReasoningSegmentKind
  text: string
}

export interface InlineReasoningTagSplitState {
  /** 当前是否处在思考标签内部。 */
  inReasoning: boolean
  /** 处在思考标签内部时，正在等待的闭标签。 */
  activeCloseTag: string
  /** 跨 delta 承接的、可能是标签前缀的尾巴。 */
  tail: string
}

export type StreamActivityDiagnostics = Pick<
  StreamDiagnostics,
  | 'totalChunks'
  | 'partTypes'
  | 'textDeltaChars'
  | 'reasoningDeltaChars'
  | 'rawVisibleChars'
  | 'rawReasoningChars'
  | 'toolCallCount'
>

export type StreamFinishDiagnostics = Pick<StreamDiagnostics, 'finishReasons' | 'rawFinishReasons'>

export type StreamUsageDiagnostics = Pick<
  StreamDiagnostics,
  | 'inputTokens'
  | 'outputTokens'
  | 'visibleOutputTokens'
  | 'totalTokens'
  | 'reasoningTokens'
  | 'cachedInputTokens'
  | 'cacheReadInputTokens'
  | 'cacheWriteInputTokens'
  | 'costUsd'
>

export interface ProviderToolInputDraft {
  id: string;
  toolName: string;
  providerToolName: string;
  requestAdvertised: boolean;
  inputText: string;
  inputEnded: boolean;
}

export interface ProviderToolNameResolution {
  toolName: string;
  providerToolName: string;
  requestAdvertised: boolean;
}

export interface ProviderFinalToolCallIdentity {
  toolNameResolution: ProviderToolNameResolution;
  streamedInput: Nullable<ProviderToolInputDraft>;
}

export type ProviderFinalToolInputResolution =
  | { ok: true; input: Record<string, unknown>; reparsedString: boolean }
  | {
      ok: false;
      reason:
        "final_tool_input_json_parse_failed" | "final_tool_input_not_object";
      receivedType: string;
      inputChars: number;
    };

export type ProviderExecutableToolInputResolution =
  | {
      ok: true;
      input: Record<string, unknown>;
      source: "final" | "ended-stream-draft";
    }
  | Extract<ProviderFinalToolInputResolution, { ok: false }>;

export interface ProviderJsonTextDiagnostic {
  inputChars: number;
  trimmedChars: number;
  startsWithObject: boolean;
  endsWithObject: boolean;
  objectDepth: number;
  arrayDepth: number;
  terminatedInString: boolean;
  danglingEscape: boolean;
  mismatchedDelimiter: boolean;
  rawControlCharactersInString: number;
  parseStatus: "object" | "json-non-object" | "invalid-json";
}

export interface RejectedProviderToolInputDiagnostic {
  final?: ProviderJsonTextDiagnostic;
  streamDraft?: ProviderJsonTextDiagnostic & {
    inputEnded: boolean;
    identicalToFinal: boolean;
  };
}

export type ProviderToolInputPartLike =
  | { type: "tool-input-start"; id: string; toolName: string }
  | { type: "tool-input-delta"; id: string; delta: string }
  | { type: "tool-input-end"; id: string };

export type CoreProviderOptions = AgentModelRequestOptions['providerOptions']

export type ModelMessageProviderOptions = NonNullable<ModelMessage['providerOptions']>

export interface ProviderResponseFailure {
  readonly code: Nullable<string>
  readonly message: Nullable<string>
  readonly statusCode: Nullable<number>
}

export interface PlanContextRunInput {
  model: string
  contextWindow?: number
  toolSchemaChars?: Readonly<Record<string, number>>
  toolSchemaBudgetScale?: number
}

export interface PlanRecoveryRunInput {
  forcedToolChoice?: { type: 'tool'; toolName: string }
  pageFaults?: readonly ToolPageFault[]
  requiresCapabilityEvidence?: boolean
  capabilityEvidenceSnapshot?: CapabilityEvidenceSnapshot
}

export interface CapabilityEvidenceSnapshot {
  hasEvidence: boolean
  isStale: boolean
}

export interface BuildPromptRunPlanInput {
  runProfile: RunProfileId
  bootstrapReminder?: string
  pageFaults?: readonly ToolPageFault[]
  recovery?: RecoveryRunPlan
}

export interface SoloToolSchemaTelemetryContext {
  codingSession: {
    getToolSurfaceProfile: () => ToolSurfaceProfileId
  }
}

export interface BuildSoloToolSchemaTelemetryInput<TContext extends SoloToolSchemaTelemetryContext> {
  toolContext: TContext
  allowedTools: string[]
  estimateCurrentSerializedChars?: (
    toolContext: TContext,
    allowedTools: string[]
  ) => LooseOptional<number>
  estimateBaselineSerializedChars?: (
    toolContext: TContext,
    profile: ToolSurfaceProfileId,
    allowedTools: string[]
  ) => LooseOptional<number>
}

export interface BuildSoloRunProfileTelemetryInput {
  profile: RunProfileId
  reason: string
  contextWindow: Nullable<number>
  physicalContextWindow: Nullable<number>
  maxInputWorkingSetTokens: Nullable<number>
  maxToolCount: Nullable<number>
  maxSystemPromptChars: Nullable<number>
  baseAllowedToolCount: number
  exposedToolCount: number
  droppedTools: string[]
  systemPromptChars: number
  skippedPromptSegments: StreamTurnContextPayload['skippedPromptSegments']
}

export interface SoloToolAllocatorTelemetryPlan {
  baselineToolNames?: string[]
  grantedCategoryIds: ToolCategoryId[]
  grantedToolNames: string[]
  deniedRequests: NonNullable<StreamTurnContextPayload['toolAllocatorTelemetry']>['deniedRequests']
  fuse: {
    tripped: boolean
    message?: LooseOptional<string>
  }
  advisor: {
    called: boolean
    message?: LooseOptional<string>
    error?: LooseOptional<string>
  }
  toolLayerMetrics?: LooseOptional<Partial<ToolLayerTelemetryMetrics>>
  message?: LooseOptional<string>
}

export interface SoloToolSpaceBootstrapFallbackEvents {
  emitRuntime(payload: StreamTurnEndPayload): void
}

export interface SoloToolSpaceBootstrapFallbackToolChoice {
  type: 'tool'
  toolName: string
}

export interface SoloToolSpaceBootstrapFallbackReminder {
  id: string
  text: string
}

export interface RunSoloToolSpaceBootstrapFallbackInput<
  TEvents extends SoloToolSpaceBootstrapFallbackEvents = SoloToolSpaceBootstrapFallbackEvents,
> {
  turn: number
  history: ModelMessage[]
  bootstrapToolChoice: LooseOptional<SoloToolSpaceBootstrapFallbackToolChoice>
  internalReminders: readonly SoloToolSpaceBootstrapFallbackReminder[]
  ignoredToolChoice: {
    enabled: boolean
    maxRetries: number
  }
  getBootstrapState(): ToolSpaceBootstrapState
  events: TEvents
  log: Pick<ScopedLog, 'debug'>
}

export type SoloToolSpaceBootstrapFallbackResult =
  | { status: 'continue'; reason: 'ignored-tool-choice' }
  | { status: 'idle' }

export interface SoloProcessUpdateCadenceState {
  consecutiveToolOnlyTurns: number
}

export interface AdvanceSoloProcessUpdateCadenceInput {
  hasVisibleText: boolean
}

export interface AdvanceSoloProcessUpdateCadenceResult {
  state: SoloProcessUpdateCadenceState
  reminder: Nullable<string>
}

export interface AgentExecutionLimits {
  /** 普通主 Agent 单次执行的墙钟硬上限。 */
  standardExecutionWallClockTimeoutMs: number
  /** Goal 模式或已建立活动目标的主 Agent 墙钟硬上限。 */
  goalExecutionWallClockTimeoutMs: number
  /** 主 Agent 轮次上限；null 表示不按轮次收尾。 */
  primaryMaxTurns: Nullable<number>
  /** 单个子 Agent 到点后的软收尾时间。 */
  subAgentSoftDeadlineMs: number
  /** 子 Agent 轮次上限；null 表示不按轮次收尾。 */
  subAgentMaxTurns: Nullable<number>
  /** 单次模型流连续没有任何新数据时的判死时间。 */
  modelStreamIdleTimeoutMs: number
  /** 执行结束后，每个父会话最多保留多少条子 Agent 线程供续跑（超出按最近使用淘汰）；0 = 不保留。 */
  subAgentRetainedThreadsPerSession: number
  /** 全进程最多保留多少条已脱离执行的子 Agent 线程（跨父会话，超出按最近使用淘汰）；0 = 不保留。 */
  subAgentRetainedThreadsTotal: number
  /** 已脱离执行的子 Agent 线程空闲多久后释放。 */
  subAgentRetainedThreadIdleTtlMs: number
  /** 子 Agent 线程历史的序列化字符上限；超过即不可续跑、执行结束后不保留。 */
  subAgentRetainedHistoryMaxChars: number
}

export type AgentExecutionLimitOverrides = Partial<AgentExecutionLimits>

export interface SoloContextDegradeToolContext {
  sessionId?: LooseOptional<string>
  setCurrentVisibleToolNames: (toolNames: string[]) => void
  codingSession: {
    getToolUsageScores?: () => Readonly<Record<string, number>>
  }
}

export interface SoloContextDegradeToolRegistry<TContext> {
  estimateToolSerializedCharsByName?: (
    toolContext: TContext,
    allowedTools: string[]
  ) => Record<string, number>
}

export interface ApplySoloContextDegradeActionContext<
  TContext extends SoloContextDegradeToolContext = SoloContextDegradeToolContext,
> {
  /** 治理会话登记处：`govern-epoch` 级的落点（缺页 = 强开一次 epoch）。 */
  governanceSessions: ContextGovernanceSessionRegistry
  toolRegistry: SoloContextDegradeToolRegistry<TContext>
  log: Pick<ScopedLog, 'warn'>
  roleRuntime: { model: string; contextWindow?: LooseOptional<number> }
  turn: number
  baseAllowedTools: string[]
  protectedTools: string[]
  enabledToolDescriptors: ToolDescriptor[]
  zoneAllocation: ContextWorkingSetBudgetAllocation
  toolContext: TContext
  currentAllowedTools: string[]
  onToolsNarrowed: (next: string[]) => void
}

export type AgentIntentSignalDomain = string

export interface AgentIntentDomainSignal {
  id: AgentIntentSignalDomain
  categories: ToolCategoryId[]
  requiresDiscovery: boolean
  requiresEvidence: boolean
  requiresMutation: boolean
  requiresValidation: boolean
}

export interface AgentIntentSignals {
  domains: AgentIntentDomainSignal[]
  requiresEvidence: boolean
  requiresMutation: boolean
  requiresValidation: boolean
  hasCapabilityUncertainty: boolean
}

export type SoloRuntimeGuidancePhase = 'turn-start' | 'before-goal-check' | 'before-complete'

export interface ConsumeSoloRuntimeGuidanceInput {
  turn: number
  phase: SoloRuntimeGuidancePhase
  history: ModelMessage[]
  runtimeInput?: AgentRuntimeInputPort
  consumeGuidance?: () => Nullable<ModelMessage> | Promise<Nullable<ModelMessage>>
  log: Pick<ScopedLog, 'info' | 'warn'>
}

export type SoloRuntimeGuidanceResult =
  | { consumed: true; reason: 'user-guidance' }
  | { consumed: false; reason: 'none' | 'non-user-message' }

export type KernelFinalReadinessReason = 'missing-verification' | 'failed-verification'

export type KernelFinalReadinessAuditResult = 'allowed' | 'blocked' | 'errored'

export interface KernelFinalReadinessAudit {
  result: KernelFinalReadinessAuditResult
  recovered: boolean
  missingVerification: number
  failedVerification: number
  verificationRelevantPaths: number
}

export interface KernelFinalReadinessResult {
  allowed: boolean
  reason: Nullable<KernelFinalReadinessReason>
  followupMessage: Nullable<string>
  audit: KernelFinalReadinessAudit
}

export interface EvaluateKernelFinalReadinessInput {
  snapshot?: LooseOptional<CodingSessionSnapshot>
}

/**
 * 单个 Agent turn 开始时捕获的只读注册表视图。
 *
 * 具体快照由宿主实现；Agent Runtime 只依赖这个消费侧端口。注册表变化因此只能在
 * 下一轮生效，不会改写已经开始构建的 provider request。
 */
export type AgentTurnCapabilitySnapshot<TRegistry> = TRegistry

export interface AgentTurnCapabilityContextView {
  listTools(scope?: ToolAvailabilityScope): unknown[]
  listToolCategories(scope?: ToolAvailabilityScope): unknown[]
  listCapabilityPages?(): unknown[]
  describeToolInputSchema?(toolName: string): unknown
}

export type ContextDegradeActionKind =
  | 'govern-epoch'
  | 'narrow-tools'
  | 'surrender'

export interface ContextDegradeAction {
  kind: ContextDegradeActionKind
  /** 当前处于阶梯第几级（从 1 开始）。 */
  level: number
  /** 收窄工具时降到的运行档（仅 narrow-tools 有意义）。 */
  narrowToProfile?: 'compact'
}

export type ContextDegradeChain = 'solo' | 'query'

export interface SoloBackgroundWaitInput {
  signal?: AbortSignal
  onWaiting?: () => void
}

export type SoloAwaitPendingBackgroundJobs = (
  input?: SoloBackgroundWaitInput
) => Promise<boolean>

export interface RunSoloBackgroundCompletionGateInput {
  turn: number
  history: ModelMessage[]
  executionAbortSignal: AbortSignal
  runtimeInput?: AgentRuntimeInputPort
  consumeTurnContextNote?: () => Nullable<string>
  awaitPendingBackgroundJobs?: SoloAwaitPendingBackgroundJobs
  emitWaitingPhase(): void
  log: Pick<ScopedLog, 'info'>
}

export type SoloBackgroundCompletionGateResult =
  | { status: 'ready' }
  | {
      status: 'continue'
      reason: 'late-context' | 'background-terminal'
    }
  | { status: 'interrupted' }

export interface AbortSignalScope {
  signal: AbortSignal
  dispose(): void
}

export interface SoloRunPlanToolCategory<TTool extends ToolDescriptor = ToolDescriptor> {
  category: ToolCategoryOverview['category']
  enabled: boolean
  tools: TTool[]
}

export interface SoloRunPlanCodingSession {
  getRunProfile(): RunProfileSelectionId
  enableToolCategories(categories: ToolCategoryId[], reason?: string): ToolCategoryId[]
  enableToolNames?(toolNames: string[], reason?: string): string[]
  getEnabledToolCategories(): ToolCategoryId[]
  getBudgetOverrideToolCategories(): ToolCategoryId[]
  getBudgetOverrideToolNames(): string[]
  drainToolAllocatorRequests?(): ToolAllocatorRequest[]
  isToolCategoryAllowed(categoryId: ToolCategoryId): boolean
  setThinkingDepth?(thinkingDepth: ThinkingDepth): ThinkingDepth
  setToolSurfaceProfile?(profile: ToolSurfaceProfileId, reason?: string): ToolSurfaceProfileId
  getToolUsageScores?: () => Readonly<Record<string, number>>
  getToolSchemaBudgetScale?: () => number
  setUsableContextWindowTokens?: (tokens: Nullable<number>) => void
  pruneExpiredToolNameLeases?: (turn: number) => string[]
  pruneExpiredToolCategoryLeases?: (turn: number) => ToolCategoryId[]
  getTurnPlanningSnapshot?: <TSnapshot = unknown>(signature: string) => Nullable<TSnapshot>
  setTurnPlanningSnapshot?: (signature: string, snapshot: unknown) => void
  recordTurnPlanningTelemetry?: (entry: TurnPlanningTelemetryPayload) => void
  collectNewlyEvictedPagedInTools?: (evictedToolNames: readonly string[]) => string[]
  getCapabilityEvidenceSnapshot?(): BuildAgentRunPlanInput['capabilityEvidenceSnapshot']
}

export interface SoloRunPlanToolContext {
  capabilityPorts?: AgentRuntimeCapabilityPorts
  codingSession: SoloRunPlanCodingSession
  getCurrentVisibleToolNames(): string[]
  setCurrentVisibleToolNames(toolNames: string[]): void
  listToolCategories(
    scope?: 'enabled' | 'all' | 'system-enabled' | 'catalog'
  ): Array<SoloRunPlanToolCategory<ToolDescriptor>>
}

export interface SoloRunPlanToolRegistry<TContext extends SoloRunPlanToolContext> {
  getCapabilityRevision?(): string | number
  listCategories?(
    toolContext: TContext,
    allowList?: string[],
    scope?: 'enabled' | 'all' | 'system-enabled' | 'catalog'
  ): Array<SoloRunPlanToolCategory<ToolDescriptor>>
  estimateToolSerializedCharsByName?: (
    toolContext: TContext,
    allowedTools: string[]
  ) => Record<string, number>
}

export interface SoloRunPlanRoleRuntime {
  providerId: string
  model: string
  providerModel?: string
  contextWindow?: number
  supportedInputModalities: readonly AgentModelInputModality[]
  modelRequestOptions?: AgentModelRequestOptions
  runProfilePolicy?: RunProfileRuntimePolicy
}

export interface SoloRunPlanToolAllocator {
  plan(input: {
    turn: number
    latestUserText: string
    requests: readonly ToolAllocatorRequest[]
    runtimeToolCategories: Array<SoloRunPlanToolCategory<ToolDescriptor>>
    catalogToolCategories?: Array<SoloRunPlanToolCategory<ToolDescriptor>>
    enabledToolCategoryIds: readonly ToolCategoryId[]
    allowedToolCategoryIds: readonly ToolCategoryId[]
    satisfiedPrerequisiteIds?: readonly string[]
  }): SessionToolAllocatorPlan | Promise<SessionToolAllocatorPlan>
}

export interface PrepareSoloRunPlanForTurnInput<TContext extends SoloRunPlanToolContext> {
  turn: number
  history: ModelMessage[]
  configuredTools?: readonly string[]
  roleAllowedTools: readonly string[]
  /** 显式选中技能声明的工具门控并集（allowed-tools）；null/空 = 不限制。 */
  skillAllowedToolNames?: LooseOptional<readonly string[]>
  promptFeatures?: readonly ChatPromptFeatureId[]
  /**
   * 本次运行的思考深度，**由调用方一次算定**（`AgentExecutionConfig.thinkingDepth` ?? 系统设置）。
   *
   * 这里不再有第二个写者：档位默认只在宿主组装 run config 时作为**缺席默认**参与
   * （例如宿主可读取 `runProfilePolicy.defaults.thinkingDepth`），
   * 进了 loop 就是既定事实。
   */
  thinkingDepth: ThinkingDepth
  /** 执行模式轴；缺席时由旧形态（promptFeatures 里的模式 id / goalMode）折算。 */
  executionModes?: readonly ExecutionModeId[]
  goalMode?: boolean
  contextPhase: AgentContextPhase
  activeCapabilityScopeId: CapabilityScopeId
  agentSurfaceId?: LooseOptional<AgentSurfaceId>
  roleRuntime: SoloRunPlanRoleRuntime
  toolContext: TContext
  toolRegistry: SoloRunPlanToolRegistry<TContext>
  bootstrapState: ToolSpaceBootstrapState
  setBootstrapState(state: ToolSpaceBootstrapState): void
  log: Pick<ScopedLog, 'info'>
  toolAllocator?: SoloRunPlanToolAllocator
  toolAllocatorRequests?: readonly ToolAllocatorRequest[]
}

export interface PrepareSoloRunPlanForTurnResult {
  resolvedRunProfile: RunProfileRuntimePolicy
  runProfile: RunProfileId
  runProfileDefinition: RunProfileDefinition
  runPlan: AgentRunPlan
  zoneAllocation: AgentRunPlan['context']['zoneAllocation']
  allowedTools: string[]
  toolSchemaChars?: Readonly<Record<string, number>>
  bootstrapToolChoice: Nullable<AgentRunPlan['capabilities']['forcedToolChoice']>
  enabledToolDescriptors: ToolDescriptor[]
  baseAllowedTools: string[]
  protectedTools: string[]
  toolExposure: {
    allowedTools: string[]
    droppedTools: string[]
    maxToolCount: Nullable<number>
  }
  promptToolCategories: PromptStatePreparedToolCategories
  promptBudget: Nullable<AgentRunPlan['prompt']['promptBudget']>
  toolAllocatorPlan: Nullable<SessionToolAllocatorPlan>
}

export interface SoloTurnPlanningSnapshot {
  runtimeToolCategories: Array<SoloRunPlanToolCategory<ToolDescriptor>>
  allocatorCatalogToolCategories: Array<SoloRunPlanToolCategory<ToolDescriptor>>
  allowedToolCategoryIds: ToolCategoryId[]
  visibleEnabledToolCategories: Array<SoloRunPlanToolCategory<ToolDescriptor>>
  toolSchemaCandidateTools: string[]
  toolSchemaChars?: Readonly<Record<string, number>>
}

export interface RunSoloTurnWindDownInput {
  turn: number
  hardCap: number
  history: ModelMessage[]
  log: Pick<ScopedLog, 'warn'>
}

export interface SubAgentOptionsLike {
  toolCategories?: ToolCategoryId[]
  allowedTools?: string[]
  identity?: string
  contextEpochScope?: LooseOptional<string>
  context?: string
  roleId?: AgentRoleId
  delegation?: AgentDelegationContract
  streamTextDeltas?: boolean
  requestToolCategories?: (
    categories: ToolCategoryId[],
    reason: string,
    options?: { childRoleId?: AgentRoleId }
  ) => Promise<SubAgentToolCategoryRequestResult>
}

export interface ResolveSubAgentDelegationArgs {
  task: string
  opts: SubAgentOptionsLike
  parentRoleId: AgentRoleId
}

export interface ResolveSubAgentToolScopeArgs {
  delegation: AgentDelegationContract
  authorizedToolNames?: readonly string[]
  roleResolution: Pick<AgentRoleResolution, 'allowedTools' | 'enabledToolCategories' | 'label'>
  getToolNamesForCategories: (categories: ToolCategoryId[]) => string[]
  getAllowedSubAgentTools: (tools?: string[]) => string[]
  getToolCategoryId: (toolName: string) => Nullable<ToolCategoryId>
  blockedToolNames?: readonly string[]
  blockedCategoryIds?: readonly ToolCategoryId[]
}

export interface SubAgentToolScope {
  allowedTools: string[]
  allowedCategories: ToolCategoryId[]
}

export interface SubAgentContextBase {
  abortSignal: AbortSignal
  log: unknown
  role: {
    id: AgentRoleId
    label: string
    description: string
    nextAllowedRoles: AgentRoleId[]
  }
  /** enabled=本轮可执行，all=当前运行态可用全集，catalog=注册目录全集。 */
  listTools(scope?: ToolAvailabilityScope): ToolDescriptor[]
  /** enabled=本轮可执行，all=当前运行态可用全集，catalog=注册目录全集。 */
  listToolCategories(scope?: ToolAvailabilityScope): ToolCategoryOverview[]
  listCapabilityPages?: () => unknown[]
  getEnabledToolCategories(): ToolCategoryId[]
  getCurrentVisibleToolNames(): string[]
  setCurrentVisibleToolNames(toolNames: string[]): void
  getSupportedModelInputModalities(): readonly AgentModelInputModality[]
  setSupportedModelInputModalities(modalities: readonly AgentModelInputModality[]): void
  system?: unknown
  project?: unknown
  getCurrentVisibleToolSurfaceProfile?(toolName: string): unknown
  setCurrentVisibleToolSurfaceProfiles?(profiles: Record<string, unknown>): void
  codingSession: {
    enableToolCategories(categories: ToolCategoryId[], reason?: string): ToolCategoryId[]
    getEnabledToolCategories(): ToolCategoryId[]
    getEnabledPromptFeatures?: () => unknown[]
    hasToolCategoryAccess(category: ToolCategoryId): boolean
  }
  query(task: string, opts?: unknown): Promise<string>
  requestToolCategoryAccess?: (
    categories: ToolCategoryId[],
    reason: string
  ) => Promise<SubAgentToolCategoryRequestResult>
  capabilityPorts?: AgentRuntimeCapabilityPorts
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

export interface CreateSubAgentContextArgs<TContext extends SubAgentContextBase> {
  parentCtx: TContext
  roleResolution: Pick<
    AgentRoleResolution,
    'id' | 'label' | 'description' | 'nextAllowedRoles' | 'allowedTools'
  >
  allowedTools: readonly string[]
  allowedCategories: readonly ToolCategoryId[]
  getAllowedSubAgentTools: (tools?: string[]) => string[]
  getToolNamesForCategories: (categories: ToolCategoryId[]) => string[]
  log: TContext['log']
  requestToolCategories?: SubAgentOptionsLike['requestToolCategories']
  blockedToolNames?: readonly string[]
  blockedCategoryIds?: readonly ToolCategoryId[]
}

export interface ResolveSoloLoopToolsArgs {
  configuredTools?: readonly string[]
  roleAllowedTools: readonly string[]
  enabledToolNames: Iterable<string>
}

/** 宿主端口里能跑命令的那一部分：system 与 project 的 runCommand 都把 background 放在第二个参数里。 */
export type CommandRunningPort = {
  runCommand: (command: string, options?: { background?: boolean }, ...rest: unknown[]) => Promise<unknown>
}

export type ToolSpaceBootstrapDecisionKind = 'none' | 'preload' | 'discover'

export interface ToolSpaceBootstrapState {
  lastDecisionFingerprint?: string
  forcedDiscoveryCount?: number
  suppressedUntilTurn?: number
}

export interface ToolSpaceBootstrapDecision {
  kind: ToolSpaceBootstrapDecisionKind
  reason?: string
}

export interface ToolSpaceForcedToolChoice {
  type: 'tool'
  toolName: 'tooling:map'
}

export interface ToolSpaceBootstrapPlannerInput {
  messages: ModelMessage[]
  currentVisibleToolNames: readonly string[]
  enabledToolCategories: readonly ToolCategoryId[]
  allowedToolCategories?: readonly ToolCategoryId[]
  capabilityPorts?: AgentRuntimeCapabilityPorts
  turn?: number
  state?: ToolSpaceBootstrapState
}

export interface ToolSpaceBootstrapPlan {
  decision: ToolSpaceBootstrapDecision
  pageInCategories: ToolCategoryId[]
  pageInTools: string[]
  forcedToolChoice: Nullable<ToolSpaceForcedToolChoice>
  internalReminder: Nullable<string>
  nextState: ToolSpaceBootstrapState
}

export interface IntentDomainMatch {
  id: AgentIntentSignalDomain
  categories: ToolCategoryId[]
  requiresDiscovery: boolean
}

export interface ToolCategory<TTool extends { name: string } = ToolDescriptor> {
  category: { id: ToolCategoryId }
  tools: TTool[]
}

export interface PlanCapabilityRunInput {
  messages: ModelMessage[]
  runProfile: RunProfileId
  configuredTools?: string[]
  roleAllowedTools: string[]
  currentVisibleToolNames: readonly string[]
  enabledToolCategoryIds: readonly ToolCategoryId[]
  budgetOverrideToolCategoryIds: readonly ToolCategoryId[]
  budgetOverrideToolNames: readonly string[]
  visibleEnabledToolCategories: Array<ToolCategory<ToolDescriptor>>
  runtimeToolCategories: Array<ToolCategory<ToolDescriptor>>
  allowedToolCategoryIds: readonly ToolCategoryId[]
  capabilityPorts?: AgentRuntimeCapabilityPorts
  capabilityScopeId?: CapabilityScopeId
  turn: number
  toolSchemaChars?: Readonly<Record<string, number>>
  toolSchemaCharBudget: number
  toolUsageScores?: Readonly<Record<string, number>>
  bootstrapState?: ToolSpaceBootstrapState
  collectNewlyEvictedPagedInTools?: (evictedToolNames: readonly string[]) => readonly string[]
}

export interface ResolveCapabilityPageFaultsInput {
  requestedForcedToolChoice?: LooseOptional<{ type: 'tool'; toolName: string }>
  resolvedForcedToolChoice?: LooseOptional<{ type: 'tool'; toolName: string }>
  enabledToolDescriptors: readonly ToolDescriptor[]
  baseAllowedToolNames: readonly string[]
  droppedToolNames: readonly string[]
  budgetOverrideToolNames: readonly string[]
  collectNewlyEvictedPagedInTools?: (evictedToolNames: readonly string[]) => readonly string[]
}

export interface PlanAgentIntentInput {
  messages: ModelMessage[]
  capabilityPorts?: AgentRuntimeCapabilityPorts
  capabilityScopeId?: string
}

export interface BuildAgentRunPlanLedgerInput {
  intent: AgentIntentPlan
  context: ContextRunPlan
  capabilities: CapabilityRunPlan
  recovery: RecoveryRunPlan
  capabilityEvidenceSnapshot?: CapabilityEvidenceSnapshot
}

export interface BuildAgentRunPlanInput
  extends Omit<PlanCapabilityRunInput, 'messages' | 'runProfile' | 'toolSchemaCharBudget'> {
  history: ModelMessage[]
  roleRuntime: AgentRuntimePlan
  requestedRunProfile: RunProfileSelectionId
  capabilityEvidenceSnapshot?: CapabilityEvidenceSnapshot
  toolSchemaBudgetScale?: number
}

export interface SoloFinishingGateEvents {
  emitRuntime(payload: StreamTurnEndPayload): void
}

export interface RunSoloFinishingGateInput<
  TToolContext,
  TEvents extends SoloFinishingGateEvents = SoloFinishingGateEvents,
> {
  turn: number
  history: ModelMessage[]
  toolContext: TToolContext
  events: TEvents
  abortSignal: AbortSignal
  emitAbort(): void
  tickLoopReminders(input: {
    mode: 'solo'
    phase: 'finishing'
    toolContext: TToolContext
  }): Promise<string[]>
  runAutomaticVerification(input: {
    toolContext: TToolContext
  }): Promise<AutoVerificationGateResult>
  runtimeInput?: AgentRuntimeInputPort
  consumeGuidance?: () => Nullable<ModelMessage> | Promise<Nullable<ModelMessage>>
  /** 在 runtime input takeOrSeal 之前，处理后台任务通知或停泊 wait-any。 */
  settlePendingBackgroundJobs?: () => Promise<SoloBackgroundCompletionGateResult>
  goalMode?: boolean
  inspectGoalState?: () => Promise<SoloGoalFinishingState>
  recordGoalCompletionAttempt?: (state: SoloGoalFinishingState) => Promise<void>
  finishingGateBlockTracker?: SoloFinishingGateBlockTracker
  log: Pick<ScopedLog, 'debug' | 'info' | 'warn'>
}

export type SoloFinishingGateContinueReason =
  | 'finishing-reminder'
  | 'verification-followup'
  | 'final-readiness'
  | 'background-task'
  | 'user-guidance'
  | 'goal-status-required'

export type SoloFinishingGateRepeatableReason = Extract<
  SoloFinishingGateContinueReason,
  'verification-followup' | 'final-readiness' | 'goal-status-required'
>

export interface SoloFinishingGateBlockTracker {
  reason: Nullable<SoloFinishingGateRepeatableReason>
  count: number
}

export type SoloFinishingGateResult =
  | {
      status: 'continue'
      reason: SoloFinishingGateContinueReason
    }
  | { status: 'aborted' }
  | { status: 'completed' }
  | {
      status: 'error'
      reason: 'repeated-finishing-gate'
      blockedReason: SoloFinishingGateRepeatableReason
    }

export type SoloGoalFinishingStatus = 'missing' | 'active' | 'complete' | 'blocked'

export interface SoloGoalFinishingState {
  exists: boolean
  terminal: boolean
  status: SoloGoalFinishingStatus
  objective?: LooseOptional<string>
  blockedAuditTurns?: LooseOptional<number>
}

export interface AgentContextPhaseDecision {
  phase: AgentContextPhase
  reason: AgentContextPhaseReason
}

export interface ResolveAgentContextPhaseInput {
  turn: number
  history: readonly ModelMessage[]
  agentSurfaceId?: LooseOptional<AgentSurfaceId>
  unattended?: boolean
  /** 执行模式轴；缺席时由旧形态（promptFeatures 里的模式 id / goalMode）折算。 */
  executionModes?: readonly ExecutionModeId[]
  goalMode?: boolean
  selectedSkillIds?: readonly string[]
  promptFeatures?: readonly ChatPromptFeatureId[]
  hasActiveContext?: boolean
}

export interface ExecuteLoopTurnWithContextOverflowRecoveryInput<TTurnResult> {
  turn: number
  abortSignal: AbortSignal
  /** 发起一次单轮模型调用；溢出恢复后会用同一轮重试。 */
  executeTurn(): Promise<TTurnResult>
  /** 第 attempt 次缺页（从 0 起）应采取的降级动作（面提供阶梯：solo=RecoveryRunPlan，query=chain 表）。 */
  resolveAction(attempt: number): ContextDegradeAction
  /** 执行一级降级动作；true = 状态真变（可重试），false = 走下一级。 */
  applyAction(action: ContextDegradeAction): Promise<boolean>
  /** 每次真正重试前的面装配点（主面在此重建 ToolExecutor 保证干净重放）。 */
  onBeforeRetry?(): void
  /** 阶梯耗尽日志（面各自措辞；载荷统一 turn/attempts）。 */
  surrenderLogMessage: string
  log: Pick<ScopedLog, 'error'>
}

export interface LoopTurnSpans {
  turnScope: Nullable<TurnSpanScope>
  modelSpan: Nullable<ModelSpanHandle>
  modelIdentity: {
    provider: string
    model: string
  }
}

/** 双面 turn 结果的观测富化子面（StreamTurnResult / QueryTurnResult 结构上都满足）。 */
export interface LoopTurnSpanUsage {
  inputTokens?: LooseOptional<number>
  outputTokens?: LooseOptional<number>
  costUsd?: LooseOptional<number>
  finishReason?: LooseOptional<string>
  requestFingerprint?: LooseOptional<string>
  providerRequestSnapshot?: LooseOptional<ProviderRequestSnapshot>
}

export interface LoopTurnPromptAudit {
  systemPrompt: string
  promptSegments: readonly PromptSegmentTrace[]
  skippedPromptSegments: readonly SkippedPromptSegmentTrace[]
}

export interface LoopTurnSpanFailure {
  code: string
  message: string
}

export interface SoloToolUseContinuationEvents {
  emitRuntime(payload: StreamTurnEndPayload): void
}

export interface SoloToolUseContinuationToolChoice {
  type: 'tool'
  toolName: string
}

export interface SoloToolUseContinuationToolResult {
  toolName: string
  error?: LooseOptional<string>
}

export interface RunSoloToolUseContinuationInput<
  TExecutor,
  TToolContext,
  TEvents extends SoloToolUseContinuationEvents = SoloToolUseContinuationEvents,
> {
  turn: number
  history: ModelMessage[]
  executor: TExecutor
  bootstrapToolChoice: LooseOptional<SoloToolUseContinuationToolChoice>
  getBootstrapState(): ToolSpaceBootstrapState
  setBootstrapState(state: ToolSpaceBootstrapState): void
  appendToolResultsToHistory(
    history: ModelMessage[],
    executor: TExecutor
  ): Promise<SoloToolUseContinuationToolResult[]>
  toolContext: TToolContext
  tickLoopReminders(input: {
    mode: 'solo'
    phase: 'after-tool'
    toolContext: TToolContext
  }): Promise<string[]>
  /**
   * 护栏 1（轮次上限）margin 记账：本轮是收尾提醒后的又一次工具调用时返回 true = 强制收尾。
   * 机制单源在 LoopWindDownGuard（面装配为 guard.recordToolUseTurn）。
   */
  shouldForceStopAfterToolTurn(): boolean
  hardCap: number
  events: TEvents
  log: Pick<ScopedLog, 'debug' | 'warn'>
}

export type SoloToolUseContinuationResult =
  | { status: 'continue'; toolResults: SoloToolUseContinuationToolResult[] }
  | {
      status: 'completed'
      reason: 'wind-down-cap'
      toolResults: SoloToolUseContinuationToolResult[]
    }

export interface SoloLoopToolCategory<TTool extends { name: string } = { name: string }> {
  category: { id: ToolCategoryId }
  tools: TTool[]
}

export type SoloLoopProtectedToolCategory = SoloLoopToolCategory

export interface ResolveSoloLoopProtectedToolsArgs {
  enabledToolCategories: SoloLoopProtectedToolCategory[]
  budgetOverrideToolCategories: ReadonlySet<ToolCategoryId> | readonly ToolCategoryId[]
  budgetOverrideToolNames: readonly string[]
}

export interface ResolveSoloLoopToolCategoriesForExposureArgs<TTool extends { name: string }> {
  visibleEnabledToolCategories: Array<SoloLoopToolCategory<TTool>>
  runtimeToolCategories: Array<SoloLoopToolCategory<TTool>>
  enabledToolCategoryIds: readonly ToolCategoryId[]
  budgetOverrideToolCategories: ReadonlySet<ToolCategoryId> | readonly ToolCategoryId[]
}
