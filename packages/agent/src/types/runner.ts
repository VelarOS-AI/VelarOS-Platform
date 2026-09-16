/** 角色合约：来自共享配置的 profile，加上后端运行所需 workflow 信息。 */
import type { ModelMessage } from 'ai'

import type { AgentChatRuntimeConfig, AgentExecutionConfig, AgentExecutionStackToolRegistry, AgentModelProvider, AgentModelResolverPort, AgentRuntimeCapabilityPorts,AgentRuntimeInputPort, AgentSurfaceProfileProvider, AgentSystemRuntimeConfig, CapabilityValidationInterpreter, ExecutionSpanScopeFactory, RunnerConfigService, RunnerExecutionEnvironmentPort, RunnerSubAgentDispatcher, RunnerToolContextBuilder, RunnerToolRegistry, RuntimePromptFeaturePolicy, RuntimeReminderProducer, ToolExecutionApi } from '../contract/requires.js'

import type { AgentContextPhase, AgentDeveloperContext, AgentRoleExpectedOutputKind, AgentRoleId, AgentRoleProfileConfig, AgentSkillDescriptor, AgentSurfaceId, AgentWorkflowAgentCall, AgentWorkflowAgentResult, AgentWorkflowDefinition, AgentWorkflowRunResult, AppLocale, CapabilityScopeId, ChatPromptFeatureId, ChatRuntimeEvent, ExecutionModeId, ExecutionTaskPlanStep, PermissionConfirmationMode, PromptSegmentTrace, ReasoningLevel, RunProfileDefinition, RunProfileId, RunProfileSelectionId, SessionLineageContext, SkippedPromptSegmentTrace, StreamTurnContextPayload,TaskApprovalRecord, ThinkingDepth, ToolAvailabilityScope, ToolCategoryId, ToolCategoryOverview, ToolExposureTier, ToolSurfaceProfileId, TurnContextAnchor, TurnContextDelta, WorkflowType } from './agent.js'
import type { SubAgentDispatchCatalog, SubAgentDispatchInput, SubAgentDispatchLimitsSnapshot } from './delegation.js'
import type { PromptSegmentStability, RuntimePromptSnapshot } from './guidance.js'
import type { PromptRegistryApi } from './guidance.js'
import type { AgentExecutionLimitOverrides, ExecuteQueryLoopArgs, ExecuteSoloModeStreamLoopArgs, QueryLoopApi, QueryLoopRoleEngine, QueryLoopSubAgentOptions, QueryLoopToolCategoryResolver, QueryLoopToolContext, ResolvedAgentModelRuntime, SoloAwaitPendingBackgroundJobs, SoloLoopToolContext, SoloModeStreamLoopResult, SoloStreamLoopApi } from './loop.js'
import type { AgentModSeamDispatcherApi } from './mods.js'
import type { ExecutionEventBusApi } from './records.js'
import type { ContextGovernanceSessionRegistryApi } from './residency.js'
import type { CodingSessionSnapshot, CodingSessionToolCategoryToolNames, CodingSessionToolContext } from './session.js'

/**
 * 主 Agent 角色画像的最小形状：一次解析出本轮角色、工具面与提示词特性。
 * 类实现在 impl/runner/PrimaryAgentProfile.ts。
 */

/** Runner 一次运行的配置：执行配置加上本轮的 surface 与后台任务钩子。 */
export interface AgentRunnerConfig extends AgentExecutionConfig {
  /** 本轮 surface 画像。 */
  surfaceProfile?: AgentSurfaceProfile
  /** 取一条待注入的回合上下文便签。 */
  consumeTurnContextNote?: () => Nullable<string>
  /** 等在飞的后台任务落地。 */
  awaitPendingBackgroundJobs?: SoloAwaitPendingBackgroundJobs
  /** 读一个后台任务的输出。 */
  readBackgroundJobOutput?: RunnerReadBackgroundJobOutput
  /** 等一批后台任务。 */
  waitBackgroundJobs?: RunnerWaitBackgroundJobs
  /** 取消一个后台任务。 */
  cancelBackgroundJob?: RunnerCancelBackgroundJob
}

