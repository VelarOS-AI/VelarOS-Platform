import type { ModelMessage } from 'ai'

import type { AgentEvent, AgentRoleExpectedOutputKind, AgentRoleId, AgentTurnRouteIdentity,CapabilityScopeId, ChatRuntimeEvent, ExecutionEventRecord, ExecutionRecord, ExecutionTaskPlanStep, ExecutionTaskPlanStepStatus, ExecutionTaskRecord, StreamAssistantGeneratedFilePayload, StreamAssistantRawPayload, StreamAssistantSourcePayload, StreamExecutionGraphPayload, StreamReasoningPayload, StreamStatePayload, StreamToolCallPayload, StreamToolMetadataPayload, StreamToolProgressPayload, StreamToolResultPayload, StreamTurnContextPayload, StreamWorkerThreadPayload, TurnContextSourceId, TurnContextSourcePeekInput, TurnContextSourcePeekResult, WorkflowType } from './agent.js'

/**
 * 执行事件总线的最小形状：一次 run 里所有"往 UI 发事件"的出口。
 * 类实现在 impl/records/ExecutionEventBus.ts，这里只登记调用方看得到的那一面。
 */
export interface ExecutionEventBusApi {
  /** 在 agent 事件转发前插入旁路监听，ExecutionService 用它写入事件账本。 */
  withAgentTap(tap: (event: AgentEvent) => void): ExecutionEventBusApi
  /** 给团队 worker 内部模型循环使用的静默总线；options 缺席时只保留 contextInvalidated 上浮。 */
  forWorkerExecution(options?: WorkerExecutionStreamOptions): ExecutionEventBusApi
  /** 发送原始 agent 事件。 */
  emitAgent(event: AgentEvent): void
  /** 发送 runtime 级事件，如 done/error/aborted。 */
  emitRuntime(payload: ChatRuntimeEvent): void
  /** 发送助手文本增量。 */
  emitTextDelta(text: string): void
  /** 发送 reasoning 增量，供支持的 UI 展示思考流。 */
  emitReasoningDelta(payload: StreamReasoningPayload): void
  /** 发送模型生成的文件；renderer 统一负责展示与持久化。 */
  emitGeneratedFile(payload: StreamAssistantGeneratedFilePayload): void
  /** 发送模型实际使用的 URL 来源。 */
  emitSource(payload: StreamAssistantSourcePayload): void
  /** 发送当前轮角色/上下文信息，ExecutionService 会据此更新任务角色。 */
  emitTurnContext(payload: StreamTurnContextPayload): void
  /** 发送模型原始片段，主要用于调试和回放。 */
  emitAssistantRaw(payload: StreamAssistantRawPayload): void
  /** 发送团队 worker 线程生命周期事件，供主聊天页显示并行执行过程。 */
  emitWorkerThread(payload: StreamWorkerThreadPayload): void
  /** 工具开始执行时发给 UI，展示 tool call block。 */
  emitToolStart(payload: StreamToolCallPayload): void
  /** 工具执行期间的增量进度。 */
  emitToolProgress(payload: StreamToolProgressPayload): void
  /** 工具执行期间的结构化展示元数据。 */
  emitToolMetadata(payload: StreamToolMetadataPayload): void
  /** 工具执行完成或失败时发给 UI。 */
  emitToolDone(payload: StreamToolResultPayload): void
  /** 向 UI 推送独立 notice 事件，不嵌进工具结果。 */
  emitNotice(event: Extract<AgentEvent, { type: 'notice' }>): void
  /** 发送执行阶段/等待输入等状态。 */
  emitState(payload: StreamStatePayload): void
  /** 发送执行图调试快照。 */
  emitDebug(payload: StreamExecutionGraphPayload): void
}

/**
 * 回合事件归约器的最小形状：只列出账本与诊断函数真会用到的那几步。
 * 类实现在 impl/records/ProviderTurnEventReducer.ts。
 */
export interface ProviderTurnRecorder {
  /** 吃进一条 provider 回合事件。 */
  apply(event: ProviderTurnEvent): void
  /** 收束本回合并给出快照。 */
  complete(): ProviderTurnSnapshot
  /** 仍在等待结果的工具调用 id。 */
  pendingToolCallIds(): string[]
  /** 本回合是否已经开始（收到过任一事件）。 */
  hasStarted(): boolean
  /** 本回合是否攒下了诊断。 */
  hasDiagnostics(): boolean
  /** 把在途工具按"被打断"收束并给出快照。 */
  completeWithInterruptedPendingTools(error?: string): ProviderTurnSnapshot
  /** 当前快照（不收束）。 */
  snapshot(): ProviderTurnSnapshot
}

