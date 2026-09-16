import type { ModelMessage } from 'ai'

import type { KernelCallableCapabilityService, KernelModuleHealth,ScopeRef } from '@velaros-ai/kernel/contracts/abi'

import type { AgentExecutionConfig, AgentRuntimeInputPort,ToolExecutionApi } from '../contract/requires.js'

import type { AgentCapabilityExecutionDescriptorV1, ChatSendRequest, ExecutionPendingInteractionKind, ExecutionPendingInteractionSnapshot, ExecutionProvideInputRequest, ExecutionRecord, ExecutionResolveConfirmationRequest, HostProjection, ToolCatalogEntry, ToolDescriptor as RegistryToolDescriptor } from './agent.js'
import type { ExecutionEventBusApi, GuidanceRelayPlan, KernelBackgroundJobOutputSnapshot, SubAgentGuidanceRelayWorkerSnapshot, WaitForKernelBackgroundJobsInput } from './records.js'
import type { ToolExecutionPolicyContext, ToolExecutionPolicyRegistry } from './tools.js'

/** {@link ExecutionCollaborationPort.registerActor} 入参：主 Agent 执行者登记。 */
export interface ExecutionCollaborationActorInput {
  actorId: string
  kind: 'main-agent'
  resourceId: Nullable<string>
  sessionId: string
  executionId: string
  status: 'active'
  summary: string
}

/** {@link ExecutionCollaborationPort.registerActor} 返回的执行者句柄。 */
export interface ExecutionCollaborationActorHandle {
  /** 标记执行者完成，释放其协作占用。 */
  complete(): void
}

/** {@link ExecutionGuidanceRelayPlanner.planRelay} 入参。 */
export interface ExecutionGuidanceRelayPlanInput {
  userGuidance: string
  workers: readonly SubAgentGuidanceRelayWorkerSnapshot[]
}

/** {@link ExecutionGuidanceRelayPlanner.planRelay} 返回的 relay 规划。 */
export interface ExecutionGuidanceRelayPlan {
  relays: GuidanceRelayPlan['relays']
  mainAgentMessage: Nullable<string>
}

/**
 * Narrow execution context exposed to the injected Agent runtime.
 *
 * Products publish execution progress through this module-attributed event
 * bridge and never receive the Kernel host or its registries.
 */
export interface AgentCapabilityExecutionContext {
  readonly signal: AbortSignal
  publish<TPayload>(type: string, payload: TPayload): Promise<void>
}

export interface AgentCapabilityService
  extends KernelCallableCapabilityService {
  isReady(): boolean
  execute(
    scope: LooseOptional<ScopeRef>,
    input: unknown,
    signal: AbortSignal,
  ): Promise<unknown>
  health(): Promise<KernelModuleHealth>
}

/** 读取内核后台 job 输出的入参（宿主执行协调器消费）。 */
export interface KernelChatBackgroundJobReadInput {
  jobId: string
  mode: 'incremental' | 'snapshot'
}

/** 取消内核后台 job 的入参。 */
export interface KernelChatBackgroundJobCancelInput {
  jobId: string
}

export interface KernelImplicitBackgroundWaitInput {
  signal?: AbortSignal
  onWaiting?: () => void
}

/**
 * 一轮聊天执行的运行选项：桥把后台 job 生命周期以闭包形式递给宿主执行协调器。
 * 是本桥与注入的 {@link KernelChatExecutionCoordinator} 之间的端口契约。
 */
export interface KernelChatRunOptions {
  awaitPendingBackgroundJobs?: (input?: KernelImplicitBackgroundWaitInput) => Promise<boolean>
  readBackgroundJobOutput?: (
    input: KernelChatBackgroundJobReadInput
  ) => Promise<Nullable<KernelBackgroundJobOutputSnapshot>>
  waitBackgroundJobs?: (
    input: WaitForKernelBackgroundJobsInput
  ) => Promise<KernelBackgroundJobOutputSnapshot[]>
  cancelBackgroundJob?: (
    input: KernelChatBackgroundJobCancelInput
  ) => Promise<Nullable<KernelBackgroundJobOutputSnapshot>>
}

