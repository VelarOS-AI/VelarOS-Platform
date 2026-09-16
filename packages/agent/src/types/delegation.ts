import type { ModelMessage } from 'ai'
import type { z } from 'zod'

import type { AppError } from '@velaros-ai/core/error'

import type { AgentExecutionConfig,AgentModelProvider, AgentModelRequestOptions, ToolExecutionApi } from '../contract/requires.js'
import type { ExecutionEventBus } from '../impl/records/ExecutionEventBus.js'

import type { AgentModelInputModality, AgentRoleId, ExecutionTaskStatus, SubAgentSessionStatus, SubAgentStructuredOutputContract, SubAgentTaskMode, SubAgentTaskRequest, SubAgentTaskResult, SubAgentTaskResultStatus, SubAgentToolDigestEntry, SubAgentTypeId, SubAgentUsage, SubAgentWindDownReason, TeamExecutionPhase,TeamModelRouteCategory, TeamModelSelectionTrace, TeamWorkerType, ThinkingDepth, ToolCategoryId } from './agent.js'
import type { AgentExecutionLimits } from './loop.js'
import type { SubAgentGuidanceRelayWorkerHandle } from './records.js'
import type { CodingSessionSnapshot } from './session.js'

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

export interface SubAgentRuntimeOverride {
  provider: AgentModelProvider
  providerId: string
  model: string
  supportedInputModalities?: readonly AgentModelInputModality[]
  modelRequestOptions?: AgentModelRequestOptions
  thinkingDepth?: ThinkingDepth
}

export interface TeamModelRouteResult {
  runtimeOverride: SubAgentRuntimeOverride
  trace: unknown
}

export interface TeamModelRouteRequest {
  workerType: string
  category: string
  selection: unknown
  runtimeContext: unknown
}

/** 子 Agent 可被指定的一个模型：与主模型同一厂商、宿主已配置可用。 */
export interface TeamSelectableModel {
  id: string
  label?: string
}

/** 类型键：内置类型名或自定义 agent id。 */
export type SubAgentTypeKey = string

/** 一次派发的归一化指纹，用于"无进展"判定与目标分组。 */
export interface DispatchSignature {
  type: SubAgentTypeKey
  /** 归一化提示词指纹（type:hash），用于硬拦截「完全冗余的重复派发」。 */
  promptFingerprint: string
  /** 目标归一化键（description 优先，否则归一化提示词），用于探测同目标反复横跳。 */
  targetKey: string
}

/** 派发判定：直接放行 / 放行但追加收口提醒 / 直接拒跑。 */
export type DispatchDecision =
  | { kind: 'run'; note: null }
  | { kind: 'soft-nudge'; note: string }
  | { kind: 'hard-stop'; note: string }

export interface LedgerEntry {
  type: SubAgentTypeKey
  promptFingerprint: string
  targetKey: string
}

export interface FindingRecord {
  type: SubAgentTypeKey
  title: string
  summary: string
}

export interface SubAgentDispatchRequest {
  input: SubAgentDispatchInput
  parentCtx: SubAgentToolContext
  events: ExecutionEventBus
  config: AgentExecutionConfig
  /**
   * 本次顶层执行的 id；缺省取 `config.execution.executionId`，再缺省回退父会话 id。
   * 给没有 ToolExecutionApi 的宿主按轮区分执行用——执行结束时把同一个值交给 `clearExecution`。
   */
  executionId?: LooseOptional<string>
}

/** 派发身份分片：一次子 Agent 运行的稳定标识。 */
export interface DispatchIdentityScope {
  threadId: string
  activationId: string
  title: string
}

/** 派发类型分片：解析后的类型配置与只读模式。 */
export interface DispatchTypeScope {
  typeConfig: ResolvedSubAgentTypeConfig
  readonlyMode: boolean
}

/** 派发提示分片：拼装子 Agent 指令所需的输入。 */
export interface DispatchPromptScope {
  toolCategories: ToolCategoryId[]
  priorFindingsBriefing: Nullable<string>
  /** 续跑时上一次运行的结局；新派为 null（此时拼完整委派指令，续跑只拼追加任务）。 */
  resumeBriefing: Nullable<SubAgentResumeBriefing>
}

/** 派发控制分片：运行编排所需的事件面 / 重试 / 中继 / 模型覆盖 / effort 覆盖。 */
export interface DispatchControlScope {
  workerEvents: ExecutionEventBus
  retryState: SubAgentRetryState
  relayHandle: Nullable<SubAgentGuidanceRelayWorkerHandle>
  resolvedModelOverride: Nullable<string>
  /** reasoning effort 覆盖（D7）；null 表示继承会话 effort（由模型路由填 systemConfig.thinkingDepth）。 */
  resolvedEffortOverride: Nullable<ThinkingDepth>
  onTransientRetry?: (error: AppError, attempt: number) => void
}