export interface ResolvedTaskRoute {
  workflowType: Nullable<WorkflowType>
  expectedOutput: Nullable<AgentRoleExpectedOutputKind>
  suggestedNextRoles: AgentRoleId[]
  executionPlan: ExecutionTaskPlanStep[]
}

export type AppendExecutionEventInput = Omit<
  ExecutionEventRecord,
  'id' | 'executionId' | 'timestamp'
> & {
  /** 允许调用方传入事件时间；不传则使用 store.now()。 */
  timestamp?: number
}

export interface ExecutionTaskLedgerStore {
  require(executionId: string): ExecutionRecord
  updateTask(
    executionId: string,
    taskId: string,
    updater: (task: ExecutionTaskRecord) => ExecutionTaskRecord
  ): ExecutionRecord
  appendEvent(executionId: string, input: AppendExecutionEventInput): ExecutionEventRecord
  emitDebug(executionId: string): void
}

export interface ExecutionAgentEventLedgerStore {
  get(executionId: string): Nullable<ExecutionRecord>
  require(executionId: string): ExecutionRecord
  appendEvent(executionId: string, input: AppendExecutionEventInput): ExecutionEventRecord
}

/**
 * 环境信号源统一契约。
 *
 * 实现约束（护栏，靠单测证明）：
 * - peekCached 同步返回、纯内存，禁止任何 IO / 系统调用 / 模型调用；
 * - 构造函数只接收已有 Store/Cache，不接收具体能力运行时。
 */
export interface TurnContextDeltaSource {
  id: TurnContextSourceId
  scopes: readonly CapabilityScopeId[]
  /** 为 false 时只参与模型 mid-run 投递，不进入 renderer 的 composer chip 快照。 */
  rendererVisible?: boolean
  peekCached(input: TurnContextSourcePeekInput): TurnContextSourcePeekResult
}

export interface WorkerExecutionStreamOptions {
  threadId: string
  activationId?: LooseOptional<string>
  taskId?: LooseOptional<string>
  nodeId?: LooseOptional<string>
  title: string
  agentName?: LooseOptional<string>
  roleId?: LooseOptional<StreamWorkerThreadPayload['roleId']>
  phase?: LooseOptional<StreamWorkerThreadPayload['phase']>
  capabilityTarget?: LooseOptional<StreamWorkerThreadPayload['capabilityTarget']>
  dag?: LooseOptional<StreamWorkerThreadPayload['dag']>
}

/** worker 线程事件里随事件类型变化的那几个字段；其余字段全部由线程身份信封给定。 */
export type WorkerThreadProjection = Pick<StreamWorkerThreadPayload, 'event'> &
  Partial<Pick<StreamWorkerThreadPayload, 'timestamp' | 'text' | 'summary' | 'chatEvent'>>

export interface SubAgentGuidanceRelayWorkerSnapshot {
  threadId: string
  title: string
  description: Nullable<string>
  prompt: string
  agentName: string
  subagentType: string
}

export interface SubAgentGuidanceRelayWorkerHandle {
  consumeRelayedGuidance: () => Nullable<string>
  enqueueRelayedGuidance: (message: string) => void
  abortSignal: AbortSignal
  abort: (reason?: string) => void
}

export interface RegisterSubAgentGuidanceRelayWorkerInput extends SubAgentGuidanceRelayWorkerSnapshot {
  executionId: string
}

export interface ActiveSubAgentGuidanceRelayWorker extends SubAgentGuidanceRelayWorkerSnapshot {
  relayQueue: string[]
  abortController: AbortController
}

export interface ActiveSourceSessionExecution {
  /** 当前活跃 execution id。 */
  executionId: string
  /** 同一 session 每次 start 都递增，用于 finally 防串扰。 */
  generation: number
  /** 当前执行的取消控制器。 */
  abortController: AbortController
}

export interface StartSourceSessionExecutionResult {
  /** 新执行的取消控制器。 */
  abortController: AbortController
  /** 新执行的 generation。 */
  generation: number
  /** 被取代的旧 execution id。 */
  supersededExecutionId: Nullable<string>
}

export type ProviderTurnStatus = 'pending' | 'completed'

export type ProviderTurnToolStatus = 'pending' | 'succeeded' | 'failed'

export interface ProviderTurnUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

/**
 * Ring 0 出核请求指纹（`assertProviderRequestInvariants` 同层地板产物）。
 * 定义住 kernel 层:请求事件/快照与观测域都以它为契约,agent 层编译器只是生产者。
 */