/**
 * 宿主执行协调器窄接口：桥只需要 `run` 一个动词。
 * `TRenderTarget` 是传输/渲染目标句柄，对桥完全不透明——桥从不检查它，只原样透传给宿主。
 */
export interface KernelChatExecutionCoordinator<TRenderTarget> {
  run(
    renderTarget: TRenderTarget,
    payload: ChatSendRequest,
    options?: KernelChatRunOptions
  ): Promise<void>
}

/** 宿主执行服务窄接口：桥消费的 source-session 生命周期动词。 */
export interface KernelChatExecutionService {
  abortSourceSession(sourceSessionId: string): boolean
  provideGuidanceForSourceSession(
    request: { sessionId: string; message: ModelMessage; inputId?: string },
    authorization?: { assertCurrent(): void }
  ): Promise<void>
  provideInputForSourceSession(request: ExecutionProvideInputRequest): void
  resolveConfirmationForSourceSession(request: ExecutionResolveConfirmationRequest): void
  hasPendingInteractionForSourceSession(
    sessionId: string,
    kind: ExecutionPendingInteractionKind
  ): boolean
  getPendingInteractionForSourceSession(
    sessionId: string,
    kind: ExecutionPendingInteractionKind
  ): Nullable<ExecutionPendingInteractionSnapshot>
  isRunningForSourceSession(sessionId: string): boolean
  takeRetainedGuidanceInputIdsForSourceSession?(sessionId: string): string[]
  awaitSourceSessionSettled?(sessionId: string): Promise<void>
}

export interface PendingKernelChatRun<TRenderTarget> {
  renderTarget: TRenderTarget
  payload: ChatSendRequest
  admission: KernelChatSubmissionDeferred
  completion: KernelChatSubmissionDeferred
  cancelled: boolean
  started?: boolean
  onAccepted?: () => void
}

/** 每条输入自己的准入与执行收尾；合并 wake 不合并这些回执。 */
export interface KernelChatSubmission {
  accepted: Promise<void>
  /** 本条执行已收尾；准入失败、排队取消或宿主执行抛错时拒绝。 */
  completed: Promise<void>
}

