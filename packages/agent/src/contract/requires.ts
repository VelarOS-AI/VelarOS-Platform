
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { LanguageModel, ModelMessage } from 'ai'

import type { ScopedLog } from '@velaros-ai/core/logger'
import type { KernelModuleHealth,ScopeRef } from '@velaros-ai/kernel/contracts/abi'
import type { RemoteNodeCredentialStore } from '@velaros-ai/kernel/remote/client'

import type { ActiveContextArchiveFilter, ActiveContextArtifact, ActiveContextGovernanceOptions, ActiveContextGovernanceReport, ActiveContextListOptions, ActiveContextUpsertInput, AgentDeveloperContext, AgentRoleId, AgentSkillDescriptor, AgentSkillSourceKind, AgentSurfaceId, AppLocale, ApprovalDecision, CapabilityScopeId, ChatContextReadEvidenceRequest, ChatContextReadEvidenceResult, ChatContextReadToolPayloadRequest, ChatContextRetrievedPayload, ChatContextRetrievePayloadRequest, ChatContextSearchConversationHistoryRequest, ChatContextSearchConversationHistoryResult, ChatContextSearchTerminalOutputRequest, ChatContextSearchTerminalOutputResult, ChatMessage, ChatPromptFeatureId, ChatSessionPayloadSnapshot, ChatSessionToolResultPayload, CustomSubAgentDefinition, CustomSubAgentDescriptor, ExecutionModeId, ExecutionTaskExecutionAdvice, ExecutionTaskPlanStep, ExecutionTaskRecommendedAction, ExecutionTaskRecord, PermissionConfirmationMode, PromptSegmentOverride, ReasoningLevel, RunProfileSelectionId, SessionLineageContext, SubAgentTypeId,ThinkingDepth, ToolCategoryId, ToolConfirmationDecisionOptions, ToolExecutionPlanUpdate, ToolSurfaceProfileId } from '../types/agent.js'
import type { AgentRuntimeCapabilityExtension,CapabilityIntentClassifierContext, CapabilityIntentSignal, CapabilityScopeCategoryDecision, CapabilityScopeResidency, CapabilityScopeRuntimeFacts, CapabilityValidationInterpretation, ToolAllocationDelegation, ToolAllocationPrerequisite, ToolResultMiddlewareContext, ToolResultMiddlewareResult, ToolValidationHintContext, ToolValidationRecovery } from '../types/capabilities.js'
import type { RemoteHostToolEntry } from '../types/connectors.js'
import type { ContextPayloadRecord, ContextUserTextRecord } from '../types/context.js'
import type { SubAgentDispatchCatalog, SubAgentDispatchInput, SubAgentDispatchLimitsSnapshot, SubAgentQueryOptions, SubAgentToolContext, SubAgentTypeDescriptor,TeamModelRouteRequest, TeamModelRouteResult, TeamSelectableModel } from '../types/delegation.js'
import type { AdmitKernelSessionInput, AgentCapabilityExecutionContext, ExecutionCollaborationActorHandle, ExecutionCollaborationActorInput, ExecutionGuidanceRelayPlan, ExecutionGuidanceRelayPlanInput, KernelAdmittedInput, KernelSessionInputStoreResult, PromoteKernelInputOptions } from '../types/execution.js'
import type { AgentSkillDefinition, PromptSegmentDefinition } from '../types/guidance.js'
import type { RunSpanScope,SessionLedgerWarn } from '../types/ledgers.js'
import type { AgentTurnCapabilitySnapshot,QueryLoopToolRegistry, ResolvedAgentModelRuntime, SoloLoopToolRegistry, TurnRunnerToolRegistry } from '../types/loop.js'
import type { AgentModBindings, AgentModPackDescriptorLike, VelarModArchiveEntry } from '../types/mods.js'
import type { AgentSessionApplicationEvent } from '../types/product-session.js'
import type { ExecutionEventBusApi, ExecutionResourceProvider, KernelBackgroundJobStoredOutput } from '../types/records.js'
import type { ContextFaultEvent,ContextGovernanceConfigInput, ContextResidencyMigrationEvent } from '../types/residency.js'
import type { AgentExecutionStackToolContext, AgentRoleDefinition, AgentRoleDescriptorProviderContext, AgentRuntimeInputResult,AgentSurfaceProfile, AgentTurnBoundary, AgentTurnSettlement, DerivedAgentSurfaceRunPolicy, DeriveSurfaceRunPolicyInput, ResolveAgentSurfaceInput, RunnerBuildToolContextArgs, RunnerExecutionScope, RunnerModelCapabilityPort, RunnerToolContext } from '../types/runner.js'
import type { ReminderScope, ReminderTrigger, RuntimeReminderInput } from '../types/session.js'
import type { ToolConversationHandoffRequest, ToolConversationHandoffResult, ToolRoleSkillReadResult } from '../types/tool-context.js'
import type { ProjectKernelToolOutputInput, ProjectKernelToolOutputResult } from '../types/tools.js'

export type AgentSessionLifecycleStatus = 'idle' | 'running' | 'interrupted' | 'failed'

export type AgentBackgroundAgentState = 'running' | 'interrupted' | 'failed' | 'starting' | 'completed' | 'stopped'

/**
 * Agent 产品公共的 Session catalog 投影。kind 与 productData 是开放产品轴；Platform
 * 只拥有身份、谱系、生命周期、归档和时间戳这些跨产品不变量。
 */
export interface AgentSessionMetadata<TProductData = unknown> {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly parentSessionId: Nullable<string>
  readonly status: AgentSessionLifecycleStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt: Nullable<number>
  readonly productData: TProductData
}