export interface PrimaryAgentProfileApi {
  /** 按已知工具名与本轮开关解析出角色结论。 */
  resolve(options: {
    knownToolNames: string[]
    selectedSkillIds?: string[]
    promptFeatures?: readonly ChatPromptFeatureId[]
    activeCapabilityScope?: CapabilityScopeId
    /** 当前 surface 必须从模型和发现面移除的工具。 */
    hiddenToolNames?: readonly string[]
    /** 是否允许模型把复杂任务继续派发给子 Agent。 */
    allowSubAgents: boolean
  }): AgentRoleResolution
}

/**
 * Runner 的最小形状：宿主与执行栈看得到的那一面。
 * 类实现在 impl/runner/AgentRunner.ts。
 */
export interface AgentRunnerApi<TToolContext extends RunnerToolContext = RunnerToolContext> {
  /** 以 solo worker 身份跑一次模型循环，事件走传进来的总线。 */
  streamSoloWorker(messages: ModelMessage[], config: AgentRunnerConfig, events: ExecutionEventBusApi, options?: StreamSoloWorkerOptions): Promise<void>
  /** 列出某会话已登记的任务审批记录。 */
  getTaskApprovalRecords(sessionId: string): TaskApprovalRecord[]
  /** 撤销一条任务审批。 */
  revokeTaskApproval(sessionId: string, id: string): boolean
  /** 订阅任务审批变化；返回退订函数。 */
  subscribeTaskApprovals(listener: (sessionId: string) => void): () => void
  /** 清空某会话的任务审批记录。 */
  clearTaskApprovals(sessionId: string): void
  /** 以子 Agent 身份执行一次委派任务。 */
  query(task: string, parentCtx: TToolContext, opts?: RunnerSubAgentOptions): Promise<string>
}

export interface AgentRoleContract extends AgentRoleProfileConfig {
  /** 角色可承接的 workflow 类型。 */
  workflowTypes: WorkflowType[]
  /** 人类可读职责说明。 */
  responsibilities: string[]
  /** 角色默认期望产出类型。 */
  expectedOutputKind: AgentRoleExpectedOutputKind
}

/** 角色定义；builtIn 用于区分内置角色和未来扩展角色。 */
export interface AgentRoleDefinition extends AgentRoleContract {
  builtIn: boolean
}

/** 角色解析输入。 */
export interface ResolveAgentRoleOptions {
  /** 锁定角色，通常来自 team worker 或子 Agent。 */
  lockedRoleId?: LooseOptional<AgentRoleId>
  /** 已注册工具名，用于过滤角色声明中不存在的工具。 */
  knownToolNames: string[]
  /** 本次选择的技能 id。 */
  selectedSkillIds?: string[]
  /** 本次开启的 Prompt Feature。 */
  promptFeatures?: readonly ChatPromptFeatureId[]
  /** 当前由宿主声明的能力作用域。 */
  activeCapabilityScope?: CapabilityScopeId
}

/** 角色解析结果，供 prompt、tool context 和 execution debug 共享。 */
export interface AgentRoleResolution {
  id: AgentRoleId
  label: string
  description: string
  workflowType: WorkflowType
  skillMarkdown: string
  skillDescriptors: AgentSkillDescriptor[]
  activeCapabilityScope?: CapabilityScopeId
  enabledToolCategories: ToolCategoryId[]
  allowedTools: string[]
  /** 显式选中技能声明的工具门控并集；null = 本轮无技能门控。 */
  selectedSkillAllowedTools: Nullable<string[]>
  usesCapabilityContext: boolean
  nextAllowedRoles: AgentRoleId[]
  routeNote: string
  contract: AgentRoleContract
}

export type RunnerAgentProvider = AgentModelProvider

export type RunnerResolvedAgentRuntime = ResolvedAgentModelRuntime

export type RunnerModelCapabilityPort = AgentModelResolverPort

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

export type RunnerSubAgentOptions = QueryLoopSubAgentOptions<ExecutionEventBusApi>

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
    agentSurfaceId?: LooseOptional<AgentSurfaceId>
    developerContext?: LooseOptional<AgentDeveloperContext>
    sessionLineage?: LooseOptional<SessionLineageContext>
    execution?: LooseOptional<ToolExecutionApi>
    codingSession: RunnerContextCodingSession
    readBackgroundJobOutput?: RunnerReadBackgroundJobOutput
    waitBackgroundJobs?: RunnerWaitBackgroundJobs
    cancelBackgroundJob?: RunnerCancelBackgroundJob
  }