export interface ProviderRequestFingerprint {
  id: string
  systemHash: string
  toolSurfaceHash: string
  prefixHash: string
  /** 最终 provider-visible messages 的规范内容哈希；角色序列相同不再被误判成同一请求。 */
  messageHash: string
  toolSchemaCharsTotal: number
  messageCount: number
  roleSequence: string[]
  availableToolNames: string[]
  historyToolNames: string[]
  missingHistoryToolNames: string[]
  toolChoiceName: Nullable<string>
  toolChoiceVisible: Nullable<boolean>
  contextRefCount: number
  historyToolCallIds: string[]
  historyToolResultIds: string[]
}

export interface ProviderTurnRequestSnapshot {
  availableToolNames: string[]
  toolChoiceName: Nullable<string>
  requestFingerprint?: ProviderRequestFingerprint
  toolSchemaChars?: Record<string, number>
  toolSchemaHashes?: Record<string, string>
  contextUsage?: {
    estimatedTokens: number
    tokenPercent: number
    usableContextWindow: number
  }
}

export type ProviderTurnEvent =
  | { type: 'turn-started' }
  | {
      type: 'request'
      availableToolNames: string[]
      toolChoiceName?: LooseOptional<string>
      requestFingerprint?: ProviderRequestFingerprint
      toolSchemaChars?: Record<string, number>
      toolSchemaHashes?: Record<string, string>
      contextUsage?: ProviderTurnRequestSnapshot['contextUsage']
    }
  | { type: 'assistant-text-delta'; text: string }
  | { type: 'assistant-reasoning-delta'; text: string }
  | { type: 'tool-started'; toolCallId: string; toolName: string; args?: unknown }
  | { type: 'tool-succeeded'; toolCallId: string; output: unknown }
  | { type: 'tool-failed'; toolCallId: string; error: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; totalTokens?: number }
  | { type: 'diagnostic'; code: string; message: string; details?: Record<string, unknown> }

export interface ProviderTurnToolSnapshot {
  toolCallId: string
  toolName: string
  status: ProviderTurnToolStatus
  args?: unknown
  output?: unknown
  error?: string
}

export interface ProviderTurnSnapshot {
  turnId: string
  status: ProviderTurnStatus
  assistantText: string
  reasoningText: string
  request?: ProviderTurnRequestSnapshot
  tools: ProviderTurnToolSnapshot[]
  diagnostics: Array<{ code: string; message: string; details?: Record<string, unknown> }>
  usage?: ProviderTurnUsage
}

export interface CompleteProviderTurnSnapshotOptions {
  interruptPendingTools?: boolean
  interruptedToolError?: string
}

export interface CompleteProviderTurnSnapshotResult {
  snapshot: ProviderTurnSnapshot
  interruptedToolCallIds: string[]
}

export interface EmitCompletedProviderTurnSnapshotInput {
  reducer: LooseOptional<ProviderTurnRecorder>
  onSnapshot: LooseOptional<(snapshot: ProviderTurnSnapshot) => void>
  /**
   * 仅当回合有未收敛工具或诊断时才发（错误/中止分支用）；缺省无条件发（正常收敛分支用）。
   */
  requirePendingTools?: boolean
  /** 调用方的作用域日志（StreamTurn / QueryTurn 各带自己的 tag）。 */
  log: ProviderTurnSnapshotLog
}

export interface ProviderTurnSnapshotLog {
  warn(message: string, data?: Record<string, unknown>): void
}

export type ExecutionGuidanceEnqueueResult =
  | { status: 'accepted' }
  | { status: 'closed'; reason: 'execution-settled' }
  | { status: 'invalid'; reason: 'empty-or-non-user-message' }

export type ExecutionGuidanceFinalizationResult =
  | { status: 'sealed' }
  | { status: 'pending'; pendingCount: number }

export type ExecutionGuidanceClearResult =
  | { status: 'cleared' }
  | { status: 'retained'; pendingCount: number }

export interface ExecutionGuidanceLane {
  messages: ModelMessage[]
  receipts: Array<{ inputId?: string; sourceSessionId?: string; onConsumed?: () => void }>
  inputAcceptedListeners: Set<() => void>
  sealed: boolean
}

export type TurnContextAppendListener = (sessionId: string, sourceId: TurnContextSourceId) => void

/**
 * 宿主与能力包之间的写入通知窄接口。
 *
 * 能力包只依赖这个结构契约，不依赖 {@link TurnContextAppendHub} 的具体类身份。这样宿主升级
 * Agent 包时，即使能力包仍由另一个兼容版本构建，也不会因为类的 private 字段变成名义类型
 * 而在装配边界产生两份互不兼容的声明。
 */
export interface TurnContextAppendBus {
  subscribe(listener: TurnContextAppendListener): () => void
  emit(sessionId: string, sourceId: TurnContextSourceId): void
}