export interface CreateAgentSessionMetadataInput<TProductData = unknown> {
  readonly id?: string
  readonly title?: string
  readonly kind: string
  readonly parentSessionId?: LooseOptional<string>
  readonly productData: TProductData
}

export interface AgentSessionCatalogQuery {
  readonly includeArchived?: boolean
  readonly limit?: number
}

/** 产品持久化实现（SQLite/文件/Cloud）必须适配的公共 Session application port。 */
export interface AgentSessionCatalogPort<TSession extends AgentSessionMetadata = AgentSessionMetadata> {
  create(input: CreateAgentSessionMetadataInput<TSession['productData']>): Promise<TSession> | TSession
  get(id: string): Promise<Nullable<TSession>> | Nullable<TSession>
  list(query?: AgentSessionCatalogQuery): Promise<readonly TSession[]> | readonly TSession[]
  archive(id: string): Promise<TSession> | TSession
  restore(id: string): Promise<TSession> | TSession
}

export interface AgentSessionLease {
  readonly sessionId: string
  readonly ownerId: string
  readonly ownerPid: number
  readonly acquiredAt: number
  readonly heartbeatAt: number
}

export interface AgentSessionLeaseClaim {
  readonly sessionId: string
  readonly ownerId: string
  readonly ownerPid: number
}

export interface AgentSessionLeasePort {
  get(sessionId: string): Promise<Nullable<AgentSessionLease>> | Nullable<AgentSessionLease>
  claim(input: AgentSessionLeaseClaim): Promise<AgentSessionLease> | AgentSessionLease
  heartbeat(sessionId: string, ownerId: string): Promise<AgentSessionLease> | AgentSessionLease
  release(sessionId: string, ownerId: string): Promise<void> | void
}

