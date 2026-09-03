// 域：主会话循环面（`AgentLoop` 引擎的**薄壳之一**，另一个是子 agent 的 QueryLoop）。
//
// **本文件不是引擎**：回合推进与四护栏住 `./AgentLoop.ts`；这里只实现主会话专属的 surface——
// 流事件如何投影给渲染层、历史如何准备与回写、压缩与转交怎么触发、工具执行器如何组装。
// **判据**：任何"两个面都需要"的逻辑属于引擎，写进壳里就会与 QueryLoop 漂移（历史事故：
// 同一个中止/护栏 bug 在两份复制体里各修一遍，且常只修一遍）。
//
// ## 关键不变量（改这些会破什么）
//  - **屏显节奏唯一权威是 ChatStreamPacer**：本面不得自带揭示层/影子打字机（组件级已处决过
//    一轮）。第二个节奏源 = 两条流打架，表现为跳字与重排。
//  - **ToolExecutor 每轮新建**：因此 seam 派发器必须沿装配链透传（新增 `new ToolExecutor` 必带
//    seams，否则 mod 的工具钩子静默失效——这条已立为判据）。
//  - **历史回写在轮尾一次落定**：中途多次写会与中止路径抢同一段历史，产生孤儿工具结果。
//  - **压缩/转交只在回合边界触发**：轮内触发会让上下文在同一轮内变形，模型看到的前后不一致。
import { randomUUID } from 'node:crypto'

import type { ModelMessage } from 'ai'

import type {
  ActiveContextArtifact,
  ActiveContextArtifactKind,
  ActiveContextArtifactStatus,
  ActiveContextUpsertInput,
  AgentContextPhase,
  AgentModelInputModality,
  PromptSegmentTrace,
  RunProfileId,
  RunProfileRuntimePolicy,
  SkippedPromptSegmentTrace,
  StreamTurnContextPayload,
  ToolCategoryId,
  ToolCategoryOverview,
  ToolLayerTelemetryMetrics,
  ToolSurfaceProfileId,
} from '@velaros-ai/agent/protocol'
import { ChatRuntimeEvents } from '@velaros-ai/agent/protocol'
import { isNull, isTrue, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime, type ScopedLog } from '@velaros-ai/core/logger'

import {
  type AutoVerificationEvents,
  type AutoVerificationToolContext,
  runAutomaticVerification,
  tickLoopReminders,
} from '../coding'
import type { ExecutionSpanScopeFactory } from '../kernel'
import type { AgentModSeamDispatcher } from '../mods/AgentModSeams'
import {
  ToolExecutionPolicy,
  type ToolExecutionPolicyContext,
  type ToolExecutionPolicyRegistry,
  ToolExecutor,
  type ToolExecutorEvents,
} from '../tools'

import {
  beginLoopTurnSpans,
  endLoopTurnSpansError,
  endLoopTurnSpansOk,
  executeLoopTurnWithContextOverflowRecovery,
  restartLoopTurnModelSpanAfterRetry,
  runAgentLoop,
} from './AgentLoop'
import { type ContextGovernanceSessionRegistry, resolveGovernanceSessionKey } from './context'
import { resolveAgentContextPhase } from './ContextPhase'
import { recoveryRunPlanner, SessionToolAllocator, type ToolAllocatorRequest } from './control-plane'
import {
  type AgentExecutionLimitOverrides,
  type AgentExecutionLimits,
  resolveAgentExecutionLimits,
} from './ExecutionLimits'
import type { AgentTurnToolExecutor, AgentTurnToolResult } from './history'
import { createInternalFollowUpMessage } from './history'
import { extractLatestUserTextFromMessages } from './IntentSignals'
import {
  AgentLoopContextUsageManager,
  type AgentLoopToolRegistry,
} from './LoopContextUsage'
import {
  type AgentLoopSurface,
  loopContinue,
  loopFinish,
  type LoopTurnVerdict,
  LoopWindDownGuard,
} from './LoopSurface'
import type { AgentModelRequestOptions } from './model'
import type { PromptStatePreparedToolCategories } from './PromptState'
import type { AgentRoleResolution } from './RoleTypes'
import type {
  AgentChatRuntimeConfig,
  AgentExecutionConfig,
  AgentSystemRuntimeConfig,
} from './RuntimeConfiguration'
import type { AgentRuntimeInputPort } from './RuntimeInputPort'
import { createAgentRuntimeInputInterruptScope } from './RuntimeInputPort'
import {
  runSoloBackgroundCompletionGate,
  type SoloAwaitPendingBackgroundJobs,
} from './SoloBackgroundCompletionGate'
import { applySoloContextDegradeAction } from './SoloContextDegradeActionExecutor'
import {
  createSoloFinishingGateBlockTracker,
  resetSoloFinishingGateBlockTracker,
  runSoloFinishingGate,
} from './SoloFinishingGate'
import { SoloGoalLifecycle } from './SoloGoalLifecycle'
import {
  buildSoloRunProfileTelemetry,
  buildSoloToolAllocatorTelemetry,
  buildSoloToolSchemaTelemetry,
} from './SoloLoopTelemetryBuilder'
import { resolveSoloTurnModelRequestOptions } from './SoloModelRequestOptions'
import {
  advanceSoloProcessUpdateCadence,
  createSoloProcessUpdateCadenceState,
} from './SoloProcessUpdateCadence'
import { prepareSoloRunPlanForTurn } from './SoloRunPlanPreparer'
import { consumeSoloRuntimeGuidance } from './SoloRuntimeGuidance'
import { runSoloToolSpaceBootstrapFallback } from './SoloToolSpaceBootstrapFallback'
import { runSoloToolUseContinuation } from './SoloToolUseContinuation'
import { runSoloTurnWindDown } from './SoloTurnWindDown'
import type {
  ExecuteStreamTurnArgs,
  StreamTurnEvents,
  StreamTurnProvider,
  StreamTurnResult,
  StreamTurnToolContext,
  StreamTurnToolRegistry,
} from './StreamTurn'
import type { ToolSpaceBootstrapState } from './ToolSpaceBootstrapPlanner'
import {
  type AgentTurnCapabilitySnapshotSource,
  captureAgentTurnCapabilitySnapshot,
} from './TurnCapabilitySnapshot'