export interface PendingInputResolver {
  /** 用户输入文本后唤醒 awaitUserInput。 */
  resolve: (answer: string) => void
  /** 执行失败/中断时拒绝等待中的 Promise。 */
  reject: (error: unknown) => void
}

export interface ConfirmationDecision {
  /** 用户是否同意。 */
  approved: boolean
  /** 用户拒绝时可选填写的原因。 */
  message: Nullable<string>
}

export interface PendingConfirmationResolver {
  confirmationId: string
  /** 用户做出确认选择后唤醒 awaitConfirmationDecision。 */
  resolve: (decision: ConfirmationDecision) => void
  /** 执行失败/中断时拒绝等待中的 Promise。 */
  reject: (error: unknown) => void
}

export type PendingInputResolvers = Map<string, PendingInputResolver>

export type PendingConfirmationResolvers = Map<string, PendingConfirmationResolver>

export type PendingInteractionKind = 'confirmation' | 'input'

export type ExecutionStateListener = (payload: StreamStatePayload) => void

export type ExecutionDebugListener = (payload: StreamExecutionGraphPayload) => void

export interface ExecutionStoreOptions {
  /** 是否将执行记录写入磁盘。 */
  persist?: boolean
  /** 自定义持久化文件路径，测试可覆盖。 */
  persistencePath?: string
  /** 启动时是否把未完成执行恢复为 aborted。 */
  recoverInterruptedExecutions?: boolean
  /** 可注入时间函数，方便测试稳定 id/timestamp。 */
  now?: () => number
  /** 每个 execution 最多保留的事件数；超出后保留最新事件。 */
  eventRetentionLimit?: number
  /** 最多保留的终态 execution 数；非终态记录永远保留。 */
  recordRetentionLimit?: number
}

export interface PersistedExecutionStoreFile {
  version: 1
  savedAt: number
  executions: ExecutionRecord[]
}

export type KernelBackgroundJobStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface StartKernelBackgroundJobInput {
  sessionId: string
  parentSessionId?: string
  kind: string
  label: string
  id?: string
  startedAt?: number
  onCancel?: (job: KernelBackgroundJob) => void
}

export interface KernelBackgroundJob {
  id: string
  sessionId: string
  parentSessionId?: string
  kind: string
  label: string
  status: KernelBackgroundJobStatus
  startedAt: number
  lastVisibleOutputAt: number
  stalledWarningQueued: boolean
  completedAt?: number
  result?: string
  error?: string
}

export interface KernelBackgroundJobOutputSnapshot {
  id: string
  sessionId: string
  parentSessionId?: string
  kind: string
  label: string
  status: KernelBackgroundJobStatus
  truncated?: boolean
  omittedChars?: number
  artifactError?: string
  output: string
}

export interface KernelBackgroundJobStoredOutput {
  output: string
  chars: number
  nextOffset: number
}

export interface WaitForKernelBackgroundJobsInput {
  jobIds?: readonly string[]
  timeoutMs?: number
}

export interface WaitForNextKernelBackgroundJobInput {
  timeoutMs?: number
  signal?: AbortSignal
  /** 只在已注册等待者且确认至少一个选中任务仍在运行时调用。 */
  onWaiting?: () => void
}

export type PlanChangePayload = Record<string, unknown> & {
  stepCount: number
  addedStepIds: string[]
  removedStepIds: string[]
  statusChangedSteps: Array<{
    id: string
    title: string
    previousStatus: ExecutionTaskPlanStepStatus
    status: ExecutionTaskPlanStepStatus
  }>
}

export interface ExecutionRouteProvider {
  resolve(identity: AgentTurnRouteIdentity): ResolvedTaskRoute
}

export interface ExecutionResourceProvider {
  getActiveResourceId: (sessionId: string) => Nullable<string>
}

export interface CreateExecutionArgs {
  /** 宿主来源会话 id（member=session）。 */
  sourceSessionId: string
  /** 创建执行摘要时使用的原始消息。 */
  messages: ModelMessage[]
}

export type GuidanceRelayPlan = {
  [x: string]: unknown
  understanding: string
  relays: Array<{
    threadId: string
    message: string
  }>
  mainAgent?: {
    [x: string]: unknown
    mode: 'none' | 'immediate' | 'deferred'
    dependsOnThreadIds: string[]
    message?: string
    reason?: string
  }
}

export interface BuildGuidanceRelayPromptInput {
  userGuidance: string
  workers: readonly SubAgentGuidanceRelayWorkerSnapshot[]
}

/** 主控这一侧本次收到的是规划改写还是用户原文。 */
export interface MainAgentGuidanceDelivery {
  message: ModelMessage
  kind: 'planned-rewrite' | 'verbatim'
}