export interface RunnerBuildToolContextArgs {
  abortController: AbortController
  config: Partial<AgentExecutionConfig>
  codingSession: object
  roleState: {
    getAllowedToolNames: () => string[]
    getEnabledToolCategories: () => ToolCategoryId[]
    getResolution: () => ReturnType<PrimaryAgentProfileApi['resolve']>
  }
  disabledToolNames: string[]
  capabilityPorts?: AgentRuntimeCapabilityPorts
  resourceId?: LooseOptional<string>
  execution?: LooseOptional<ToolExecutionApi>
  events?: ExecutionEventBusApi
  query(task: string, opts?: RunnerSubAgentOptions): Promise<string>
  dispatchSubAgent?(input: SubAgentDispatchInput): Promise<string>
  getSubAgentDispatchCatalog?: () => SubAgentDispatchCatalog
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
  promptFeatures?: ChatPromptFeatureId[]
  /**
   * 执行模式轴（权威）。缺席时读取方按 {@link resolveExecutionModes} 从旧形态
   * （`promptFeatures` 里的模式 id / `goalMode` 布尔）折算，存量宿主路径因此零改动可用。
   */
  executionModes?: ExecutionModeId[]
  /** @deprecated 目标模式已并入 `executionModes`；保留为旧宿主入口，读取一律经 `resolveExecutionModes`。 */
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

export interface AgentRunnerComponents<TToolContext extends RunnerToolContext> {
  contextHelper: RunnerToolContextBuilder<TToolContext>
  primaryAgentStreamLoop: SoloStreamLoopApi<TToolContext, ExecutionEventBusApi>
  queryLoop: QueryLoopApi<TToolContext, ExecutionEventBusApi>
  primaryAgentProfile: PrimaryAgentProfileApi
  subAgentDispatcher: RunnerSubAgentDispatcher<TToolContext>
}

export interface AgentRunnerDomainServices {
  executionEnvironment?: RunnerExecutionEnvironmentPort
}

export interface AgentRunnerInfrastructure {
  capabilityPorts?: AgentRuntimeCapabilityPorts
  executionLimitOverrides?: AgentExecutionLimitOverrides
  configService: RunnerConfigService
  toolRegistry: RunnerToolRegistry
  codingSessionPolicy: RunnerCodingSessionPolicyBundle
  surfaceProfileProvider: AgentSurfaceProfileProvider
}

/**
 * 提示词构建面投影声明。
 *
 * `snapshotFlag` 是本模式在 `RuntimePromptSnapshot` 上驱动提示词段（段 `when()` 判定）的
 * 布尔标志名——登记「哪个标志属于哪个模式」的单源。
 *
 * `legacyPromptFeatureId` 是**拆轴前**用来激活本模式的提示词特性 id：模式曾与插件能力挤在
 * 同一根 `promptFeatures` 数组里（goal 走布尔、plan 走特性 id，两档形态还不一样）。拆轴后
 * 权威源是 `executionModes`，这个 id 只剩一个用途——把存量会话 / 旧宿主请求里粘着的旧形态
 * 折算回模式轴（{@link resolveExecutionModes}），并从能力轴上剥掉。goal 从来没有特性 id，为 null。
 */
export interface ExecutionModePromptProjection {
  snapshotFlag: 'goalMode' | 'userRequestedPlan'
  legacyPromptFeatureId: Nullable<ChatPromptFeatureId>
}

/** 会话粘性声明：选中后是否跨回合 / 跨 hook send 会话级粘滞。 */
export interface ExecutionModeStickiness {
  sessionSticky: boolean
}

/**
 * 执行模式描述符——一个模式的声明式单源。
 *
 * 消费点（提示词构建 / 粘性）经注册表解析本描述符，不再各自硬编码 `if (planningMode)`
 * 与散装特性 id 判定。
 */
export interface ExecutionModeDescriptor {
  id: ExecutionModeId
  label: string
  prompt: ExecutionModePromptProjection
  stickiness: ExecutionModeStickiness
}

/**
 * 运行上下文读取的代码会话子面。
 *
 * 叠在提示词构建器约束的 {@link PromptStateCodingSession} 之上，补齐轮次载荷所需的
 * active 工具类别读取。产品宿主可以用结构上更宽的会话 API 满足此端口。
 */
export interface RunContextCodingSession extends PromptStateCodingSession {
  getActiveToolCategories(): ToolCategoryId[]
}

/**
 * 运行上下文装配流经的工具上下文端口。
 *
 * 结构上是产品宿主 ToolContext 的**装配实际读取/透传子集**，叠在提示词构建器的
 * {@link PromptStateToolContext} 约束之上（`execution` 由非空交互会话端口 `interaction`
 * 派生，故此处放宽为交互面 + 补齐轮次载荷读取的 `listTools`）。
 * 更宽的宿主 ToolContext 可以结构化满足此类型。
 */
export type RunContextToolContext = Omit<
  PromptStateToolContext,
  'codingSession' | 'execution'
> & {
  codingSession: RunContextCodingSession
  interaction: PromptStateExecutionApi
  dispatchSubAgent?: LooseOptional<unknown>
  listTools(): ReadonlyArray<{ name: string }>
}

/** Host persistence and product policy at the existing turn boundaries. */
export interface AgentTurnBoundary<TContext> {
  turn: number
  history: ModelMessage[]
  toolContext: TContext
  abortSignal: AbortSignal
}

export interface AgentTurnSettlement<TContext> extends AgentTurnBoundary<TContext> {
  result: {
    hasToolUse: boolean
    inputTokens?: LooseOptional<number>
    outputTokens?: LooseOptional<number>
    costUsd?: LooseOptional<number>
    finishReason?: LooseOptional<string>
  }
}

export interface AgentSurfaceToolPolicy {
  baseCategories: readonly ToolCategoryId[]
  allowedCategories?: readonly ToolCategoryId[]
  includePromptFeatureCategories: boolean
  restoreApprovedCategories: boolean
  allowRuntimeScopeSwitching?: boolean
  hiddenToolNames?: readonly string[]
}

export interface AgentSurfaceProfile {
  id: AgentSurfaceId
  toolPolicy: AgentSurfaceToolPolicy
  allowSubAgents: boolean
}

export interface ResolveAgentSurfaceInput {
  agentSurfaceId?: LooseOptional<AgentSurfaceId>
  developerContext?: LooseOptional<AgentDeveloperContext>
}

export interface DeriveSurfaceRunPolicyInput {
  profile: AgentSurfaceProfile
  declaredScope?: LooseOptional<CapabilityScopeId>
  promptFeatures: readonly ChatPromptFeatureId[]
  previousApprovedCategories: readonly ToolCategoryId[]
}

export interface DerivedAgentSurfaceRunPolicy {
  activeSpace: CapabilityScopeId
  initialToolCategories: ToolCategoryId[]
  initialActiveToolCategories: ToolCategoryId[]
  initialPromptFeatures: ChatPromptFeatureId[]
  restoredApprovedCategories: ToolCategoryId[]
  allowedToolCategories?: ToolCategoryId[]
  allowSubAgents: boolean
}

/** 默认执行栈真正读取的工具与提示词端口；产品可以结构化提供更宽的上下文。 */
export type AgentExecutionStackToolContext = RunnerToolContext & RunContextToolContext

export interface AgentExecutionStackOptions<TContext extends AgentExecutionStackToolContext> {
  model: AgentModelResolverPort
  toolRegistry: AgentExecutionStackToolRegistry<TContext>
  /** 共享宿主会话生命周期时注入；缺省为此栈独占登记处。 */
  governanceSessions?: ContextGovernanceSessionRegistryApi
  promptRegistry?: PromptRegistryApi
  promptFeaturePolicy?: RuntimePromptFeaturePolicy
  listCustomSubAgents?: () => Array<{ id: string; description: string; base: string }>
  spanScopeFactory?: LooseOptional<ExecutionSpanScopeFactory>
  executionLimitOverrides?: AgentExecutionLimitOverrides
  seams?: LooseOptional<AgentModSeamDispatcherApi>
  /** 只运行 Solo 的宿主省略此项；不会创建 QueryLoopApi 或默认启用子 Agent。 */
  query?: {
    roleEngine: QueryLoopRoleEngine
    getToolNamesForCategories: QueryLoopToolCategoryResolver
  }
}

export interface AgentExecutionStackRunnerOptions<
  TContext extends AgentExecutionStackToolContext,
> extends Omit<
  AgentRunnerInfrastructure,
  'toolRegistry' | 'executionLimitOverrides' | 'codingSessionPolicy'
> {
  contextHelper: RunnerToolContextBuilder<TContext>
  primaryAgentProfile: PrimaryAgentProfileApi
  subAgentDispatcher: RunnerSubAgentDispatcher<TContext> & {
    bindAgentRunner(runner: Pick<AgentRunnerApi<TContext>, 'query'>): void
  }
  executionEnvironment?: RunnerExecutionEnvironmentPort
  /** 提示词策略取自栈配置，避免两个执行面或 Runner 各持一份。 */
  codingSessionPolicy: Omit<RunnerCodingSessionPolicyBundle, 'promptFeaturePolicy'>
}

export interface AgentExecutionStack<TContext extends AgentExecutionStackToolContext> {
  readonly promptRegistry: PromptRegistryApi
  readonly governanceSessions: ContextGovernanceSessionRegistryApi
  executeSolo(
    args: ExecuteSoloModeStreamLoopArgs<TContext, ExecutionEventBusApi>
  ): Promise<SoloModeStreamLoopResult>
  /** 删除/替换宿主会话时调用，释放本栈的会话状态及治理账本。 */
  clearSession(sessionId: string): void
}

export interface AgentExecutionStackWithQuery<
  TContext extends AgentExecutionStackToolContext,
> extends AgentExecutionStack<TContext> {
  executeQuery(args: ExecuteQueryLoopArgs<TContext, ExecutionEventBusApi>): Promise<string>
  createRunner(options: AgentExecutionStackRunnerOptions<TContext>): AgentRunnerApi<TContext>
}

export interface PromptStateRoleResolution {
  id: AgentRoleId
  label: string
  workflowType: WorkflowType
  allowedTools: string[]
  skillDescriptors?: AgentSkillDescriptor[]
}

export interface PromptStateCodingSession {
  getEnabledPromptFeatures: () => ChatPromptFeatureId[]
  getActiveCapabilityScope(): CapabilityScopeId
  getToolSurfaceProfile: () => ToolSurfaceProfileId
  getRunProfile: () => Nullable<RunProfileSelectionId>
}

export interface PromptStateExecutionApi {
  getCurrentPlan(): ExecutionTaskPlanStep[]
  getCurrentExecutionAdvice(): Nullable<{ mode: string; title: string }>
}

export interface PromptStateSkillsApi {
  listRoleSkills(): AgentSkillDescriptor[]
}

export interface PromptStateToolContext {
  locale: RuntimePromptSnapshot['locale']
  sessionId?: string
  developerContext?: LooseOptional<AgentDeveloperContext>
  agentSurfaceId?: LooseOptional<AgentSurfaceId>
  capabilityPorts?: AgentRuntimeCapabilityPorts
  codingSession: PromptStateCodingSession
  skills?: PromptStateSkillsApi
  execution: PromptStateExecutionApi
  listToolCategories(scope: ToolAvailabilityScope): ToolCategoryOverview[]
  canDispatchSubAgents?: boolean
  getSubAgentDispatchCatalog?: () => SubAgentDispatchCatalog
}

export interface BuildRuntimePromptStateArgs {
  toolContext: PromptStateToolContext
  roleResolution: PromptStateRoleResolution
  messages: ModelMessage[]
  selectedPromptFeatures?: ChatPromptFeatureId[]
  preparedToolCategories?: PromptStatePreparedToolCategories
  /** 执行模式轴；缺席时由旧形态（selectedPromptFeatures 里的模式 id / goalMode）折算。 */
  executionModes?: readonly ExecutionModeId[]
  goalMode?: boolean
  thinkingDepth?: LooseOptional<ThinkingDepth>
  runProfile?: LooseOptional<RunProfileId>
  contextPhase?: AgentContextPhase
}

export interface PromptStatePreparedToolCategories {
  enabled: ToolCategoryOverview[]
  all: ToolCategoryOverview[]
}

export interface HtmlArtifactPromptTurnInput {
  selectedPromptFeatureSet: ReadonlySet<ChatPromptFeatureId>
  messages: ModelMessage[]
  workflowType: WorkflowType
}

export interface StreamSoloWorkerOptions {
  consumeGuidance?: () => Nullable<ModelMessage>
  runtimeInput?: AgentRuntimeInputPort
}

export interface BuildSystemPromptArgs<TContext extends RunContextToolContext> {
  /** 聊天模型配置。 */
  chatConfig: AgentChatRuntimeConfig
  /** 系统配置。 */
  systemConfig: AgentSystemRuntimeConfig
  /** 当前消息历史。 */
  messages: ModelMessage[]
  /** 已解析角色。 */
  roleResolution: AgentRoleResolution
  /** 工具上下文。 */
  toolContext: TContext
  /** 可选身份覆盖，常用于子智能体。 */
  identity?: string
  /** 代码上下文信号。 */
  capabilityContext?: unknown
  /** 用户选择的提示词特性（能力轴）。 */
  promptFeatures?: ChatPromptFeatureId[]
  preparedToolCategories?: PromptStatePreparedToolCategories
  /** 执行模式轴；缺席时读取点从旧形态折算。 */
  executionModes?: readonly ExecutionModeId[]
  goalMode?: boolean
  /** 本次请求使用的运行策略。 */
  thinkingDepth?: LooseOptional<AgentSystemRuntimeConfig['thinkingDepth']>
  runProfile?: LooseOptional<RunProfileId>
  promptBudget?: LooseOptional<{
    profile: RunProfileId
    maxChars: number
  }>
}

/** 系统提示词装配结果（常规/子智能体与主 Agent 两条入口共用的返回形状）。 */
export interface AssembledSystemPrompt {
  systemPrompt: string
  devEnvironmentContext: Nullable<string>
  stableCutoff: number
  promptSegments: PromptSegmentTrace[]
  skippedPromptSegments: SkippedPromptSegmentTrace[]
}

export interface AgentRoleToolCategoryResolver {
  getToolCategoryId(toolName: string): ToolCategoryId
}

export interface AgentRoleToolBindings {
  getToolCategoryId: (toolName: string) => ToolCategoryId
  getToolNamesForCategories: (categories: ToolCategoryId[]) => string[]
  conversationToolNames: readonly string[]
}

export interface AgentRoleDescriptorProviderContext {
  selectedSkillIds: readonly string[]
  promptFeatures: readonly ChatPromptFeatureId[]
  capabilityScope?: CapabilityScopeId
}

export interface BuiltContext {
  /** 组装好的完整 system prompt */
  systemPrompt: string
  /**
   * stable 段的结束索引（在 systemPrompt 中）
   * 可用于向 LLM SDK 提示 cache 边界（未来接入 Anthropic cache_control 时用）
   */
  stableCutoff: number
  /** 参与本轮装配的 prompt 段，供 debug 和后续可视化使用 */
  segments: Array<{
    id: string
    label?: string
    stability: PromptSegmentStability
    source: string
    priority: number
    retention: 'normal' | 'protected'
    text: string
  }>
  skippedSegments: Array<{
    id: string
    label?: string
    stability: PromptSegmentStability
    source: string
    priority: number
    reason: string
  }>
  promptBudget: Nullable<{
    profile: string
    maxChars: number
    charsBefore: number
    charsAfter: number
    trimmedSegmentCount: number
  }>
}

export interface AgentWorkflowDispatchContext {
  stepId: string
  call: AgentWorkflowAgentCall
  input?: unknown
  itemIndex?: number
  round?: number
}

export interface AgentWorkflowDispatchPort {
  dispatch: (context: AgentWorkflowDispatchContext) => Promise<AgentWorkflowAgentResult>
  /**
   * 本次 run 的真实派发配额（派发器信号量上限 + 该执行剩余的总量帽）。
   *
   * 在 `run` 开始时取一次快照即可：并发上限是那把闸的属性、总量帽剩余只会因本 workflow 自己
   * 的派发而减少，而那部分由 `maxAgents` 同步扣减。**本文件不自己发明这两个数。**
   */
  limits: SubAgentDispatchLimitsSnapshot
}

export interface AgentWorkflowRunOptions {
  runId: string
  abortSignal?: AbortSignal
}

export interface AgentWorkflowRunRequest<TToolContext extends RunnerToolContext> {
  input: AgentWorkflowDefinition
  parentCtx: TToolContext
  events: ExecutionEventBusApi
  config: AgentExecutionConfig
}

export interface TypedEnumAsserts<T extends string> {
  values: readonly T[]
  is: (value: unknown) => value is T
  assert: (value: unknown, field?: string) => T
  parseOptional: (value: unknown, field?: string) => T | undefined
  resolve: (value: unknown, fallback: T, field?: string) => T
}

export interface AgentRunProfileCatalogSnapshot {
  readonly schemaVersion: 1
  readonly defaultSelection: RunProfileSelectionId
  readonly automaticSelection: {
    readonly unknownContextWindowFallback: number
    readonly balancedAtOrAbove: number
    readonly expandedAtOrAbove: number
  }
  readonly profiles: readonly RunProfileDefinition[]
}

export interface TurnContextBlockInput {
  /** 空数组表示本次不重发 anchors。顺序由 fan-in 定死（sourceId,key），不得重排。 */
  anchors: readonly TurnContextAnchor[]
  overflowNotes: readonly string[]
  /** 已过滤 dismissed、已确定性排序；不得重排。 */
  deltas: readonly TurnContextDelta[]
}

export interface ResolvedToolExposure {
  tier: ToolExposureTier
  rank: number
  rankBoost: number
  alwaysResident: boolean
}

export type AgentRuntimeInputResult =
  | { status: 'input'; message: ModelMessage }
  | { status: 'sealed' }

export interface AgentRuntimeInputInterruptScope {
  signal: AbortSignal
  dispose(): void
}

export interface AgentRuntimeEventBus {
  emitRuntime(event: ChatRuntimeEvent): void
}

export interface RoutedAgentRoleResult {
  /** 选中的角色定义。 */
  role: AgentRoleDefinition
  /** 选择原因，写入调试信息。 */
  routeNote: string
  /** 角色主 workflow。 */
  workflowType: WorkflowType
}

export type GoalLifecycleStatus = 'active' | 'paused' | 'complete' | 'blocked' | 'cancelled' | 'removed'

export type GoalLifecycleAction = 'resume' | 'pause' | 'block' | 'complete' | 'cancel' | 'remove'

export type GoalDockTone = 'active' | 'paused' | 'blocked' | 'complete' | 'cancelled'

export type GoalDockPrimaryAction = 'pause' | 'continue'

export type GoalDockAction = GoalDockPrimaryAction | 'remove'

export interface GoalDockViewModel {
  id: string
  objective: string
  status: GoalLifecycleStatus
  tone: GoalDockTone
  primaryAction: GoalDockPrimaryAction
  actions: readonly GoalDockAction[]
  blockedAuditTurns: number
  updatedAt: number
}

export interface BuildTurnContextPayloadArgs {
  turn: number
  roleResolution: AgentRoleResolution
  roleRuntimeModel: StreamTurnContextPayload['roleRuntimeModel']
  systemPrompt: string
  devEnvironmentContext: Nullable<string>
  stableCutoff: number
  promptSegments: PromptSegmentTrace[]
  skippedPromptSegments: SkippedPromptSegmentTrace[]
  history: ModelMessage[]
  toolContext: RunContextToolContext
  allowedTools?: string[]
  toolSchemaTelemetry?: StreamTurnContextPayload['toolSchemaTelemetry']
  runProfileTelemetry?: StreamTurnContextPayload['runProfileTelemetry']
  toolAllocatorTelemetry?: StreamTurnContextPayload['toolAllocatorTelemetry']
  turnPlanningTelemetry?: StreamTurnContextPayload['turnPlanningTelemetry']
  contextPhaseTelemetry: StreamTurnContextPayload['contextPhaseTelemetry']
}