/**
 * 派发计划：一次子 Agent 派发的全部输入，**按域分片**，由 runWorker 构造一次、贯穿写租约与路由
 * 执行全链（宪章 §12.7「两表示最多一个转换器」/ §12.8「对象按域分片」）。取代旧
 * `runWithOptionalWriteLease` 14 位置参数列 → `ExecuteWorkerRouteArgs` re-bag → `ExecuteWithRouteArgs`
 * 摊平的三态转换链。
 */
export interface DispatchPlan {
  request: SubAgentDispatchRequest
  /** 已通过父线程授权、运行期自动放行确认的工具上下文（尚未做沙箱作用域）。 */
  parentCtx: SubAgentToolContext
  identity: DispatchIdentityScope
  type: DispatchTypeScope
  prompt: DispatchPromptScope
  control: DispatchControlScope
}

/**
 * 执行相位分片：路由解析时一次性派生的字段（路由 / 已解析模型 / 资源作用域 / 指令 / 软上限 /
 * 续跑历史 / 输出汇）。由 runWithOptionalWriteLease（**唯一转换器**）解析后附加到派发计划。
 */
export interface DispatchExecutionScope {
  route: TeamModelRouteResult
  resolvedModel: Nullable<string>
  resourceId: Nullable<string>
  instruction: string
  /** 子智能体软上限时间戳（毫秒）；到点收尾返回而非硬杀。null 表示不施加时间上限。 */
  softDeadlineAt: Nullable<number>
  initialHistory: ModelMessage[]
  onStructuredOutput: (value: unknown) => void
  onUsage: (usage: SubAgentUsage) => void
  onHistoryUpdate: (history: ModelMessage[]) => void
}

/**
 * 解析后的派发计划：基础计划 + 沙箱作用域后的 `parentCtx` + 执行相位分片。是
 * executeWithRoute / 瞬态重试相位的唯一入参。
 */
export interface ResolvedDispatchPlan extends DispatchPlan {
  execution: DispatchExecutionScope
}

export interface WorkerStatusArgs {
  request: SubAgentDispatchRequest
  threadId: string
  activationId: string
  executionKey: string
  title: string
  agentName: string
  typeConfig: ResolvedSubAgentTypeConfig
  status: ExecutionTaskStatus
  dispatchMode: 'sync' | 'async'
  resolvedModel?: LooseOptional<string>
  result?: SubAgentTaskResult
  summary?: string
  error?: string
}

export interface SubAgentRetryState {
  hasVisibleOutput: boolean
  hasToolUse: boolean
}

export interface SubAgentWorkerExecutionOutput {
  text: string
  structuredOutput?: unknown
  usage?: SubAgentUsage
  modelTrace?: TeamModelSelectionTrace
}

/** 子 Agent 模型的决定结果：沿用主模型，或采用主 Agent 指定的同厂商模型。 */
export interface SubAgentModelChoice {
  model: Nullable<string>
  reason: 'inherited-main-model' | 'requested-model' | 'requested-model-unavailable'
  requestedModel?: LooseOptional<string>
  selectableModelIds?: LooseOptional<readonly string[]>
}

export type DangerousConfirmationStatusSink = (
  status: Extract<ExecutionTaskStatus, 'awaiting_confirmation' | 'running'>,
  summary: string
) => void

/**
 * 一次执行此刻的真实派发配额快照（`SubAgentDispatcher.describeExecutionLimits` 的返回形状）。
 *
 * 三个数**全是运行态真值**，不是任何一方的声明值。消费方（目前只有 `agent:run_workflow`）
 * 拿它当自己的上限，并原样回显给模型——回显的必须是"你实际能拿到多少"，不是"你申请了多少"。
 */
export interface SubAgentDispatchLimitsSnapshot {
  /** 该执行的并发信号量上限（同时能有几个子 Agent 在跑）。 */
  maxConcurrentSubAgents: number
  /** 该执行的子 Agent 派发总量帽。 */
  maxSubAgentsPerExecution: number
  /** 总量帽还剩多少次可派发（已扣除本执行此前的派发）。 */
  remainingDispatchBudget: number
}

export interface CreateSubAgentSessionInput {
  threadId: string
  executionId: string
  parentSessionId: string
  /** 派发时父上下文的资源标识（resourceId）；续跑须在同一资源上。 */
  resourceId?: LooseOptional<string>
  subagentType: SubAgentTypeId
  prompt: string
  description?: LooseOptional<string>
  mode?: SubAgentTaskMode
  readonly?: boolean
  toolScope?: SubAgentTaskRequest['tool_scope']
  toolCategories?: readonly ToolCategoryId[]
  model?: LooseOptional<string>
  routeCategory?: LooseOptional<TeamModelRouteCategory>
  agentName?: string
  request?: Partial<Omit<SubAgentTaskRequest, 'subagent_type' | 'prompt'>>
}