export interface KernelChatSubmissionDeferred {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

export interface KernelSessionAuthorization {
  assertCurrent(): void
}

export interface KernelControllerTarget {
  sessionId: string
  seq?: number
}

export interface KernelControllerSendInput {
  id: string
  sessionId: string
  role?: 'user' | 'system' | 'assistant' | 'tool'
  content: string
  delivery?: KernelInputDelivery
  metadata?: Record<string, unknown>
}

export interface KernelInputReceipt {
  inputId: string
  sessionId: string
  seq: number
}

export interface KernelCancelResult {
  aborted: boolean
  /** 已接收但尚未执行的用户消息；宿主按这些身份保留为暂停输入。 */
  retainedInputIds?: string[]
}

export interface KernelControllerAnswerInput extends KernelControllerTarget {
  answer: string
}

// 审批载荷对内核控制器是不透明的：默认 unknown，宿主适配器用类型参数声明正式类型，
// 从而消除派发点的强转。
export interface KernelControllerApprovalInput<TApproval = unknown> extends KernelControllerTarget {
  confirmationId?: string
  approved: boolean
  rejectionMessage?: LooseOptional<string>
  approvalPayload?: LooseOptional<TApproval>
}

export interface ToolContractExecutionContext extends ToolExecutionPolicyContext {
  setCurrentVisibleToolNames(toolNames: string[]): void
  setCurrentVisibleToolRegistrationSignatures?(
    signatures: Record<string, string>,
  ): void
}

export interface ToolContractCatalogRegistry<TContext extends ToolContractExecutionContext> {
  listAvailable(
    context: TContext,
    allowList?: string[],
  ): RegistryToolDescriptor[]
  describeToolInputSchema(
    context: TContext,
    toolName: string,
  ): Nullable<{ description: string; schema: unknown }>
  getRegistrationSignature(toolName: string): Nullable<string>
}

export type ToolContractExecutionRegistry<TContext extends ToolContractExecutionContext> =
  Omit<ToolExecutionPolicyRegistry, 'listAvailable'> & ToolContractCatalogRegistry<TContext>

/**
 * Host 组装的每会话工具契约绑定。
 *
 * Agent 对会话状态零所有权：Host 注入上下文、可见工具与 session scope；目录租约、schema
 * 自恢复、安全校验顺序和结果信封由本门面统一拥有。
 */
export interface ToolContractExecutionBinding<TContext extends ToolContractExecutionContext> {
  readonly toolContext: TContext
  readonly allowedToolNames: string[]
  readonly hostProjection: HostProjection
  readonly projectDescriptor: (descriptor: ToolCatalogEntry) => ToolCatalogEntry
  readonly runInSessionScope: <T>(run: () => Promise<T>) => Promise<T>
}

export type AgentCapabilityKernelEventDelivery = (
  type: string,
  payload: unknown,
) => Promise<void>

/**
 * {@link SoloExecutionService} 需要的主 Agent 运行器端口。
 *
 * 只声明 Solo 会用到的单人主 Agent 流式执行动词。协作能力由 capability package
 * 通过普通工具/事件端口注入，不在 Kernel execution facade 维护产品专用方法。
 */
export interface SoloExecutionAgentRunner {
  streamSoloWorker(
    messages: ModelMessage[],
    config: AgentExecutionConfig,
    events: ExecutionEventBusApi,
    options: {
      consumeGuidance?: () => Nullable<ModelMessage>
      runtimeInput?: AgentRuntimeInputPort
    }
  ): Promise<void>
}

/**
 * {@link SoloExecutionService.run} 入参。
 */
export interface RunSoloExecutionParams {
  /** 宿主来源会话 id；串联 stream、ExecutionRecord 与能力作用域上下文。 */
  sourceSessionId: string
  /** 同一 renderer session 内的宿主 scope 元数据。 */
  sourceScopeMetadata?: LooseOptional<Record<string, unknown>>
  /** 已由 {@link ChatExecutionCoordinator} 转换的历史。 */
  messages: ModelMessage[]
  /** 模型、权限、skills、surface、abortController（由 ManagedRunner 注入）等。 */
  config: AgentExecutionConfig
  /** 调用方的取消信号；托管执行启动后会桥接到内部 abortController。 */
  abortSignal?: AbortSignal
  /** 事件出口；Coordinator 绑到 {@link ChatStreamBridge}。 */
  events: ExecutionEventBusApi
}

export type KernelInputDelivery = 'queue' | 'steer'

export type KernelInputRole = 'user' | 'system' | 'assistant' | 'tool'

export type KernelInputStatus = 'admitted' | 'promoted' | 'cancelled'

export interface AdmitKernelSessionInput {
  id?: string
  sessionId: string
  role?: KernelInputRole
  content: string
  delivery?: KernelInputDelivery
  createdAt?: number
  metadata?: Record<string, unknown>
}

export interface KernelAdmittedInput {
  id: string
  sessionId: string
  seq: number
  role: KernelInputRole
  content: string
  delivery: KernelInputDelivery
  status: KernelInputStatus
  createdAt: number
  promotedAt?: number
  cancelledAt?: number
  metadata?: Record<string, unknown>
}

export type KernelSessionDrainMode = 'run' | 'wake'

export interface KernelSessionDrainTarget {
  sessionId: string
  mode: KernelSessionDrainMode
  seq?: number
}

export interface PromoteKernelInputOptions {
  cutoffSeq?: number
  inputId?: string
}

export type KernelSessionDrainRunner = (target: KernelSessionDrainTarget) => Promise<void> | void

export type KernelSessionInputStoreResult<T> = T | Promise<T>

export interface KernelSessionInputSnapshot {
  inputs: KernelAdmittedInput[]
}

export interface KernelSessionInputSnapshotPersistence {
  loadSnapshot(): KernelSessionInputStoreResult<LooseOptional<KernelSessionInputSnapshot>>
  saveSnapshot(snapshot: KernelSessionInputSnapshot): KernelSessionInputStoreResult<void>
}

export interface KernelSessionRunDeferred {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

export interface KernelSessionRunWaiter {
  deferred: KernelSessionRunDeferred
  rejectWhenSuppressed: boolean
}

export interface KernelSessionRunDemand {
  mode: KernelSessionDrainMode
  drain: KernelSessionDrainRunner
  waiters: KernelSessionRunWaiter[]
  seq?: number
}

export interface KernelSessionRunEntry {
  current: KernelSessionRunDemand
  idle: KernelSessionRunDeferred
  pending?: KernelSessionRunDemand
  interruptSeq?: number
  stopping: boolean
}

export type KernelSessionDemandSettlement =
  | { status: 'resolved' }
  | { status: 'rejected'; error: unknown }

export interface ExecutionAbortOptions {
  emitStreamState?: boolean
}

export interface ManagedExecutionController {
  /** 已创建并写入 store 的执行记录。 */
  execution: ExecutionRecord
  /** 当前执行的取消控制器，会透传给 Agent 和工具。 */
  abortController: AbortController
  /** 工具可调用的执行 API，用于创建任务、等待确认、更新计划等。 */
  executionApi: ToolExecutionApi
  /** 已加上 agent tap 的事件总线。 */
  events: ExecutionEventBusApi
  /** 手动刷新 debug payload，供计划/任务变化后立即同步 UI。 */
  emitDebug: () => void
  /** 读取并移除本执行下一条运行中引导消息。 */
  consumeGuidance: () => Nullable<ModelMessage>
  /** 原子运行时输入端口；final drain 后 seal。 */
  runtimeInput: AgentRuntimeInputPort
}

export interface RunManagedExecutionParams {
  /** renderer/source 会话 id。 */
  sourceSessionId: string
  /** 同一 source session 内的宿主 scope。 */
  sourceScopeMetadata?: LooseOptional<Record<string, unknown>>
  /** 原始模型消息。 */
  messages: ModelMessage[]
  /** 调用方提供的事件总线。 */
  events: ExecutionEventBusApi
  /** 需要被宿主协作层观察的执行者；纯聊天不需要声明。 */
  collaborationActor?: {
    kind: 'main-agent'
    operation: string
    summary?: string
  }
  /** 真正执行业务的回调，由具体 execution host 注入。 */
  run: (controller: ManagedExecutionController) => Promise<void>
}

/**
 * `velaros.agent` capability 的公开 v1 请求信封。
 *
 * `config` 保持产品不透明，但禁止注入只应由 Host 创建的运行时对象。各 Host 在这层通用
 * 边界之后，再解析自己的模型选择、权限、空间与 hook 配置。
 */
export interface AgentCapabilityExecuteEnvelopeV1 {
  readonly protocolVersion: 1
  readonly execution: AgentCapabilityExecutionDescriptorV1
  readonly messages: readonly ModelMessage[]
  readonly config: Readonly<Record<string, unknown>>
}

export type KernelSessionInputKind = 'chat-send' | 'guidance'

export interface KernelRuntimeStatus {
  hasPendingConfirmation: boolean
  hasPendingInput: boolean
  running: boolean
  pendingPrompt: boolean
  cancelRequested: boolean
  cancellable: boolean
  queuedInputs: number
  backgroundJobs: number
}

export interface ResolveKernelRuntimeStatusInput {
  hasPendingConfirmation?: boolean
  hasPendingInput?: boolean
  running?: boolean
  cancelRequested?: boolean
  queuedInputs?: number
  backgroundJobs?: number
}