export interface AgentSessionResourceReference {
  readonly id: string
  readonly kind: string
  readonly uri: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface AgentBackgroundAgent {
  readonly id: string
  readonly sessionId: string
  readonly title: string
  readonly pid: Nullable<number>
  readonly state: AgentBackgroundAgentState
  readonly startedAt: number
  readonly updatedAt: number
  readonly completedAt: Nullable<number>
  readonly exitCode: Nullable<number>
}

export interface AgentBackgroundAgentPort<TAgent extends AgentBackgroundAgent = AgentBackgroundAgent> {
  get(id: string): Promise<Nullable<TAgent>> | Nullable<TAgent>
  list(input?: { includeCompleted?: boolean; limit?: number }): Promise<readonly TAgent[]> | readonly TAgent[]
  markRunning(id: string, pid: number): Promise<TAgent> | TAgent
  finish(
    id: string,
    state: Extract<AgentBackgroundAgentState, 'completed' | 'failed' | 'stopped' | 'interrupted'>,
    exitCode?: LooseOptional<number>
  ): Promise<TAgent> | TAgent
}

export interface AgentBackgroundAgentControlPort<TAgent extends AgentBackgroundAgent = AgentBackgroundAgent>
  extends AgentBackgroundAgentPort<TAgent> {
  start(input: {
    readonly sessionId: string
    readonly title: string
    readonly payload: unknown
  }): Promise<TAgent> | TAgent
  send(id: string, payload: unknown): Promise<void> | void
  wait(id: string, options?: { readonly timeoutMs?: number }): Promise<TAgent>
  stop(id: string): Promise<TAgent> | TAgent
}

/** 数据根 port：把 sessionId 解析成账本文件的绝对路径。引擎只认此端口，不直读 app 路径。 */
export interface SessionLedgerLocator {
  resolveLedgerPath(sessionId: string): string
}

/** SessionStore 引擎装配依赖。除 locator 外均可缺省；缺省用系统时钟 / randomUUID / 无回落。 */
export interface SessionStoreDeps {
  locator: SessionLedgerLocator
  now?: () => number
  nextEntryId?: () => string
  warn?: SessionLedgerWarn
}

export interface AgentModelRequestPolicy {
  temperature?: number
  topP?: number
  maxOutputTokens?: number
}

/** Opaque provider options pass through to the injected model transport. */
export interface AgentModelRequestOptions {
  providerOptions?: Record<string, unknown>
  requestPolicy?: AgentModelRequestPolicy
  runtimeContext?: Record<string, unknown>
}

export type AgentModelProvider = (
  modelId: string,
  options?: AgentModelRequestOptions
) => LanguageModel

/** Agent supplies opaque selection/context; Model owns catalog, auth and fallback. */
export interface AgentModelResolverPort {
  createAgentProvider(selection: unknown): AgentModelProvider
  resolveRoleRuntime(
    selection: unknown,
    runtimeContext?: unknown,
    signal?: AbortSignal
  ): Promise<ResolvedAgentModelRuntime>
}

/** 工具按需读取已压缩会话上下文的最小 API。 */
export interface ToolConversationContextApi {
  /** 请求宿主向用户展示会话交接批准卡；缺席表示该宿主不支持交接。 */
  requestHandoff?: (
    input: ToolConversationHandoffRequest
  ) => Promise<ToolConversationHandoffResult>
  retrieveContextPayload: (
    input: ChatContextRetrievePayloadRequest
  ) => Promise<ChatContextRetrievedPayload>
  searchConversationHistory: (
    input: ChatContextSearchConversationHistoryRequest
  ) => Promise<ChatContextSearchConversationHistoryResult>
  readEvidence: (input: ChatContextReadEvidenceRequest) => Promise<ChatContextReadEvidenceResult>
  readToolPayload: (
    input: ChatContextReadToolPayloadRequest
  ) => Promise<ChatContextRetrievedPayload>
  searchTerminalOutput: (
    input: ChatContextSearchTerminalOutputRequest
  ) => Promise<ChatContextSearchTerminalOutputResult>
}

export interface RunnerModelRuntimePort extends RunnerModelCapabilityPort {
  handleStreamError(
    error: unknown,
    turn: number,
    abortSignal: AbortSignal,
    events: ExecutionEventBusApi,
    log: ScopedLog
  ): void
  emitDone(events: ExecutionEventBusApi): void
  emitAbort(events: ExecutionEventBusApi, message?: string): void
}

export interface RunnerConfigService {
  readonly systemConfig: AgentSystemRuntimeConfig
  readonly chatConfig: AgentChatRuntimeConfig
}

export interface RunnerToolRegistry {
  readonly names: string[]
}

export interface RunnerSubAgentDispatcher<TToolContext extends RunnerToolContext> {
  describeDispatchCatalog?(): SubAgentDispatchCatalog
  dispatch(request: {
    input: SubAgentDispatchInput
    parentCtx: TToolContext
    events: ExecutionEventBusApi
    config: AgentExecutionConfig
  }): Promise<string>
  /**
   * 该执行此刻的真实派发配额（并发上限 + 总量帽剩余）。
   *
   * `agent:run_workflow` 用它当自己的上限并原样回显给模型；派发器是这些数字的唯一权威，
   * workflow 侧**不许**再有一份声明常量（否则 `effective_limits` 会与实际排队行为漂移）。
   */
  describeExecutionLimits(args: {
    executionId?: LooseOptional<string>
    sessionId: string
  }): SubAgentDispatchLimitsSnapshot
  clearExecution(executionKey: string): void
}

export interface RunnerToolContextBuilder<TToolContext extends RunnerToolContext> {
  buildToolContext(args: RunnerBuildToolContextArgs): TToolContext
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

export interface ToolRoleApi {
  /** 当前角色 id。 */
  readonly id: AgentRoleId
  /** 角色展示名称。 */
  readonly label: string
  /** 角色职责说明。 */
  readonly description: string
  /** 当前角色允许委派到的下一跳角色。 */
  readonly nextAllowedRoles: AgentRoleId[]
}

/** 本次 Agent 执行使用的模型运行时快照。 */
export interface ToolRuntimeApi {
  /**
   * Product-owned, provider-specific runtime metadata.
   *
   * The Agent Runtime treats this value as opaque and only forwards it to
   * explicitly registered tools that need the host's model runtime context.
   */
  metadata?: unknown
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

export interface ToolActiveContextApi {
  /** 列出仍需每轮完整注入的活跃上下文。 */
  listActiveContextArtifacts: (
    options?: ActiveContextListOptions
  ) => Promise<ActiveContextArtifact[]>
  /** 新增或更新活跃上下文。 */
  upsertActiveContextArtifact: (input: ActiveContextUpsertInput) => Promise<ActiveContextArtifact>
  /** 归档已完成、废弃或被用户意图切换取代的活跃上下文。 */
  archiveActiveContextArtifacts: (
    filter: ActiveContextArchiveFilter
  ) => Promise<ActiveContextArtifact[]>
  /** 生成治理建议；不会自动归档或删除任何活跃上下文。 */
  assessActiveContextGovernance: (
    options?: ActiveContextGovernanceOptions
  ) => Promise<ActiveContextGovernanceReport>
}

/**
 * Product-owned model configuration is deliberately opaque to Agent Runtime.
 * Model packages own provider ids, credentials, catalogs and fallback policy.
 */
export interface AgentChatRuntimeConfig {
  modelSelection?: unknown
  systemPromptAppend: string
}

export interface AgentSystemRuntimeConfig {
  thinkingDepth: ThinkingDepth
  disabledToolNames: string[]
  prompt: {
    segmentOverrides: PromptSegmentOverride[]
  }
  advancedRuntime: {
    maxConcurrentSubAgents?: number
    maxSubAgentsPerExecution?: number
  }
  /**
   * 上下文治理配置（v2 §7 配置面）。宿主可传入，缺省全部走默认值兜底
   * （`resolveContextGovernanceConfig` 宽容解析：越界钳制不拒绝，一个手滑的值不打死治理链路）。
   *
   * 实验臂 = 同一引擎的预设（A0-truncation / A1-mechanical / A2-distill-always / A3-adaptive），
   * 不是第二条实现路径——见 `ContextGovernancePresets`。
   */
  contextGovernance?: LooseOptional<ContextGovernanceConfigInput>
  /** Product-owned provider collection context; Agent Runtime only forwards it. */
  modelRuntimeContext?: unknown
}

/**
 * Per-run execution configuration consumed by the host-neutral Agent Runtime.
 *
 * Provider/auth fields intentionally do not exist here. The product passes an
 * opaque selection to its injected AgentModelResolverPort.
 */
export interface AgentExecutionConfig {
  modelSelection?: unknown
  locale?: AppLocale
  sessionId?: string
  /** Triggering user message identity for execution observation and real-task evaluation. */
  rootInputId?: LooseOptional<string>
  tools?: string[]
  thinkingDepth?: ThinkingDepth
  reasoningLevel?: ReasoningLevel
  sessionLineage?: LooseOptional<SessionLineageContext>
  /** 能力轴：只表达「哪些能力本轮开着」。执行模式走 `executionModes`。 */
  promptFeatures?: ChatPromptFeatureId[]
  /**
   * 执行模式轴（权威）。缺席时读取点经 `resolveExecutionModes` 从旧形态折算，
   * 因此尚未改写的宿主路径（定时任务 / 无人值守 / 外部引擎）零改动继续成立。
   */
  executionModes?: ExecutionModeId[]
  /** @deprecated 已并入 `executionModes`；保留为旧宿主入口。 */
  goalMode?: boolean
  /** Enables a host-injected execution isolation resource for this run. */
  executionIsolationEnabled?: boolean
  scope?: CapabilityScopeId
  toolSurfaceProfile?: ToolSurfaceProfileId
  runProfile?: RunProfileSelectionId
  permissionConfirmationMode?: PermissionConfirmationMode
  unattended?: boolean
  windowId?: number
  abortController?: AbortController
  execution?: LooseOptional<ToolExecutionApi>
  selectedSkillIds?: string[]
  skillArguments?: string
  agentSurfaceId?: LooseOptional<AgentSurfaceId>
  developerContext?: LooseOptional<AgentDeveloperContext>
}

/** 用于 capabilityToolNames 派生工具名时表达分类。 */
export type ReminderCapabilityResolver = (category: ToolCategoryId) => string[]

/** Producer 声明：把"什么时机发什么提醒"沉淀为静态描述，让调度器集中决定是否注入。 */
export interface RuntimeReminderProducer {
  /** 全局唯一 id；同 id 注册时覆盖。 */
  id: string
  /** 触发器集合；调度器仅在匹配触发器时考虑该 producer。 */
  triggers: readonly ReminderTrigger[]
  /** 越小越靠前；同一触发器下，命中多个时按 priority 选最高优。 */
  priority: number
  /** 单次性策略，配合 editVersion 决定是否已发。 */
  scope: ReminderScope
  /** Producer 关注的能力分类；调试展示用，render 内部可自由读取 capabilityToolNames。 */
  capabilities?: readonly ToolCategoryId[]
  /** 激活谓词；返回 false 时调度器跳过。 */
  when: (input: RuntimeReminderInput) => boolean
  /** 渲染提示文本；空文案视为不发送。 */
  render: (input: RuntimeReminderInput) => LooseOptional<string>
}

export interface AgentSessionEventPort {
  readEvents(sessionId: string): readonly AgentSessionApplicationEvent[]
  appendEvent(
    sessionId: string,
    input: {
      readonly eventId?: string
      readonly type: string
      readonly payload: unknown
      readonly createdAt?: number
    }
  ): unknown
}

/**
 * 准入断言端口。
 *
 * 语义 = 「当前进程是否处于已授权运行态」的单点断言，把执行域对具体登录判定源
 * 直接依赖收拢成一个窄接口：执行域只认端口，装配层注入实现。headless 或 BYOK 宿主可提供
 * 与其部署模型匹配的授权策略。
 */
export interface AuthGatePort {
  /** 未处于已验证登录态时抛 `AppError('AUTH')`。 */
  assertAuthenticated(): void
}

/**
 * 执行记录落盘路径端口。
 *
 * 把 ExecutionStore 持久化路径对具体存储服务的依赖收拢成一个窄接口。
 */
export interface ExecutionRecordsPathPort {
  /** 返回执行记录持久化文件路径。 */
  getExecutionRecordsPath(): string
}

/**
 * 执行资源端口。资源可表示项目、页面、设备或宿主任意可寻址对象。
 */
export interface ExecutionResourcePort extends ExecutionResourceProvider {
  /** 解析指定会话的可选执行资源标识。 */
  getExecutionResourceId(sessionId?: string): Nullable<string>
}

/**
 * 执行活动信号端口。宿主可在执行期间保持监听器或遥测会话。
 */
export interface ExecutionActivitySignalsPort {
  /** 保活指定会话的宿主活动信号，返回释放函数。 */
  beginExecutionSession(sessionId: string): () => void
}

/**
 * 执行协作端口。
 *
 * 把托管执行者登记进宿主协作账本，收尾时通过句柄标记完成。
 */
export interface ExecutionCollaborationPort {
  registerActor(input: ExecutionCollaborationActorInput): ExecutionCollaborationActorHandle
}

/**
 * 子 Agent 引导 relay 规划器端口。
 *
 * 用户对运行中会话追加引导时，规划面向各活跃子 Agent 的改写 relay 与主控消息。
 * 产品宿主可注入使用辅助模型或确定性规则的 relay 规划器。
 */
export interface ExecutionGuidanceRelayPlanner {
  planRelay(input: ExecutionGuidanceRelayPlanInput): Promise<ExecutionGuidanceRelayPlan>
}

export interface SubAgentConfigPort {
  readonly systemConfig: AgentSystemRuntimeConfig
  readonly chatConfig: AgentChatRuntimeConfig
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

export interface ToolSkillsApi {
  listRoleSkills: () => AgentSkillDescriptor[]
  readRoleSkill: (skillId: string) => Nullable<ToolRoleSkillReadResult>
  isSkillSelected?: (skillId: string) => boolean
}

export interface AgentRunLifecycle<TContext> {
  /** Before capturing this turn's tool surface and compiling its request. */
  beforeTurn?(turn: AgentTurnBoundary<TContext>): void | Promise<void>
  /** History includes assistant/tool results; persistence is awaited before another request. */
  onTurnSettled?(turn: AgentTurnSettlement<TContext>):
    void | 'continue' | 'stop' | Promise<void | 'continue' | 'stop'>
}

/** Decisions run inside the shared retry loop, after mandatory replay-safety checks. */
export interface AgentModelRetryPolicy {
  onFailure(input: { error: unknown; attempt: number; abortSignal: AbortSignal }):
    Nullable<{ delayMs: number }> | Promise<Nullable<{ delayMs: number }>>
  /** Disable continuation when the product promises no recovery after visible output. */
  allowPartialContinuation?: boolean
}

export interface RetrievalPayloadStorePort {
  loadSessionPayloads(sessionId: string): Promise<ChatSessionPayloadSnapshot>
  loadToolPayload?(
    sessionId: string,
    key: string
  ): Promise<Nullable<ChatSessionToolResultPayload>>
}

/**
 * state 读端口：会话消息的按会话读取。
 *
 * 2026-08-06 evidence 流协议链下线：本端口曾多一格 `loadSessionContextSnapshot`，
 * 只为把宿主的 `session.runtime.evidenceLedger` 喂给索引构建。那条账本自始至终没有
 * 生产者（`evidenceExtractors` 两仓零注册），整链已随协议字段一并处决，端口回到
 * 「只读消息」的最小形状。
 */
export interface RetrievalStateStorePort {
  loadSessionMessages(sessionId: string): Promise<ChatMessage[]>
  loadSessionMessage(sessionId: string, index: number): Promise<Nullable<ChatMessage>>
}

/**
 * Product-owned surface collection.
 *
 * Runtime deliberately ships no registry, built-in profiles, or fallback surface.
 * A product resolves its own surface and maps feature ids to capability categories.
 */
export interface AgentSurfaceProfileProvider {
  resolve(input: ResolveAgentSurfaceInput): AgentSurfaceProfile
  deriveRunPolicy(input: DeriveSurfaceRunPolicyInput): DerivedAgentSurfaceRunPolicy
}

/** 事件汇（sink）端口。实现必须自行吞掉自己的 IO 失败——治理链路不因日志写失败而中断。 */
export interface ContextMigrationEventSink {
  recordMigration(event: ContextResidencyMigrationEvent): void
  recordFault(event: ContextFaultEvent): void
}

/**
 * OAuth provider 仍由产品实现和持久化。可选 authorizationUrl 只用于把 SDK 的 401
 * 归一化成可展示、可恢复的协议错误，不授予 Platform 发起授权交互或写入凭据的权限。
 */
export interface McpAuthorizationProvider extends OAuthClientProvider {
  readonly authorizationUrl?: LooseOptional<URL>
}

export interface RemoteHostServicePorts {
  /**
   * 工具面整批替换。
   *
   * 是 sink 而不是「拿 provider 再自己刷」:宿主的注册表形状(provider / 覆盖栈 / 类别门)
   * 属于宿主,本包不该认识它。宿主实现这一个方法即可,本包不持有任何宿主对象。
   */
  readonly publishTools: (entries: readonly RemoteHostToolEntry[]) => void
  readonly createCredentialStore: (hostId: string) => RemoteNodeCredentialStore
  readonly clientName: string
}

export interface ExecutionClock {
  now(): number
}

export interface ExecutionIdFactory {
  createExecutionId(): string
  createTaskId(): string
  createPlanStepId(): string
}

export interface KernelBackgroundJobOutputStore {
  append(input: {
    jobId: string
    sessionId: string
    parentSessionId?: string
    chunk: string
  }): void
  read(input: { jobId: string; offset: number }): Nullable<KernelBackgroundJobStoredOutput>
  readAll(input: { jobId: string }): Nullable<KernelBackgroundJobStoredOutput>
  dropJob(jobId: string): void
  dropSession(sessionId: string): void
}

export interface RuntimePromptFeaturePolicy {
  normalize(features: readonly ChatPromptFeatureId[]): ChatPromptFeatureId[]
  /** 宿主可按当前能力作用域收窄常驻协议；缺席时沿用全局归一。 */
  normalizeForScope?(
    features: readonly ChatPromptFeatureId[],
    scope: CapabilityScopeId
  ): ChatPromptFeatureId[]
  getLabel(feature: ChatPromptFeatureId): string
  /**
   * 内置协议也可以用 feature id 参与运行时装配，但不应被描述成用户“本轮已选”的能力。
   * 宿主不实现时保持历史行为：所有 feature 都按已选能力展示。
   */
  shouldDescribeAsSelected?(feature: ChatPromptFeatureId): boolean
  getCategoriesForFeatures(features: readonly ChatPromptFeatureId[]): ToolCategoryId[]
  getFeaturesForCategories(categories: readonly ToolCategoryId[]): ChatPromptFeatureId[]
  getRequiredFeatureForTool(
    toolName: string,
    categoryId?: LooseOptional<ToolCategoryId>
  ): Nullable<ChatPromptFeatureId>
  isOfficeFeature(feature: ChatPromptFeatureId): boolean
}

/**
 * 审批通道端口。
 *
 * 把「要不要问、问谁、答案是什么」抽象成一个通道：工具只管请求审批，
 * 具体如何征询（确认卡 / 策略自动放行 / 无通道时设计式拒绝）由宿主注入的实现决定。
 * 决策形状与风险分类复用现有确认机制（{@link ToolConfirmationDecisionOptions} /
 * {@link ApprovalDecision}），不引入平行的第二套风险模型。
 *
 * 两种征询形态对齐现有 execution 确认机制：{@link ApprovalPort.awaitConfirmation}
 * 被拒会抛出仅取消当前操作的错误，{@link ApprovalPort.awaitConfirmationDecision} 是非终止型
 * （被拒返回结构化决策）。二者都只表达「审批」，不承载计划/任务/用户输入等交互会话能力。
 */
export interface ApprovalPort {
  /**
   * 请求一次工具执行审批；被拒或无审批通道时**抛出**，由工具执行器记录跳过，任务继续。
   *
   * @param message 面向用户的确认文案。
   * @param abortSignal 取消信号；征询被中止时应视为拒绝。
   * @param options 风险分类与复用/手动确认策略（approvalRisk / riskScope / requireManualApproval 等）。
   */
  awaitConfirmation(
    message: string,
    abortSignal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ): Promise<void>
  /**
   * 请求一次工具执行审批，返回**结构化决策**（非终止型）。
   *
   * @returns approved 是否放行、message 拒绝原因或批注、autoApproved 是否策略自动放行。
   */
  awaitConfirmationDecision(
    message: string,
    abortSignal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ): Promise<ApprovalDecision>
}

/**
 * 交互会话端口，是审批端口 ApprovalPort 的姊妹件。
 *
 * 把执行会话的**非审批交互面**抽象成一个通道：工具只管读写当前会话的计划、任务、推荐动作、
 * 执行建议。这些状态来自持久化执行记录还是无会话宿主的显式降级，由宿主注入的实现决定。
 * 端口形状是执行交互面的结构化子集；拥有更宽执行服务的宿主可以直接满足，其他宿主使用
 * {@link defaultUnsupportedInteractionPort} 明确报告不支持。
 *
 * 与审批面正交：本端口只承载「会话读写」，不表达审批。等待用户输入与动作卡结果在本仓由审批端口
 * 的确认决策承载（提问卡 `ask_user` 即经此路），故不在此端口重复。
 */
export interface InteractionPort {
  /** 当前交互会话（execution）标识；无会话宿主为空串。 */
  executionId: string
  /** 读取当前会话可见的执行计划；无会话时返回空计划。 */
  getCurrentPlan: () => ExecutionTaskPlanStep[]
  /** 更新并返回当前会话可见的执行计划；无会话时为 no-op、返回空计划。 */
  updateCurrentPlan: (input: ToolExecutionPlanUpdate) => ExecutionTaskPlanStep[]
  /** 读取当前任务记录；无会话时返回 null。 */
  getCurrentTask: () => Nullable<ExecutionTaskRecord>
  /** 读取系统对下一步的推荐动作；无会话或无推荐时返回 null。 */
  getCurrentRecommendedAction: () => Nullable<ExecutionTaskRecommendedAction>
  /** 读取当前执行建议；无会话或无建议时返回 null。 */
  getCurrentExecutionAdvice: () => Nullable<ExecutionTaskExecutionAdvice>
}

export interface KernelToolOutputStore {
  project(
    input: ProjectKernelToolOutputInput
  ): ProjectKernelToolOutputResult | Promise<ProjectKernelToolOutputResult>
}

export interface ContextPayloadStore {
  findByHash(sessionId: string, hash: string): Promise<Nullable<ContextPayloadRecord>>
  findManyByHash?(
    sessionId: string,
    hashes: readonly string[]
  ): Promise<Map<string, ContextPayloadRecord>>
  put(record: ContextPayloadRecord): Promise<ContextPayloadRecord>
  putMany?(records: readonly ContextPayloadRecord[]): Promise<ContextPayloadRecord[]>
  listForSession(sessionId: string): Promise<ContextPayloadRecord[]>
  findUserTextByHash?(
    sessionId: string,
    hash: string
  ): Promise<Nullable<ContextUserTextRecord>>
  findUserTextsByHash?(
    sessionId: string,
    hashes: readonly string[]
  ): Promise<Map<string, ContextUserTextRecord>>
  putUserText?(record: ContextUserTextRecord): Promise<ContextUserTextRecord>
  putUserTextMany?(records: readonly ContextUserTextRecord[]): Promise<ContextUserTextRecord[]>
}

/**
 * Product-owned Agent runtime injected at composition time.
 *
 * The Kernel adapter deliberately treats execution input and output as opaque.
 * Agent session, prompt, tool, and capability semantics remain owned by
 * Agent 运行时及其宿主装配，而不是 Kernel 契约。
 *
 * Two-tier registration boundary: this adapter is tier one and never parses a
 * domain manifest. Hosts pass the Kernel pack listing to the tier-two Agent
 * loader through `assembleAgentMods` (see `mods/AgentModHostAssembly.ts`) and
 * inject the assembled runtime here, so the Kernel keeps seeing only the narrow
 * module descriptor.
 */
export interface AgentCapabilityRuntime {
  start?(signal: AbortSignal): void | Promise<void>
  execute(
    scope: LooseOptional<ScopeRef>,
    input: unknown,
    context: AgentCapabilityExecutionContext,
  ): unknown | Promise<unknown>
  health?(): KernelModuleHealth | Promise<KernelModuleHealth>
  suspend?(): void | Promise<void>
  dispose?(): void | Promise<void>
}

export interface CreateAgentKernelModuleOptions {
  /** Agent implementation assembled by a product host. */
  readonly runtime: AgentCapabilityRuntime
}

/** pack 读取端口：宿主实现 IO，主干只负责编排与判定。 */
export interface AgentModPackReader {
  /**
   * 读 pack 目录下的分节单文件 manifest（整份 `velaros.mod.json`，不是某一节）；
   * 不存在或读失败应抛错（拒载而非静默跳过）。取 agent 节是本主干的事。
   */
  readManifest(input: {
    packDirectory: string
    manifestFileName: string
    descriptor: AgentModPackDescriptorLike
  }): Promise<unknown> | unknown
  /**
   * 装载 pack 的运行态绑定（工具实体 / 钩子 handler 等）；纯数据 mod 可不实现。
   *
   * `manifest` 是**整份信封**（宿主装载代码时可能要用 `module` 节的寻址字段），不是 agent 节。
   */
  loadBindings?(input: {
    packDirectory: string
    manifest: unknown
    descriptor: AgentModPackDescriptorLike
  }): Promise<AgentModBindings | undefined> | AgentModBindings | undefined
}

export type AgentExecutionStackToolRegistry<TContext extends AgentExecutionStackToolContext> =
  SoloLoopToolRegistry<TContext> &
    QueryLoopToolRegistry<TContext> &
    TurnRunnerToolRegistry<TContext>

/** Product composition owns concrete roles, skills and category bindings. */
export interface AgentRoleDescriptorProvider {
  listRoles(context: AgentRoleDescriptorProviderContext): readonly AgentRoleDefinition[]
}

/**
 * 注入 runner 的可选 span 端口（`spanRecorder?`）。缺省 = 无观测（零付费）。
 *
 * runner（SoloLoop）每次执行 `beginRun` 得到一个 run scope；其余生产侧只经 scope 派生，不碰账本/recorder。
 */
export interface ExecutionSpanScopeFactory {
  beginRun(input: {
    runId: string
    sessionId: string
    rootInputId: Nullable<string>
    /** 子 Agent 身份/角色名（主 Agent 根 run 用 null）——令独立顶层 run 在同会话多 run 树里可辨识。 */
    agentName: Nullable<string>
    /** 派发来源（子 Agent 的父角色/派发链；主 Agent 根 run 用 null）。 */
    dispatchSource: Nullable<string>
  }): RunSpanScope
}

/** Product-owned Model collection implements catalog, auth, health and fallback. */
export interface TeamModelRoutingPort {
  resolve(request: TeamModelRouteRequest): TeamModelRouteResult
  /**
   * 列出与 `selection`（主模型的模型选择）同一厂商、可供子 Agent 使用的模型。
   * 主 Agent 经 `agent:dispatch.model` 指定模型时据此校验；返回 null 或不实现 = 宿主不提供目录
   * （例如自定义厂商接受任意模型 id），此时按原样透传。
   */
  listSelectableModels?(
    selection: unknown
  ): Nullable<readonly TeamSelectableModel[]> | Promise<Nullable<readonly TeamSelectableModel[]>>
  markSuccess?(providerId: string): void
  markFailure?(providerId: string, reason: string): void
  createRelaxedRoute?(
    route: TeamModelRouteResult,
    reason: string
  ): LooseOptional<TeamModelRouteResult>
}

export interface KernelSessionInputStore {
  admit(input: AdmitKernelSessionInput): KernelSessionInputStoreResult<KernelAdmittedInput>
  list(sessionId: string): KernelSessionInputStoreResult<KernelAdmittedInput[]>
  countPending(sessionId: string): KernelSessionInputStoreResult<number>
  promoteSteers(
    sessionId: string,
    options?: PromoteKernelInputOptions
  ): KernelSessionInputStoreResult<KernelAdmittedInput[]>
  promoteNextQueued(sessionId: string): KernelSessionInputStoreResult<Nullable<KernelAdmittedInput>>
  cancel(sessionId: string, inputId?: string): KernelSessionInputStoreResult<number>
  dropSession(sessionId: string): KernelSessionInputStoreResult<number>
}

export interface VelarModArchiveSignatureVerifier {
  readonly fileName?: string
  verify(input: {
    readonly signature: unknown
    readonly modId: string
    readonly version: string
    readonly entries: readonly VelarModArchiveEntry[]
  }): { readonly ok: true; readonly keyId: string } | { readonly ok: false; readonly reason: string }
}

/**
 * 智能体技能提供方接口。
 *
 * 实现方负责按当前运行状态生成可用的技能列表；上层 AgentSkillRepository
 * 会按角色聚合并按 priority + id 稳定排序，多个 provider 同 id 时后者覆盖。
 *
 * `listSkills` 收敛为 `readonly AgentSkillDefinition[]`：
 *  - 上层会做缓存（基于 `getVersion()` 失效），迭代器会破坏缓存语义；
 *  - 实现方原本返回 Array 也兼容，纯遍历调用方无需改动。
 */
export interface AgentSkillProvider {
  readonly id: string
  readonly kind: AgentSkillSourceKind
  readonly label: string
  listSkills(): readonly AgentSkillDefinition[]
  /** 读取已枚举的目录式技能资源；实现方必须再次校验相对路径是否属于该技能。 */
  readSkillResource?(skill: AgentSkillDefinition, resourcePath: string): Nullable<string>
  /**
   * 可选的版本号，repository 会用它判断是否需要重新加载技能集合。
   *
   * 返回 string 时必须随技能内容变化而变化（例如 hash 或 AgentSystemRuntimeConfig 引用），
   * 不实现则视为“总是变化”，repository 退回到每次都 reload 的旧行为。
   */
  getVersion?(): string
}

export interface AppRuntimeFacts {
  /** 应用版本号，如 "0.3.1"。 */
  appVersion: Nullable<string>
  /** 平台标识，如 "darwin" / "win32" / "linux"。 */
  platform: Nullable<string>
  /** CPU 架构，如 "arm64" / "x64"。 */
  arch?: LooseOptional<string>
  /** 操作系统版本，如 Darwin kernel release 或 Windows release。 */
  osRelease?: LooseOptional<string>
  /** 实际承载命令执行的 shell 路径。 */
  shell?: LooseOptional<string>
  /** 当前用户主目录。 */
  homeDir?: LooseOptional<string>
  /** userData 存储根目录（会话数据与本地索引等落盘位置的父目录）。 */
  userDataRoot: Nullable<string>
}

/**
 * Host-injected input lane for one Agent execution.
 *
 * `takeOrSeal` is the completion boundary: it either returns one already accepted FIFO input or
 * atomically closes the lane. Capability and product implementations remain outside Agent Runtime.
 */
export interface AgentRuntimeInputPort {
  take(): Nullable<ModelMessage> | Promise<Nullable<ModelMessage>>
  takeOrSeal(): AgentRuntimeInputResult | Promise<AgentRuntimeInputResult>
  /**
   * Observe newly accepted input while a provider turn is in flight.
   *
   * The listener is also invoked synchronously when input is already pending, closing the race
   * between the turn-start drain and provider request creation. Callers must dispose the listener
   * as soon as that provider turn settles; tool execution is a separate transaction boundary.
   */
  onInputAccepted(listener: () => void): () => void
}

/** Capability-owned post-processing stage for a completed tool call. */
export interface ToolResultMiddleware<TExecutionContext = unknown> {
  id: string
  priority?: number
  matches?(context: ToolResultMiddlewareContext<TExecutionContext>): boolean
  transform(
    context: ToolResultMiddlewareContext<TExecutionContext>
  ): Promise<ToolResultMiddlewareResult | void> | ToolResultMiddlewareResult | void
}

/** Capability-owned schema recovery guidance. */
export interface ToolValidationHintProvider {
  id: string
  priority?: number
  getRecovery(context: ToolValidationHintContext): ToolValidationRecovery | void
}

export interface CapabilityValidationInterpreter {
  id: string
  priority?: number
  matches(toolName: string): boolean
  collect(toolName: string, result: unknown): CapabilityValidationInterpretation | void
  fingerprint?(toolName: string, args: Readonly<Record<string, unknown>>): string | void
  isPassed?(toolName: string, result: unknown): boolean
  evidenceMatches?(cited: string, observed: string): boolean
}

/** Capability-owned prompt contribution. Snapshot shape is deliberately opaque to Kernel. */
export interface CapabilityPromptContributor {
  id: string
  priority?: number
  getSegments(snapshot: unknown): readonly PromptSegmentDefinition[]
}

export interface CapabilityContextCollector {
  id: string
  priority?: number
  collect(
    messages: readonly unknown[],
    context?: Readonly<Record<string, unknown>>
  ): Promise<unknown> | unknown
}

/** Product/capability-owned intent classification; Agent merges only generic signals. */
export interface CapabilityIntentClassifier {
  id: string
  priority?: number
  classify(
    text: string,
    context?: CapabilityIntentClassifierContext
  ): readonly CapabilityIntentSignal[]
}

/**
 * Declarative allocation metadata. The allocator interprets only generic categories,
 * operations, prerequisites, and delegation decisions.
 */
export interface ToolAllocationMetadata {
  baselineToolNames?: readonly string[]
  operationCategories?: Readonly<Record<string, readonly ToolCategoryId[]>>
  delegatedOperations?: Readonly<Record<string, ToolAllocationDelegation>>
  prerequisites?: readonly ToolAllocationPrerequisite[]
}

/**
 * Host-supplied scope policy.
 *
 * Kernel treats scope ids and fact ids as opaque. Product packages own all
 * Product-specific scope semantics.
 */
export interface CapabilityScopePolicy {
  resolveScopeId(facts: CapabilityScopeRuntimeFacts): CapabilityScopeId
  decideCategory(
    categoryId: ToolCategoryId,
    facts: CapabilityScopeRuntimeFacts
  ): CapabilityScopeCategoryDecision
  expandCategoryIds?(categoryIds: readonly ToolCategoryId[]): readonly ToolCategoryId[]
  getDefaultCategoryIds?(
    facts: CapabilityScopeRuntimeFacts,
    options?: Readonly<Record<string, unknown>>
  ): readonly ToolCategoryId[]
  getResidency?(facts: CapabilityScopeRuntimeFacts): CapabilityScopeResidency
}

export interface CapabilityDelegationPolicy {
  blockedToolNames?: readonly string[]
  blockedCategoryIds?: readonly ToolCategoryId[]
}

export interface AgentRuntimeCapabilityPorts {
  extensions?: readonly AgentRuntimeCapabilityExtension[]
  toolAliases?: Readonly<Record<string, string>>
  resultMiddlewares?: ReadonlyArray<ToolResultMiddleware<any>>
  validationHintProviders?: readonly ToolValidationHintProvider[]
  validationInterpreters?: readonly CapabilityValidationInterpreter[]
  promptContributors?: readonly CapabilityPromptContributor[]
  contextCollectors?: readonly CapabilityContextCollector[]
  intentClassifiers?: readonly CapabilityIntentClassifier[]
  allocation?: ToolAllocationMetadata
  scopePolicy?: CapabilityScopePolicy
  delegationPolicy?: CapabilityDelegationPolicy
  /** Runtime prerequisite facts supplied by the host for the current execution. */
  satisfiedAllocationPrerequisiteIds?: readonly string[]
}

/** Agent Runtime has no built-in worker taxonomy. Hosts inject a complete catalog. */
export interface SubAgentTypeProvider {
  readonly defaultTypeId: SubAgentTypeId
  listDescriptors(): readonly SubAgentTypeDescriptor[]
  getDescriptor(id: SubAgentTypeId): Nullable<SubAgentTypeDescriptor>
}

export interface AgentTurnCapabilitySnapshotSource<TRegistry> {
  captureTurnCapabilitySnapshot(): AgentTurnCapabilitySnapshot<TRegistry>
}