interface SoloLoopRoleRuntime {
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

interface SoloLoopEvents extends StreamTurnEvents, ToolExecutorEvents, AutoVerificationEvents {
  emitTurnContext(payload: StreamTurnContextPayload): void
}

type SoloLoopToolContext = StreamTurnToolContext &
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

interface SoloLoopRuntime<TEvents extends SoloLoopEvents> {
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

interface SoloLoopTurnRunner<TContext extends SoloLoopToolContext, TEvents extends SoloLoopEvents> {
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

interface SoloLoopRunContext<TContext extends SoloLoopToolContext> {
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

type SoloLoopToolRegistry<TContext extends SoloLoopToolContext> = AgentLoopToolRegistry<TContext> &
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

interface ExecuteSoloModeStreamLoopArgs<
  TContext extends SoloLoopToolContext = SoloLoopToolContext,
  TEvents extends SoloLoopEvents = SoloLoopEvents,
> {
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

type SoloModeStreamLoopResult = { status: 'completed' } | { status: 'aborted' | 'error' }

/**
 * 主 Agent 面（B5 单引擎双面：装配 AgentLoop 引擎的 UI 投影面）。
 *
 * 每一轮执行顺序（引擎骨架 + 本面装配）：
 * 1. 检查 abort（护栏 3，引擎）。
 * 2. 构建系统提示词和本轮上下文。
 * 3. 整理/压缩历史记录，避免超过上下文窗口。
 * 4. 调用模型流式接口，并在流式过程中即时执行工具。
 * 5. 若有工具调用，把 tool result 追加回 history 后进入下一轮。
 * 6. 若没有工具调用，运行自动验证 gate，通过后结束。
 */

type SoloInterruptedToolCallRecoveryKind =
  | 'output-truncation'
  | 'invalid-input'
  | 'invalid-identity'

const SoloInterruptedToolCallRecoveryLimits = {
  'output-truncation': 2,
  // 参数协议错误重试一次足以给模型自纠；继续盲试只会空烧上下文和额度。
  'invalid-input': 1,
  'invalid-identity': 1,
} as const

function resolveInterruptedToolCallRecoveryKind(
  error: AppError
): SoloInterruptedToolCallRecoveryKind {
  const reason = error.context?.reason
  if (reason === 'final_tool_name_missing' || reason === 'tool_input_start_name_missing') return 'invalid-identity'
  const finishReason = error.context?.finishReason
  return finishReason === 'length' || finishReason === 'repetition_truncation'
    ? 'output-truncation'
    : 'invalid-input'
}

/** 构造注入给下一轮的能力中立纠正提示，不把所有参数协议错误误报为超长截断。 */
function buildInterruptedToolCallRecoveryGuidance(
  kind: SoloInterruptedToolCallRecoveryKind
): string {
  if (kind === 'invalid-identity') return [
    '上一次工具调用缺少工具名称，已在执行前拒绝，没有产生副作用。',
    '如果该操作仍然必要，请从当前工具目录中选择一个明确工具，并重新发送一次完整调用。',
    '不要猜测或省略工具名，也不要重复分析；现在直接完成这个未执行的操作。',
  ].join('\n')

  if (kind === 'invalid-input') return [
    '上一次工具调用的参数不是完整、合法的 JSON object，已在执行前拒绝，没有产生副作用。',
    '如果该操作仍然必要，只重发一个完整工具调用；严格遵循当前 schema，确保字符串、换行和引号正确转义。',
    '参数含长文本时，改用当前能力公开的小块写入或分段追加方式；具体操作名与参数以工具目录为准。',
    '不要重复分析，现在直接完成这个未执行的操作。',
  ].join('\n')

  return [
    '上一次工具调用因为一次性输出内容过大，在传输中途被截断、没能执行。',
    '请把这次操作拆成更小的多次工具调用，每次只处理一部分，不要再一口气输出超大内容。',
    '优先使用当前能力公开的局部更新或分段追加操作；具体操作名与参数必须以工具目录为准。',
    '现在就用更小的分批方式重做这次操作。',
  ].join('\n')
}

class SoloStreamLoop<
  TContext extends SoloLoopToolContext = SoloLoopToolContext,
  TEvents extends SoloLoopEvents = SoloLoopEvents,
> {
  private readonly log = logRuntime.tag('SoloStreamLoop')
  private readonly contextUsage: AgentLoopContextUsageManager<TContext>
  private readonly toolSpaceBootstrapStates = new Map<string, ToolSpaceBootstrapState>()
  private readonly toolAllocators = new Map<string, SessionToolAllocator>()
  private readonly executionLimits: AgentExecutionLimits

  constructor(
    /** 处理模型 runtime、错误、max steps 等通用运行时逻辑。 */
    private readonly runtimeHelper: SoloLoopRuntime<TEvents>,
    /** 执行单轮模型调用并维护 assistant/tool 历史。 */
    private readonly turnHelper: SoloLoopTurnRunner<TContext, TEvents>,
    /**
     * 治理会话登记处（宿主级单实例，驻留账本跨回合的家）。
     * 本 loop 只在缺页降级时用它强开一次 epoch；常规治理在编译期由 `ProviderRequestCompiler` 完成。
     */
    private readonly governanceSessions: ContextGovernanceSessionRegistry,
    /** 构建 system prompt、turn context payload 和上下文片段。 */
    private readonly runContextHelper: SoloLoopRunContext<TContext>,
    /** 用于估算工具 schema 占用并生成 AI SDK tool set。 */
    private readonly toolRegistry: SoloLoopToolRegistry<TContext>,
    /**
     * 可选执行观测区段端口（D6 端口纪律）。缺省为空操作；无宿主账本装配（无界面运行、网页桥、
     * 子智能体 `QueryLoop`）时不产生观测与开销。装配后，本循环创建运行、回合与模型区段，并把
     * 回合作用域作为工具区段开启器注入每轮 `ToolExecutor`。
     */
    private readonly spanScopeFactory: LooseOptional<ExecutionSpanScopeFactory> = null,
    executionLimitOverrides: AgentExecutionLimitOverrides = {},
    /**
     * 可选 mod 拦截 seam 派发器（裁决 9 机制②）。缺省 null——未注入时每轮 ToolExecutor 收到的
     * 依然是 null，主链行为逐字节不变；注入时本 loop 把它透传给每轮（含缺页重放时重建的那个）
     * ToolExecutor，`tool-call:before` / `tool-result:after` 才真正接得到主面的工具调用。
     */
    private readonly seams: LooseOptional<AgentModSeamDispatcher> = null
  ) {
    this.executionLimits = resolveAgentExecutionLimits(executionLimitOverrides)
    this.contextUsage = new AgentLoopContextUsageManager(toolRegistry)
  }

  private getSessionStateKey(sessionId: LooseOptional<string>): string {
    return sessionId ?? '__default__'
  }

  private getToolSpaceBootstrapStateKey(toolContext: TContext): string {
    return this.getSessionStateKey(toolContext.sessionId)
  }

  private getToolSpaceBootstrapState(toolContext: TContext): ToolSpaceBootstrapState {
    return this.toolSpaceBootstrapStates.get(this.getToolSpaceBootstrapStateKey(toolContext)) ?? {}
  }

  private setToolSpaceBootstrapState(toolContext: TContext, state: ToolSpaceBootstrapState): void {
    this.toolSpaceBootstrapStates.set(this.getToolSpaceBootstrapStateKey(toolContext), state)
  }

  private getToolAllocator(toolContext: TContext): SessionToolAllocator {
    const key = this.getSessionStateKey(toolContext.sessionId)
    const existing = this.toolAllocators.get(key)
    if (existing) return existing
    const created = new SessionToolAllocator({
      capabilityPorts: toolContext.capabilityPorts,
    })
    this.toolAllocators.set(key, created)
    return created
  }

  private sumPreparedToolSchemaChars(
    allowedTools: readonly string[],
    toolSchemaChars?: Readonly<Record<string, number>>
  ): Nullable<number> {
    if (!toolSchemaChars) return null

    return allowedTools.reduce(
      (sum, toolName) => sum + Math.max(0, toolSchemaChars[toolName] ?? 0),
      0
    )
  }

  /** 清理指定会话在 loop 生命周期内缓存的工具空间和分配器状态。 */
  public clearSession(sessionId: string): void {
    const key = this.getSessionStateKey(sessionId)
    this.toolSpaceBootstrapStates.delete(key)
    this.toolAllocators.delete(key)
  }

  /** 运行完整 solo loop，直到完成、失败、被中断、墙钟超时或触达隐藏步数熔断。 */
  public async execute(
    args: ExecuteSoloModeStreamLoopArgs<TContext, TEvents>
  ): Promise<SoloModeStreamLoopResult> {
    let capabilityContext = args.capabilityContext
    // maxSteps 已移除（不再暴露给用户/模型）。循环跑到模型自主收手、出错、被中断或墙钟超时为止；
    // 另有隐藏步数熔断兜底「快转」（护栏 1，机制单源在 LoopWindDownGuard）：到软上限注入收尾提醒，
    // 之后最多再放行 AgentTurnCapWindDownMargin 轮工具调用即强制收尾。
    const primaryMaxTurns = this.executionLimits.primaryMaxTurns
    const windDownGuard = new LoopWindDownGuard({
      hardCapTurns: primaryMaxTurns ?? Number.POSITIVE_INFINITY,
      disabled: isNull(primaryMaxTurns),
    })
    // 工具参数流中断/非法的反应式自纠计数；一旦有工具调用成功即清零。
    let interruptedToolCallRecoveryAttempts = 0
    let processUpdateCadence = createSoloProcessUpdateCadenceState()
    const finishingGateBlockTracker = createSoloFinishingGateBlockTracker()
    // 目标生命周期：整个 solo 执行共享一个实例，收尾门同轮 inspect→record 复用单次取数。
    const goalLifecycle = new SoloGoalLifecycle(args.toolContext.activeContext)
    if (isTrue(args.config.goalMode)) {
      await goalLifecycle.ensureExplicitGoal(
        extractLatestUserTextFromMessages(args.history) ?? '完成当前用户目标'
      )
    }
    // 观测：一次完整 solo 执行 = 一个 run span 根；缺省端口时为 null（全链 no-op）。
    // 每个 finish 分支就近收敛（scope.end 失败隔离且幂等首闭为准，多次调用后续吞掉）。
    const runScope = toNullable(
      this.spanScopeFactory?.beginRun({
        runId: randomUUID(),
        sessionId: resolveGovernanceSessionKey(args.toolContext.sessionId),
        rootInputId: toNullable(args.config.rootInputId),
        // 主 Agent = 根 run，无子 Agent 身份/派发来源标注（缺席用 null）。
        agentName: null,
        dispatchSource: null,
      })
    )

    const runTurn = async (turn: number): Promise<LoopTurnVerdict<SoloModeStreamLoopResult>> => {
      // 一轮模型调用从这里开始；每次循环最多发起一次 LLM 请求，tool result 可能把流程带回下一轮。
      const turnToolRegistry = captureAgentTurnCapabilitySnapshot(this.toolRegistry)
      const turnExecutionPolicy = new ToolExecutionPolicy(turnToolRegistry)
      if (turn > 1 && args.refreshCapabilityContext) {
        capabilityContext =
          (await args.refreshCapabilityContext(args.history)) ?? capabilityContext
      }

      // 通过宿主注入的 model port 解析本轮实际 provider/model；Agent Runtime 不持有具体 Model 实现。
      args.events.emitRuntime(ChatRuntimeEvents.phase('preparing'))
      const resolvedRoleRuntime = await this.runtimeHelper.resolveRoleRuntime(
        args.config,
        args.systemConfig,
        args.abortController.signal
      )
      const roleRuntime: SoloLoopRoleRuntime = {
        ...resolvedRoleRuntime,
        modelRequestOptions: resolveSoloTurnModelRequestOptions(
          resolvedRoleRuntime.modelRequestOptions,
          args.config.promptFeatures
        ),
      }
      // 工具发现与最终 tools 必须共用本轮已解析模型的输入能力，不能让目录继续展示
      // 模型无法消费结果的截图/音频工具。
      args.toolContext.setSupportedModelInputModalities(roleRuntime.supportedInputModalities)
      args.events.emitRuntime(ChatRuntimeEvents.phase('preparing-tools'))
      const contextPhaseDecision = resolveAgentContextPhase({
        turn,
        history: args.history,
        agentSurfaceId: args.config.agentSurfaceId,
        unattended: args.config.unattended,
        executionModes: args.config.executionModes,
        goalMode: args.config.goalMode,
        selectedSkillIds: args.config.selectedSkillIds,
        promptFeatures: args.config.promptFeatures,
      })
      const activeCapabilityScopeId =
        args.toolContext.codingSession.getActiveCapabilityScope?.() ?? 'default'
      // 思考深度权威源（与子 Agent 面 `QueryLoop` 同一条链）：本次运行的显式配置 ?? 系统设置。
      // 运行档在这一层**不参与**——它只在宿主组装 run config 时提供缺席默认。曾经这里读的是
      // 档位默认，用户在设置/composer 里选的力度进不了主会话（见 SoloRunPlanPreparer 的判词）。
      const activeThinkingDepth = args.config.thinkingDepth ?? args.systemConfig.thinkingDepth
      const preparedRunPlan = await prepareSoloRunPlanForTurn({
        turn,
        history: args.history,
        configuredTools: args.config.tools,
        roleAllowedTools: args.resolution.allowedTools,
        skillAllowedToolNames: args.resolution.selectedSkillAllowedTools,
        promptFeatures: args.config.promptFeatures,
        thinkingDepth: activeThinkingDepth,
        executionModes: args.config.executionModes,
        goalMode: args.config.goalMode,
        contextPhase: contextPhaseDecision.phase,
        activeCapabilityScopeId,
        agentSurfaceId: args.config.agentSurfaceId,
        roleRuntime: {
          providerId: roleRuntime.providerId,
          model: roleRuntime.model,
          providerModel: roleRuntime.providerModel,
          contextWindow: roleRuntime.contextWindow,
          supportedInputModalities: roleRuntime.supportedInputModalities,
          modelRequestOptions: roleRuntime.modelRequestOptions,
          runProfilePolicy: roleRuntime.runProfilePolicy,
        },
        toolContext: args.toolContext,
        toolRegistry: turnToolRegistry,
        bootstrapState: this.getToolSpaceBootstrapState(args.toolContext),
        setBootstrapState: (state) => this.setToolSpaceBootstrapState(args.toolContext, state),
        log: this.log,
        toolAllocator: this.getToolAllocator(args.toolContext),
      })
      const {
        resolvedRunProfile,
        runProfile,
        runProfileDefinition,
        runPlan,
        zoneAllocation,
        bootstrapToolChoice,
        enabledToolDescriptors,
        baseAllowedTools,
        protectedTools,
        toolExposure,
        promptBudget,
        toolAllocatorPlan,
        toolSchemaChars,
        promptToolCategories,
      } = preparedRunPlan
      // 工具列表在缺页降级（narrow-tools 档）时可能被收窄，故用 let。
      let allowedTools = preparedRunPlan.allowedTools
      // run plan 已把物理模型窗口与 profile 工作集上限取最小值；后续估算、编译和降级必须共用它。
      const activeContextWindow = runPlan.context.contextWindow

      // 调模型前构建本轮 system prompt、上下文片段和 step budget。
      const promptStartedAt = Date.now()
      args.events.emitRuntime(ChatRuntimeEvents.phase('building-prompt'))
      this.log.info('prompt build start', {
        turn,
        historyMessages: args.history.length,
        hasCapabilityContext: !!capabilityContext,
        runProfile,
      })
      const {
        systemPrompt,
        devEnvironmentContext,
        stableCutoff,
        promptSegments,
        skippedPromptSegments,
      } = await this.runContextHelper.buildPrimaryAgentSystemPrompt({
        chatConfig: args.chatConfig,
        systemConfig: args.systemConfig,
        messages: args.history,
        roleResolution: {
          ...args.resolution,
          allowedTools,
        },
        toolContext: args.toolContext,
        capabilityContext,
        thinkingDepth: activeThinkingDepth,
        promptFeatures: args.config.promptFeatures,
        preparedToolCategories: promptToolCategories,
        executionModes: args.config.executionModes,
        goalMode: args.config.goalMode,
        runProfile,
        promptBudget,
        contextPhase: contextPhaseDecision.phase,
      })
      const contextUsageOptions = this.contextUsage.buildContextUsageOptions(
        roleRuntime.model,
        args.toolContext,
        allowedTools,
        activeContextWindow,
        toolSchemaChars,
        turnToolRegistry
      )
      // 送核前的用量估算：只用来喂 MMU 校准闭环（下面 recordActualUsage）。历史本身**一律不改写**
      // ——降级判决整条住驻留账本，编译期投影唯一执行。
      const predictedInputTokens = this.contextUsage.estimateUsage(
        roleRuntime.model,
        systemPrompt,
        args.history,
        contextUsageOptions
      ).estimatedTokens
      this.log.info('prompt build end', {
        turn,
        promptSegments: promptSegments.length,
        skippedPromptSegments: skippedPromptSegments.length,
        allowedTools: allowedTools.length,
        droppedTools: toolExposure.droppedTools.length,
        durationMs: Date.now() - promptStartedAt,
      })
      args.abortController.signal.throwIfAborted()

      // turn context 会写入执行图和调试面板，让 UI 知道本轮角色、模型和 prompt 片段。
      const toolSchemaTelemetry = buildSoloToolSchemaTelemetry({
        toolContext: args.toolContext,
        allowedTools,
        estimateCurrentSerializedChars: (_toolContext, tools) =>
          this.sumPreparedToolSchemaChars(tools, toolSchemaChars),
        estimateBaselineSerializedChars: (toolContext, profile, tools) =>
          turnToolRegistry.estimateToolsSerializedCharsForProfile?.(toolContext, profile, tools),
      })
      const turnContextPayload = this.runContextHelper.buildTurnContextPayload({
        turn,
        roleResolution: args.resolution,
        roleRuntimeModel: {
          provider: roleRuntime.providerId,
          model: roleRuntime.model,
          providerModel: toNullable(roleRuntime.providerModel),
          contextWindow: toNullable(roleRuntime.contextWindow),
          resolutionSource: roleRuntime.resolutionSource,
          resolutionTrace: roleRuntime.resolutionTrace,
          fallbackReason: toNullable(roleRuntime.fallbackReason),
        },
        systemPrompt,
        devEnvironmentContext,
        stableCutoff,
        promptSegments,
        skippedPromptSegments,
        history: args.history,
        toolContext: args.toolContext,
        allowedTools,
        contextPhaseTelemetry: {
          phase: contextPhaseDecision.phase,
          reason: contextPhaseDecision.reason,
          systemPromptChars: systemPrompt.length,
          allowedToolCount: allowedTools.length,
          toolSchemaChars: toolSchemaTelemetry?.currentSerializedChars ?? 0,
          estimatedToolSchemaTokens: toolSchemaTelemetry?.currentEstimatedTokens ?? 0,
        },
        toolSchemaTelemetry,
        runProfileTelemetry: buildSoloRunProfileTelemetry({
          profile: runProfile,
          reason: resolvedRunProfile.reason,
          contextWindow: toNullable(activeContextWindow),
          physicalContextWindow: toNullable(roleRuntime.contextWindow ?? resolvedRunProfile.contextWindow),
          maxInputWorkingSetTokens: runProfileDefinition.budget.maxInputWorkingSetTokens,
          maxToolCount: toolExposure.maxToolCount,
          maxSystemPromptChars: runProfileDefinition.budget.maxSystemPromptChars,
          baseAllowedToolCount: baseAllowedTools.length,
          exposedToolCount: allowedTools.length,
          droppedTools: toolExposure.droppedTools,
          systemPromptChars: systemPrompt.length,
          skippedPromptSegments,
        }),
        toolAllocatorTelemetry: buildSoloToolAllocatorTelemetry(
          toolAllocatorPlan,
          args.toolContext.codingSession.getToolLayerTelemetryMetrics?.(turn)
        ),
        turnPlanningTelemetry: toNullable(
          args.toolContext.codingSession.getLastTurnPlanningTelemetry?.()
        ),
      })
      args.events.emitTurnContext({
        ...turnContextPayload,
        controlPlaneLedger: runPlan.ledger,
      })
      args.events.emitRuntime(ChatRuntimeEvents.turnStart(turn))
      this.log.debug('turn start', { turn })

      // 观测（护栏 4，机制单源在 AgentLoop）：本轮 = turn span（run 的子）；provider 请求 = model span
      // （turn 的子，usage 收敛在此 —— D5 确定 turn，无 null turn）。turn scope 兼作 tool span 开启器
      // 注入本轮 ToolExecutor（缺省 no-op）。
      const spans = beginLoopTurnSpans(runScope, {
        turn,
        roleId: args.resolution.id,
        model: roleRuntime.model,
        providerModel: roleRuntime.providerModel,
        provider: roleRuntime.providerId,
      })

      // ToolExecutor 在单轮内收集并执行 tool calls；每轮新建，避免跨轮状态污染。
      let executor = new ToolExecutor(args.toolContext, args.events, turnExecutionPolicy, {
        toolSpanOpener: toOptional(spans.turnScope),
        seams: this.seams,
      })
      try {
        // 进入单轮流式调用；executeStreamTurn 通过统一请求层发起请求。
        // 缺页兜底（护栏 2，机制单源在 AgentLoop）不计入对外步数。
        const runtimeInputInterrupt = createAgentRuntimeInputInterruptScope(args.runtimeInput)
        let turnResult: StreamTurnResult
        try {
          turnResult = await executeLoopTurnWithContextOverflowRecovery({
            turn,
            abortSignal: args.abortController.signal,
            executeTurn: () =>
              this.turnHelper.executeStreamTurn({
                provider: roleRuntime.provider,
                model: roleRuntime.model,
                modelRequestOptions: roleRuntime.modelRequestOptions,
                systemPrompt,
                stableCutoff,
                history: args.history,
                contextWindow: roleRuntime.contextWindow,
                supportedInputModalities: roleRuntime.supportedInputModalities,
                contextUsageOptions,
                toolContext: args.toolContext,
                toolRegistry: turnToolRegistry,
                allowTools: allowedTools,
                toolSchemaChars,
                toolChoice: toOptional(bootstrapToolChoice),
                executor,
                events: args.events,
                abortSignal: args.abortController.signal,
                runtimeInputInterruptSignal: runtimeInputInterrupt.signal,
                idleStallTimeoutMs: this.executionLimits.modelStreamIdleTimeoutMs,
                onModelRequestRetry: (error) =>
                  restartLoopTurnModelSpanAfterRetry(spans, error),
                turn,
              }),
            resolveAction: (attempt) =>
              recoveryRunPlanner.resolveContextOverflowAction(runPlan.recovery, attempt),
            applyAction: async (action) =>
              applySoloContextDegradeAction(action, {
                governanceSessions: this.governanceSessions,
                toolRegistry: turnToolRegistry,
                log: this.log,
                roleRuntime,
                turn,
                baseAllowedTools,
                protectedTools,
                enabledToolDescriptors,
                zoneAllocation,
                toolContext: args.toolContext,
                currentAllowedTools: allowedTools,
                onToolsNarrowed: (next) => {
                  allowedTools = next
                },
              }),
            // 上下文超限发生在请求建立阶段、工具尚未执行，重置 executor 以确保干净重放。
            onBeforeRetry: () => {
              executor = new ToolExecutor(args.toolContext, args.events, turnExecutionPolicy, {
                toolSpanOpener: toOptional(spans.turnScope),
                seams: this.seams,
              })
            },
            surrenderLogMessage: 'solo loop exhausted context degrade ladder; surrendering',
            log: this.log,
          })
        } finally {
          runtimeInputInterrupt.dispose()
        }
        // 观测：provider 回合收敛 —— usage 挂在本确定 turn 的 model span（D5，消 C2 的 turn:null）。
        // 富化字段（outputTokens/costUsd/finishReason/requestFingerprint）由 StreamTurnResult 从供应方
        // 回合的 stream diagnostics + 请求指纹回传（#37 阶段 C 片 1，与 inputTokens 同源同通道）。
        endLoopTurnSpansOk(spans, turnResult, {
          systemPrompt,
          promptSegments,
          skippedPromptSegments,
        })
        // MMU 反馈：用供应方真实输入 token 校准本模型的估算系数。
        this.contextUsage.recordActualUsage(
          roleRuntime.model,
          predictedInputTokens,
          toNullable(turnResult.inputTokens)
        )
        if (turnResult.interruptedByRuntimeInput) {
          this.log.info('provider turn yielded to runtime guidance before tool dispatch', { turn })
          args.events.emitRuntime(ChatRuntimeEvents.turnEnd(turn))
          return loopContinue()
        }
        if (turnResult.hasToolUse) {
          resetSoloFinishingGateBlockTracker(finishingGateBlockTracker)
          interruptedToolCallRecoveryAttempts = 0
          const toolUseContinuation = await runSoloToolUseContinuation({
            turn,
            history: args.history,
            executor,
            bootstrapToolChoice,
            getBootstrapState: () => this.getToolSpaceBootstrapState(args.toolContext),
            setBootstrapState: (state) => this.setToolSpaceBootstrapState(args.toolContext, state),
            appendToolResultsToHistory: (history, turnExecutor) =>
              this.turnHelper.appendToolResultsToHistory(history, turnExecutor),
            toolContext: args.toolContext,
            tickLoopReminders,
            // 护栏 1（机制单源）：提醒注入后模型仍在调工具，margin 用尽即强制收尾。
            shouldForceStopAfterToolTurn: () => windDownGuard.recordToolUseTurn(),
            hardCap: primaryMaxTurns ?? Number.POSITIVE_INFINITY,
            events: args.events,
            log: this.log,
          })
          if (toolUseContinuation.status === 'completed') {
            // 隐藏回合上限是防无限工具循环的最终安全熔断；该强制终态不被后台停泊
            // 重新打开，否则失控模型可借后台任务绕过 hard cap。
            runScope?.end({ status: 'ok' })
            return loopFinish({ status: 'completed' })
          }
          const processUpdate = advanceSoloProcessUpdateCadence(processUpdateCadence, {
            hasVisibleText: !!turnResult.hasVisibleText,
          })
          processUpdateCadence = processUpdate.state
          if (processUpdate.reminder) {
            args.history.push(createInternalFollowUpMessage(processUpdate.reminder))
          }
          return loopContinue()
        }

        const bootstrapFallback = runSoloToolSpaceBootstrapFallback({
          turn,
          history: args.history,
          bootstrapToolChoice,
          internalReminders: runPlan.prompt.internalReminders,
          ignoredToolChoice: runPlan.recovery.ignoredToolChoice,
          getBootstrapState: () => this.getToolSpaceBootstrapState(args.toolContext),
          events: args.events,
          log: this.log,
        })
        if (bootstrapFallback.status === 'continue') return loopContinue()

        const finishingGate = await runSoloFinishingGate<TContext, TEvents>({
          turn,
          history: args.history,
          toolContext: args.toolContext,
          events: args.events,
          abortSignal: args.abortController.signal,
          emitAbort: () => this.runtimeHelper.emitAbort(args.events),
          tickLoopReminders,
          runAutomaticVerification,
          runtimeInput: args.runtimeInput,
          consumeGuidance: args.consumeGuidance,
          // 放在 finishing gate 内部的 takeOrSeal/goal commit 之前：等待可被 execution
          // abort 或新 runtime input 唤醒，每次只等一个后台终态。
          settlePendingBackgroundJobs: () =>
            runSoloBackgroundCompletionGate({
              turn,
              history: args.history,
              executionAbortSignal: args.abortController.signal,
              runtimeInput: args.runtimeInput,
              consumeTurnContextNote: args.consumeTurnContextNote,
              awaitPendingBackgroundJobs: args.awaitPendingBackgroundJobs,
              emitWaitingPhase: () =>
                args.events.emitRuntime(ChatRuntimeEvents.phase('waiting-background')),
              log: this.log,
            }),
          // 收尾门只在**用户显式开启目标模式**时生效（2026-08-05 裁决）。模型自己调
          // goal:create 建起来的目标不得反向把会话锁死在收尾环上——那是模型自设的工作流
          // 纪律，属于提示词层工作流，不能通过运行时拦截强制执行。
          goalMode: isTrue(args.config.goalMode),
          inspectGoalState: () => goalLifecycle.inspect(),
          completeGoalOnSuccessfulFinish: isTrue(args.config.goalMode)
            ? () => goalLifecycle.recordSuccessfulCompletion().then(() => undefined)
            : undefined,
          recordGoalCompletionAttempt: () => goalLifecycle.recordCompletionAttempt(),
          finishingGateBlockTracker,
          log: this.log,
        })
        if (finishingGate.status === 'continue') return loopContinue()
        if (finishingGate.status === 'error') {
          await goalLifecycle.recordBlockedTerminal()
        }
        runScope?.end({
          status:
            finishingGate.status === 'completed'
              ? 'ok'
              : finishingGate.status === 'aborted'
                ? 'aborted'
                : 'error',
        })
        return loopFinish({ status: finishingGate.status })
      } catch (error) {
        const appError = AppError.from(error)
        // 观测：本轮 provider 回合出错收敛（幂等——try 内已 ok 收敛则此处吞掉）。
        endLoopTurnSpansError(spans, appError)
        // 反应式自纠：安全拒绝未完整参数后，按真实原因给一次有界纠正机会。
        // 截断可允许两次分批收敛，普通非法 JSON 只允许一次，避免重复空烧额度。
        const recoveryKind = resolveInterruptedToolCallRecoveryKind(appError)
        if (
          appError.code === 'MODEL_STREAM_INTERRUPTED' &&
          !args.abortController.signal.aborted &&
          interruptedToolCallRecoveryAttempts <
            SoloInterruptedToolCallRecoveryLimits[recoveryKind]
        ) {
          interruptedToolCallRecoveryAttempts += 1
          args.history.push(
            createInternalFollowUpMessage(
              buildInterruptedToolCallRecoveryGuidance(recoveryKind)
            )
          )
          this.log.warn(
            'tool-call input rejected before execution; injecting bounded recovery guidance',
            {
              turn,
              recoveryKind,
              attempt: interruptedToolCallRecoveryAttempts,
            }
          )
          args.events.emitRuntime(ChatRuntimeEvents.turnEnd(turn))
          return loopContinue()
        }
        // runtimeHelper 会区分 abort、network、provider 等错误并发出合适事件。
        this.runtimeHelper.handleStreamError(
          error,
          turn,
          args.abortController.signal,
          args.events,
          this.log
        )
        if (!args.abortController.signal.aborted) {
          await goalLifecycle.recordBlockedTerminal()
        }
        // 错误分支也必须 emit turnEnd，否则 UI 上对应轮次会一直停在“进行中”，
        // ChatRuntime 的 turnStart/turnEnd 计数也无法收敛。
        args.events.emitRuntime(ChatRuntimeEvents.turnEnd(turn))
        runScope?.end({ status: 'error' })
        return loopFinish({ status: 'error' })
      }
    }

    const surface: AgentLoopSurface<SoloModeStreamLoopResult> = {
      // 护栏 3（中止门）：主面收敛 = emitAbort + aborted 状态（UI 事件轴），不抛错。
      isAborted: () => args.abortController.signal.aborted,
      onAborted: () => {
        this.runtimeHelper.emitAbort(args.events)
        runScope?.end({ status: 'aborted' })
        return { status: 'aborted' }
      },
      beforeTurn: async (turn) => {
        await consumeSoloRuntimeGuidance({
          turn,
          phase: 'turn-start',
          history: args.history,
          runtimeInput: args.runtimeInput,
          consumeGuidance: args.consumeGuidance,
          log: this.log,
        })

        // 环境回合上下文（统一 mid-run 投递点）：后台任务完成/失败、宿主能力活动、
        // 外部文件变化等新 delta 渲染成 user note 追加（append-only，不进 dynamic system 层，
        // 保护历史前缀缓存），并已在闭包内提交 cursor——与 pre-send chips 恰好一次不重复。
        const turnContextNote = args.consumeTurnContextNote?.()
        if (turnContextNote) {
          args.history.push({ role: 'user', content: turnContextNote })
          this.log.info('turn context note injected at turn start', { turn })
        }
      },
      windDown: {
        guard: windDownGuard,
        onTriggered: (_reason, turn) =>
          runSoloTurnWindDown({
            turn,
            hardCap: primaryMaxTurns ?? Number.POSITIVE_INFINITY,
            history: args.history,
            log: this.log,
          }),
      },
      runTurn,
    }
    return runAgentLoop(surface)
  }
}

export { SoloStreamLoop }
export { SoloStreamLoop as AgentSoloModeStreamLoop }
export type {
  ExecuteSoloModeStreamLoopArgs,
  SoloLoopEvents,
  SoloLoopRoleRuntime,
  SoloLoopRunContext,
  SoloLoopRuntime,
  SoloLoopToolContext,
  SoloLoopToolRegistry,
  SoloLoopTurnRunner,
  SoloModeStreamLoopResult,
}