/** 线程保留相关的执行上限（单一数据源在 AgentExecutionLimits）。 */
export type SubAgentThreadRetentionLimits = Pick<
  AgentExecutionLimits,
  | 'subAgentRetainedThreadsPerSession'
  | 'subAgentRetainedThreadsTotal'
  | 'subAgentRetainedThreadIdleTtlMs'
  | 'subAgentRetainedHistoryMaxChars'
>

/** 线程不能续跑的原因。 */
export type SubAgentThreadUnresumableReason = 'not-found' | 'empty-history' | 'history-too-large'

/** 线程此刻能否续跑，以及大约能留到什么时候。 */
export type SubAgentThreadRetention =
  | {
      resumable: true
      /** 保留期限估计（epoch 毫秒）；关闭了跨执行保留（条数上限为 0）时为 null。 */
      retainedUntil: Nullable<number>
    }
  | { resumable: false; reason: SubAgentThreadUnresumableReason }

/** `releaseParentSession` 丢掉的线程；`executionId` 为它仍挂靠的执行，已脱离执行时为 null。 */
export interface SubAgentReleasedThread {
  threadId: string
  executionId: Nullable<string>
}

/** 每条线程的保留簿记（不进协议记录）。 */
export interface ThreadRetentionState {
  /** 最近一次使用（创建、续跑挂靠、运行收尾）的时刻；空闲 TTL 的起点之一。 */
  lastUsedAt: number
  /** 最近一次使用的单调序号：按它淘汰最久未用的线程，不受时钟精度影响（同一毫秒内的并行派发）。 */
  lastUseSequence: number
  /** 脱离执行的时刻；null = 仍挂在 `record.execution_id` 那次执行上。 */
  detachedAt: Nullable<number>
  /** 历史序列化字符数缓存；历史被改写即作废。 */
  historyChars: Nullable<number>
}

/** 已脱离执行、等待按条数上限裁决的线程。 */
export interface DetachedThreadCandidate {
  threadId: string
  parentSessionId: string
  lastUseSequence: number
}

export interface CapabilityWriteLease {
  scope: string
  holderTaskId: string
  acquiredAt: number
}

export type SubAgentBackgroundArtifactFormatResult =
  | { artifact: string; degraded: false }
  | { artifact: string; degraded: true; error: unknown }

/** 续跑时上一次运行的结局：异常结束的线程要提醒子 Agent 先核对现状再接着做。 */
export interface SubAgentResumeBriefing {
  previousStatus: SubAgentSessionStatus
  /** 上一次运行的失败原因摘要；上一次不是 failed 时为 null。 */
  previousFailure: Nullable<string>
}

export interface BuildSubAgentTaskResultInput {
  threadId: string
  text: string
  status: SubAgentTaskResultStatus
  windDownReason?: SubAgentWindDownReason
  codingSnapshot?: CodingSessionSnapshot
  modelTrace?: TeamModelSelectionTrace
  toolDigest?: SubAgentToolDigestEntry[]
  structuredOutput?: unknown
  usage?: SubAgentUsage
  /** 线程能否续跑；给出时落成结果里的 resumable / retained_until，缺省表示本结果不作判断。 */
  retention?: SubAgentThreadRetention
}

export interface CompiledSubAgentOutputSchema {
  schema: z.ZodType
  serialized: string
}

export type StructuredOutputParseResult =
  | { success: true; data: unknown }
  | { success: false; issues: string[] }

/** Product-owned declaration of one delegatable agent shape. */
export interface SubAgentTypeDescriptor {
  id: SubAgentTypeId
  /** 给主 Agent 选择派发类型的一句话用途，与该类型的实际能力声明同源。 */
  description?: string
  workerType: TeamWorkerType
  roleId: AgentRoleId
  routeCategory: TeamModelRouteCategory
  workerPhase: TeamExecutionPhase
  toolCategories: readonly ToolCategoryId[]
  toolNames: readonly string[]
  resourceLeaseScope: Nullable<string>
  readonlyDefault: boolean
  promptAppend: Nullable<string>
}

/** 本轮可派发类型的轻量目录；不承载授权或工具能力声明。 */
export interface SubAgentDispatchCatalog {
  defaultTypeId: SubAgentTypeId
  types: ReadonlyArray<{
    id: SubAgentTypeId
    description?: string
    readonlyDefault: boolean
  }>
}

export interface ResolvedSubAgentTypeConfig extends Omit<SubAgentTypeDescriptor, 'id'> {
  subagentType: SubAgentTypeId
  customAgentId?: string
  customAgentName?: string
}
