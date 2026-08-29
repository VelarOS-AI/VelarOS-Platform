import type { LanguageModel, ModelMessage, TextStreamPart, ToolChoice, ToolSet } from 'ai'

import type { EstimateContextUsageOptions } from '@velaros-ai/agent'
import type {
  AppLocale,
  ChatRuntimeEvent,
  StreamAssistantRawPayload,
} from '@velaros-ai/agent/protocol'
import { ChatRuntimeEvents } from '@velaros-ai/agent/protocol'
import { isBlank, isEmpty, isObject, isPositiveNumber, isString, isTrue, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import {
  buildKernelContextEpoch,
  buildKernelPrefixShape,
  emitCompletedProviderTurnSnapshot,
  type KernelContextEpochGuardLike,
  KernelPrefixShapeTracker,
  ProviderTurnEventReducer,
  type ProviderTurnSnapshot,
  recordKernelContextEpochDiagnostic,
  recordKernelPrefixShapeDiagnostic,
} from '../kernel'
import type { ToolExecutionPolicyRegistry } from '../tools'

import { compareStableStrings } from './context/residency/determinism'
import { assertModelInputCompatibility } from './model/ModelInputCompatibility'
import { normalizeModelRequestError } from './model/ModelRequestError'
import {
  assertProviderRequestSnapshotReconstructable,
  compileProviderSendRequest,
  type ContextGovernanceSessionRegistry,
  type ContextPayloadStore,
  ProviderRequestCompiler,
  type ProviderRequestSnapshot,
  resolveGovernanceSessionKey,
} from './context'
import {
  type AgentHistoryToolContext,
  type AgentTurnHistoryHelper,
  type AssistantContentPart,
  createInternalFollowUpMessage,
} from './history'
import type { AgentModelInputModality, AgentModelRequestOptions } from './model'
import {
  type AgentModelRequestPort,
  type AgentModelStreamInput,
  AiSdkAgentModelRequestPort,
  applyModelRequestPolicy,
  createPromptCacheSystemMessage,
  mergeSessionPromptCacheProviderOptions,
} from './model'
import { ProviderTurnRequestHelper } from './ProviderTurnRequestHelper'
import {
  type AgentConnectionRetryHelper,
  AiSdkMaxRetries,
  isContextOverflowError,
  markContextOverflowReplayUnsafe,
  MaxConnectionRetryAttempts,
} from './retry'
import {
  buildOutputTruncationContinuationPrompt,
  type ConsumeAssistantStreamArgs,
  type InterruptedStreamPartial,
  isOutputTruncationError,
  isReasoningOnlyEmptyResponseError,
  StreamConsumer,
  type StreamConsumerEvents,
  type StreamConsumerToolExecutor,
  type StreamConsumerTurnState,
} from './stream'

const PromptCacheMinStableSystemChars = 2000
/** 系统提示词 dynamic 层尾块的固定标签（逐轮同形，只有正文变）。 */
const DynamicPromptLayerMarker = '[system prompt · dynamic layer (current turn)]'
const MaxStreamContinuationRecoveryAttempts = 1
const MaxOutputTruncationRecoveryAttempts = 2
const MaxReasoningOnlyVisibleAnswerRecoveryAttempts = 2

interface LinkedAbortScope {
  signal: AbortSignal
  abort(reason?: unknown): void
  dispose(): void
}

function createLinkedAbortScope(...parentSignals: AbortSignal[]): LinkedAbortScope {
  const controller = new AbortController()
  const abort = (reason?: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason)
  }
  const disposers: Array<() => void> = []

  for (const parentSignal of parentSignals) {
    const forwardParentAbort = (): void => abort(parentSignal.reason)
    if (parentSignal.aborted) forwardParentAbort()
    else {
      parentSignal.addEventListener('abort', forwardParentAbort, { once: true })
      disposers.push(() => parentSignal.removeEventListener('abort', forwardParentAbort))
    }
  }

  return {
    signal: controller.signal,
    abort,
    dispose: () => {
      for (const dispose of disposers) dispose()
    },
  }
}

interface SystemPromptDelivery {
  system?: string
  leadingMessages: ModelMessage[]
  /** 系统提示词 dynamic 层：排在历史**之后**的活动尾块（P7-1）。 */
  tailBlocks: ModelMessage[]
}

/**
 * 系统提示词投递（P7-1 的修复点）。
 *
 * 旧形态把 dynamic 层作为**第二条 system 消息插在稳定前缀与历史之间**。那一层里有
 * `runtime.datetime`（`new Date().toLocaleString()`），逐请求变字节 —— 稳定前缀本身还能命中缓存，
 * 但它后面的**整段历史**每一轮都被踢出缓存。在 input:output ≈ 100:1 的 agent 负载上，这是把
 * 最贵的一段反复重算。
 *
 * 新形态：稳定层留在前缀（带缓存断点），dynamic 层整体下沉到活动尾。
 *
 * **为什么尾块是 user 角色而不是 system**：provider 只接受开头连续的 system 段（Anthropic 对被
 * user/assistant 隔开的第二段 system 直接报错）。尾块与既有 retained-context 注入同形——
 * user 角色 + 显式标签，内容仍是原样的 `<current_context>` XML。
 */
function buildSystemPromptDelivery(
  systemPrompt: string,
  stableCutoff: LooseOptional<number>
): SystemPromptDelivery {
  if (!isPositiveNumber(stableCutoff))
    return { system: systemPrompt, leadingMessages: [], tailBlocks: [] }

  const cutoff = Math.min(Math.floor(stableCutoff), systemPrompt.length)
  const stablePart = systemPrompt.slice(0, cutoff)
  const dynamicPart = systemPrompt.slice(cutoff)

  if (stablePart.length < PromptCacheMinStableSystemChars)
    return { system: systemPrompt, leadingMessages: [], tailBlocks: [] }

  return {
    leadingMessages: [createPromptCacheSystemMessage(stablePart)],
    tailBlocks: isEmpty(dynamicPart.trim()) ? [] : [buildDynamicPromptLayerMessage(dynamicPart)],
  }
}

/** dynamic 层尾块。标签固定，正文逐字保留（不重新格式化，否则金标轨迹比对失效）。 */
function buildDynamicPromptLayerMessage(dynamicPart: string): ModelMessage {
  return {
    role: 'user',
    content: [DynamicPromptLayerMarker, dynamicPart].join('\n'),
  }
}

type StreamTurnProvider = (modelId: string, options?: AgentModelRequestOptions) => LanguageModel

type StreamTurnToolContext = AgentHistoryToolContext & {
  abortSignal: AbortSignal
  locale?: AppLocale
  sessionId?: string
  contextPayloadStore?: ContextPayloadStore
}

interface StreamTurnToolRegistry<
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

interface StreamTurnEvents extends StreamConsumerEvents {
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
  /**
   * 供应方回合收敛后的执行观测富化（#37 阶段 C 片 1）：输出 token / 成本 / 结束原因 / 请求指纹。
   * 与 inputTokens 走同一回传通道，交由 SoloLoop 挂到本确定 turn 的 model span（D5）。缺席用 null。
   */
  outputTokens?: LooseOptional<number>
  costUsd?: LooseOptional<number>
  finishReason?: LooseOptional<string>
  requestFingerprint?: LooseOptional<string>
  providerRequestSnapshot?: LooseOptional<ProviderRequestSnapshot>
}

/**
 * 单轮流式模型调用 helper。
 *
 * 它负责通过 AgentModelRequestPort 发起流式请求、处理连接重试、消费 fullStream、
 * 追加 assistant 消息，并把原始 assistant 内容发到 debug stream。
 */
class StreamTurn<TToolContext extends StreamTurnToolContext = StreamTurnToolContext> {
  /** 逐块消费 fullStream，并把文本/tool call 分发到事件总线和 ToolExecutor。 */
  private readonly streamConsumerHelper: StreamConsumer
  private readonly requestCompiler: ProviderRequestCompiler
  private readonly log = logRuntime.tag('StreamTurn')
  private readonly turnRequestHelper = new ProviderTurnRequestHelper(this.log, 'stream')
  private readonly prefixShapeTracker = new KernelPrefixShapeTracker()

  constructor(
    /** 用于生成当前可见 AI tools。 */
    private readonly toolRegistry: StreamTurnToolRegistry<TToolContext>,
    /** 网络/供应商瞬断重试策略。 */
    private readonly connectionRetryHelper: AgentConnectionRetryHelper,
    /** assistant/tool 历史拼接工具。 */
    private readonly turnHistoryHelper: AgentTurnHistoryHelper,
    /** 治理会话登记处（宿主级单实例，驻留账本与 epoch 状态跨回合共享一份，必传）。 */
    private readonly governanceSessions: ContextGovernanceSessionRegistry,
    /** 后端统一模型请求层。 */
    private readonly modelRequestService: AgentModelRequestPort =
      new AiSdkAgentModelRequestPort()
  ) {
    this.streamConsumerHelper = new StreamConsumer(toolRegistry)
    this.requestCompiler = new ProviderRequestCompiler(this.governanceSessions)
  }

  /** 执行单个 stream turn。 */
  public async executeStreamTurn(
    args: ExecuteStreamTurnArgs<TToolContext>
  ): Promise<StreamTurnResult> {
    const toolRegistry = args.toolRegistry ?? this.toolRegistry
    const streamConsumerHelper =
      toolRegistry === this.toolRegistry
        ? this.streamConsumerHelper
        : new StreamConsumer(toolRegistry)
    // S7：turnState 每次尝试**整体新建**。旧实现只重置 8 个字段中的 3 个（hasToolUse /
    // accumulatedText / hasVisibleOutput），连接重试后一次失败尝试残留的 inputTokens /
    // outputTokens / costUsd / finishReason / requestFingerprint 会污染成功尝试的 span 记账
    // （usage 门在无 provider usage 时提前返回、不清残留）。整体新建 = 零残留。
    let turnState = this.createTurnState(args.turn)
    const startedAt = Date.now()
    let didLogTurnEnd = false
    let providerTurnReducer: LooseOptional<ProviderTurnEventReducer> = null
    let providerRequestSnapshot: LooseOptional<ProviderRequestSnapshot> = null
    let streamContinuationRecoveries = 0
    let reasoningOnlyVisibleAnswerRecoveries = 0
    const turnAbortScope = createLinkedAbortScope(
      args.abortSignal,
      ...(args.runtimeInputInterruptSignal ? [args.runtimeInputInterruptSignal] : [])
    )
    this.log.info('model stream turn start', {
      turn: args.turn,
      model: args.model,
    })

    try {
      // 连接重试包住真正的模型请求；只有尚未产生可见输出或工具副作用时才允许重试。
      let assistantContent: AssistantContentPart[] = []
      while (true) {
        const interrupted = { partial: null as Nullable<InterruptedStreamPartial> }
        try {
          assistantContent = await this.connectionRetryHelper.runWithConnectionRetry(
            async () => {
              const requestAbortScope = createLinkedAbortScope(turnAbortScope.signal)
              // 每次尝试整体新建 turnState（S7），彻底消除失败尝试的 usage 残留。
              turnState = this.createTurnState(args.turn)
              try {
                requestAbortScope.signal.throwIfAborted()
                // system、history、tools 和 model 在这里交给统一请求层；重试边界由 AgentConnectionRetryHelper 控制。
                args.events.emitRuntime(ChatRuntimeEvents.phase('requesting-model'))
                this.log.info('model request start', {
                  turn: args.turn,
                  model: args.model,
                  historyMessages: args.history.length,
                })
                const systemDelivery = buildSystemPromptDelivery(
                  args.systemPrompt,
                  args.stableCutoff
                )
                const providerSystem = systemDelivery.system ?? ''
                // 注意力路由内置常开，历史里随时可能出现 recall 句柄，context:recall 必须恒定可用。
                const providerToolNamePlan = this.turnRequestHelper.resolveProviderToolNamePlan(
                  args.history,
                  args.allowTools ? [...args.allowTools, 'context:recall'] : args.allowTools
                )
                const aiTools = toolRegistry.toAiTools(
                  args.toolContext,
                  providerToolNamePlan.providerToolNames,
                  {
                    toolSchemaChars: args.toolSchemaChars,
                    historyToolNames: providerToolNamePlan.historyToolNames,
                  }
                )
                const toolTransportPlan =
                  this.turnRequestHelper.captureToolTransportPlan(args.toolContext)
                // P7 确定性序列化：工具清单顺序直接进 prompt 字节，禁 locale 相关比较。
                const providerAvailableToolNames = Object.keys(aiTools).sort(compareStableStrings)
                const contextWorkingSetInputs = await this.turnRequestHelper.resolveContextWorkingSetInputs(
                  args.toolContext
                )
                const toolSchemaChars = this.turnRequestHelper.resolveToolSchemaChars(
                  toolRegistry,
                  args.toolContext,
                  providerToolNamePlan.providerToolNames,
                  aiTools,
                  toolTransportPlan,
                  args.toolSchemaChars
                )
                const toolSchemaHashes = this.turnRequestHelper.resolveToolSchemaHashes(
                  toolRegistry,
                  args.toolContext,
                  providerToolNamePlan.providerToolNames,
                  aiTools,
                  toolTransportPlan
                )
                const providerTools = this.turnRequestHelper.resolveProviderToolDefinitions(
                  aiTools,
                  args.toolContext,
                  toolTransportPlan,
                  toolSchemaChars,
                  toolSchemaHashes
                )
                const providerToolChoice = this.turnRequestHelper.resolveProviderToolChoice(
                  toolTransportPlan,
                  args.toolChoice
                )
                const toolChoiceName = this.resolveToolChoiceName(providerToolChoice)
                const compiledRequest = await compileProviderSendRequest(
                  {
                    sessionId: resolveGovernanceSessionKey(args.toolContext.sessionId),
                    rawHistoryMessages: args.history,
                    leadingMessages: systemDelivery.leadingMessages,
                    tailBlocks: systemDelivery.tailBlocks,
                    phase: 'stream',
                    turn: args.turn,
                    payloadStore: args.toolContext.contextPayloadStore,
                    toolContext: args.toolContext,
                    model: args.model,
                    systemPrompt: providerSystem,
                    toolSchemaChars,
                    toolSchemaHashes,
                    providerTools,
                    providerToolChoice,
                    availableToolNames: providerAvailableToolNames,
                    toolChoiceName,
                    toolNameAliases: toolTransportPlan.canonicalToProvider,
                    activeTask: contextWorkingSetInputs.activeTask,
                    pinnedEvidence: contextWorkingSetInputs.pinnedEvidence,
                    contextWindow: args.contextWindow ?? args.contextUsageOptions?.contextWindow,
                    contextUsageOptions: args.contextUsageOptions,
                    buildToolPayloadRefs: (providerMessages) =>
                      this.turnRequestHelper.buildToolPayloadRefs(
                        args.toolContext,
                        providerMessages,
                        (toolName) =>
                          isTrue(toolRegistry.getDescriptor(toolName)?.outputInline)
                      ),
                  },
                  this.requestCompiler
                )
                this.turnRequestHelper.emitContextUsageEstimate(compiledRequest, {
                  events: args.events,
                  turn: args.turn,
                  model: args.model,
                })
                assertModelInputCompatibility({
                  messages: compiledRequest.messages,
                  supportedInputModalities: args.supportedInputModalities,
                  model: args.model,
                })
                this.turnRequestHelper.assertProviderRequestAllowed(compiledRequest, args.turn)
                assertProviderRequestSnapshotReconstructable(compiledRequest.providerRequest)
                providerRequestSnapshot = compiledRequest.providerRequest
                providerTurnReducer = this.createProviderTurnReducer(args)
                providerTurnReducer.apply({ type: 'turn-started' })
                providerTurnReducer.apply({
                  type: 'request',
                  availableToolNames: providerAvailableToolNames,
                  toolChoiceName: toNullable(toolChoiceName),
                  requestFingerprint: compiledRequest.requestFingerprint,
                  toolSchemaChars,
                  toolSchemaHashes,
                  contextUsage: {
                    estimatedTokens: compiledRequest.estimate.estimatedTokens,
                    tokenPercent: compiledRequest.estimate.tokenPercent,
                    usableContextWindow: compiledRequest.estimate.usableContextWindow,
                  },
                })
                const prefixShapeRecord = this.prefixShapeTracker.record({
                  sessionId: args.toolContext.sessionId,
                  phase: 'stream',
                  model: args.model,
                  current: buildKernelPrefixShape({
                    systemPrompt: args.systemPrompt,
                    availableToolNames: providerAvailableToolNames,
                    toolSchemaChars,
                    toolSchemaHashes,
                    historyRewriteFingerprint: compiledRequest.historyRewriteFingerprint,
                  }),
                })
                recordKernelPrefixShapeDiagnostic(providerTurnReducer, prefixShapeRecord)
                const contextEpoch = buildKernelContextEpoch({
                  sessionId: resolveGovernanceSessionKey(args.toolContext.sessionId),
                  scope: args.contextEpochScope,
                  phase: 'stream',
                  turn: args.turn,
                  model: args.model,
                  messageCount: compiledRequest.messages.length,
                  availableToolNames: providerAvailableToolNames,
                  requestFingerprint: compiledRequest.requestFingerprint,
                  contextUsage: {
                    estimatedTokens: compiledRequest.estimate.estimatedTokens,
                    tokenPercent: compiledRequest.estimate.tokenPercent,
                    usableContextWindow: compiledRequest.estimate.usableContextWindow,
                  },
                })
                const contextEpochClaim = args.contextEpochGuard?.claim(contextEpoch)
                recordKernelContextEpochDiagnostic(providerTurnReducer, contextEpoch, {
                  claim: contextEpochClaim,
                  current: contextEpochClaim ? true : undefined,
                })
                if (contextEpochClaim) args.contextEpochGuard?.assertCurrent(contextEpochClaim)
                args.executor.configureProviderTurnReducer?.(
                  providerTurnReducer,
                  args.onProviderTurnSnapshot
                )
                requestAbortScope.signal.throwIfAborted()
                const stream = this.modelRequestService.openAgentStreamTurn<ToolSet>(
                  applyModelRequestPolicy(
                    {
                      model: args.provider(args.model, {
                        ...(args.modelRequestOptions ?? {}),
                        runtimeContext: {
                          ...(args.modelRequestOptions?.runtimeContext ?? {}),
                          sessionId: args.toolContext.sessionId,
                        },
                      }),
                      system: compiledRequest.system,
                      messages: compiledRequest.messages,
                      tools: aiTools,
                      toolChoice: providerToolChoice,
                      providerOptions: mergeSessionPromptCacheProviderOptions(
                        args.modelRequestOptions,
                        args.toolContext.sessionId
                      ) as AgentModelStreamInput<ToolSet>['providerOptions'],
                      abortSignal: requestAbortScope.signal,
                      maxRetries: AiSdkMaxRetries,
                      includeRawChunks: true,
                      onError: ({ error }) => {
                        const appError = normalizeModelRequestError(error)
                        this.log.warn('streamText error event', {
                          code: appError.code,
                          message: appError.message,
                          context: appError.context,
                        })
                      },
                    },
                    args.modelRequestOptions
                  )
                )

                // fullStream 消费阶段把文本增量通知宿主，并在遇到 tool-call 时立即排入工具执行队列。
                return await streamConsumerHelper.consumeAssistantStream(stream.fullStream, turnState, {
                  ...args,
                  abortSignal: requestAbortScope.signal,
                  idleStallTimeoutMs: toOptional(args.idleStallTimeoutMs),
                  contextPressure: {
                    percent: compiledRequest.estimate.percent,
                    usableContextWindow: compiledRequest.estimate.usableContextWindow,
                  },
                  requestFingerprint: compiledRequest.requestFingerprint,
                  providerToCanonicalToolNames: toolTransportPlan.providerToCanonical,
                  contextEpochClaim,
                  contextEpochGuard: args.contextEpochGuard,
                  providerTurnReducer,
                  onInterruptedPartial: (partial) => {
                    interrupted.partial = partial
                  },
                })
              } catch (error) {
                requestAbortScope.abort(error)
                throw error
              } finally {
                requestAbortScope.dispose()
              }
            },
            {
              phase: 'stream',
              turn: args.turn,
              abortSignal: turnAbortScope.signal,
              hasVisibleOutput: () => turnState.hasVisibleOutput,
              hasToolUse: () => turnState.hasToolUse,
              onRetry: (error, attempt) => {
                args.onModelRequestRetry?.(error, attempt)
                args.events.emitRuntime(
                  ChatRuntimeEvents.retryingTurn(
                    args.turn,
                    attempt,
                    MaxConnectionRetryAttempts,
                    error.message
                  )
                )
              },
            }
          )
          break
        } catch (error) {
          const appError = AppError.from(error)
          if (this.wasInterruptedByRuntimeInput(args, turnState)) {
            assistantContent = interrupted.partial?.assistantContent ?? assistantContent
            break
          }
          if (
            this.shouldRecoverReasoningOnlyEmptyResponse(
              error,
              args,
              reasoningOnlyVisibleAnswerRecoveries
            )
          ) {
            reasoningOnlyVisibleAnswerRecoveries += 1
            this.emitProviderTurnSnapshot(args, providerTurnReducer, { requirePendingTools: true })
            providerTurnReducer = null
            args.history.push(
              createInternalFollowUpMessage(this.buildReasoningOnlyVisibleAnswerRecoveryPrompt())
            )
            args.events.emitRuntime(
              ChatRuntimeEvents.retryingTurn(
                args.turn,
                reasoningOnlyVisibleAnswerRecoveries,
                MaxReasoningOnlyVisibleAnswerRecoveryAttempts,
                appError.message
              )
            )
            this.log.warn(
              'model stream returned reasoning-only output, requesting visible answer',
              {
                turn: args.turn,
                model: args.model,
                recoveryAttempt: reasoningOnlyVisibleAnswerRecoveries,
                code: appError.code,
              }
            )
            continue
          }

          const interruptedPartial = interrupted.partial
          if (
            !this.shouldRecoverInterruptedStream(
              error,
              args,
              interruptedPartial,
              streamContinuationRecoveries
            )
          ) {
            throw error
          }

          streamContinuationRecoveries += 1
          this.emitProviderTurnSnapshot(args, providerTurnReducer, { requirePendingTools: true })
          providerTurnReducer = null
          const outputWasTruncated = isOutputTruncationError(appError)
          const maxContinuationAttempts = outputWasTruncated
            ? MaxOutputTruncationRecoveryAttempts
            : MaxStreamContinuationRecoveryAttempts
          const appendedAssistant = this.appendInterruptedStreamRecoveryMessages(
            args.history,
            interruptedPartial,
            outputWasTruncated ? 'output-truncation' : 'connection'
          )
          args.events.emitRuntime(
            ChatRuntimeEvents.retryingTurn(
              args.turn,
              streamContinuationRecoveries,
              maxContinuationAttempts,
              appError.message
            )
          )
          this.log.warn(
            outputWasTruncated
              ? 'model output truncated after partial output, requesting continuation'
              : 'model stream interrupted after partial output, requesting continuation',
            {
              turn: args.turn,
              model: args.model,
              recoveryAttempt: streamContinuationRecoveries,
              assistantContentParts: interruptedPartial.assistantContent.length,
              appendedAssistant,
              hasPendingToolCalls: interruptedPartial.hasPendingToolCalls,
              code: appError.code,
            }
          )
        }
      }

      this.log.info('model stream turn end', {
        turn: args.turn,
        status: args.abortSignal.aborted
          ? 'aborted'
          : this.wasInterruptedByRuntimeInput(args, turnState)
            ? 'steered'
            : 'completed',
        durationMs: Date.now() - startedAt,
      })
      didLogTurnEnd = true
      // 取消时丢弃尚未完成的 assistantContent；否则会写入孤儿 tool-call 而后续不会再追加 tool-result，破坏 history 的成对结构。
      if (args.abortSignal.aborted) {
        this.emitProviderTurnSnapshot(args, providerTurnReducer, { requirePendingTools: true })
        return { hasToolUse: false }
      }

      const interruptedByRuntimeInput = this.wasInterruptedByRuntimeInput(args, turnState)

      // stream 结束后把 assistant 文本和 tool-call 写回 history；外层 loop 继续追加 tool result。
      this.turnHistoryHelper.appendAssistantMessage(args.history, assistantContent)
      if (interruptedByRuntimeInput || !turnState.hasToolUse) {
        this.emitProviderTurnSnapshot(args, providerTurnReducer)
      }
      args.events.emitAssistantRaw({
        kind: 'assistant-raw',
        turn: args.turn,
        content: this.turnHistoryHelper.toAssistantRawContent(assistantContent),
      })
      return {
        hasToolUse: interruptedByRuntimeInput ? false : turnState.hasToolUse,
        hasVisibleText: !isBlank(turnState.accumulatedText),
        interruptedByRuntimeInput,
        inputTokens: toNullable(turnState.inputTokens),
        outputTokens: toNullable(turnState.outputTokens),
        costUsd: toNullable(turnState.costUsd),
        finishReason: toNullable(turnState.finishReason),
        requestFingerprint: toNullable(turnState.requestFingerprint),
        providerRequestSnapshot: toOptional(providerRequestSnapshot),
      }
    } catch (error) {
      if (isContextOverflowError(error) && (turnState.hasVisibleOutput || turnState.hasToolUse)) {
        markContextOverflowReplayUnsafe(error, {
          hasVisibleOutput: turnState.hasVisibleOutput,
          hasToolUse: turnState.hasToolUse,
        })
      }
      if (!didLogTurnEnd) {
        this.log.info('model stream turn end', {
          turn: args.turn,
          status: 'error',
          durationMs: Date.now() - startedAt,
        })
      }
      this.emitProviderTurnSnapshot(args, providerTurnReducer, { requirePendingTools: true })
      throw error
    } finally {
      turnAbortScope.dispose()
    }
  }

  private wasInterruptedByRuntimeInput(
    args: ExecuteStreamTurnArgs<TToolContext>,
    turnState: StreamConsumerTurnState
  ): boolean {
    return !!(
      !args.abortSignal.aborted &&
      args.runtimeInputInterruptSignal?.aborted &&
      !turnState.hasDispatchedToolUse
    )
  }

  /** 对外暴露给 TurnRunner 的 stream 消费入口。 */
  public async consumeAssistantStream(
    fullStream: AsyncIterable<TextStreamPart<ToolSet>>,
    turnState: StreamConsumerTurnState,
    args: ConsumeAssistantStreamArgs
  ): Promise<AssistantContentPart[]> {
    return this.streamConsumerHelper.consumeAssistantStream(fullStream, turnState, args)
  }

  /** 初始化本轮状态。 */
  private createTurnState(turn: number): StreamConsumerTurnState {
    return {
      turn,
      hasToolUse: false,
      accumulatedText: '',
      hasVisibleOutput: false,
    }
  }

  private shouldRecoverReasoningOnlyEmptyResponse(
    error: unknown,
    args: ExecuteStreamTurnArgs<TToolContext>,
    recoveryAttempts: number
  ): boolean {
    if (args.abortSignal.aborted) return false
    if (recoveryAttempts >= MaxReasoningOnlyVisibleAnswerRecoveryAttempts) return false

    return isReasoningOnlyEmptyResponseError(error, 'stream')
  }

  private buildReasoningOnlyVisibleAnswerRecoveryPrompt(): string {
    return [
      'The previous assistant response was reasoning-only and did not include any visible answer for the user.',
      'Continue now with a visible answer in normal assistant text.',
      'Do not return reasoning-only output again.',
      'If a tool is still needed, emit a fresh complete tool call with full valid arguments; otherwise answer directly.',
    ].join('\n')
  }

  private shouldRecoverInterruptedStream(
    error: unknown,
    args: ExecuteStreamTurnArgs<TToolContext>,
    partial: Nullable<InterruptedStreamPartial>,
    recoveryAttempts: number
  ): partial is InterruptedStreamPartial {
    if (!partial) return false
    if (args.abortSignal.aborted) return false
    if (isEmpty(partial.assistantContent) && !partial.hasPendingToolCalls) return false

    const appError = AppError.from(error)
    if (isOutputTruncationError(appError))
      return recoveryAttempts < MaxOutputTruncationRecoveryAttempts
    if (recoveryAttempts >= MaxStreamContinuationRecoveryAttempts) return false

    return this.connectionRetryHelper.isTransientConnectionError(appError)
  }

  private appendInterruptedStreamRecoveryMessages(
    history: ModelMessage[],
    partial: InterruptedStreamPartial,
    reason: 'connection' | 'output-truncation'
  ): boolean {
    const beforeLength = history.length
    this.turnHistoryHelper.appendAssistantMessage(history, partial.assistantContent)
    const appendedAssistant = history.length > beforeLength

    history.push(
      createInternalFollowUpMessage(
        reason === 'output-truncation'
          ? buildOutputTruncationContinuationPrompt(appendedAssistant)
          : this.buildInterruptedStreamRecoveryPrompt(partial, appendedAssistant)
      )
    )
    return appendedAssistant
  }

  private buildInterruptedStreamRecoveryPrompt(
    partial: InterruptedStreamPartial,
    appendedAssistant: boolean
  ): string {
    const lines = [
      'The previous assistant stream was interrupted by a transient provider connection failure.',
    ]

    if (appendedAssistant) {
      lines.push(
        [
          'The visible assistant text that was already streamed has been preserved in the conversation history.',
          'Continue from that point.',
          'Do not repeat the already streamed text.',
        ].join(' ')
      )
    } else if (!partial.hasPendingToolCalls) {
      lines.push(
        [
          'Continue the answer now.',
          'Do not repeat any visible text that may already have been streamed.',
        ].join(' ')
      )
    }

    if (partial.hasPendingToolCalls) {
      lines.push(
        [
          'A tool call was started but the stream ended before VelarOS accepted it.',
          'It was not executed and no tool result exists.',
          'If a tool is still needed, emit a fresh complete tool call with full valid arguments.',
        ].join(' ')
      )
    }

    lines.push('Continue now.')
    return lines.join('\n')
  }

  private resolveToolChoiceName(toolChoice?: ToolChoice<ToolSet>): LooseOptional<string> {
    if (!toolChoice || !isObject(toolChoice)) return undefined

    const candidate = toolChoice as { type?: unknown; toolName?: unknown }
    if (candidate.type !== 'tool' || !isString(candidate.toolName)) return undefined

    const trimmed = candidate.toolName.trim()
    return trimmed || undefined
  }

  private createProviderTurnReducer(
    args: ExecuteStreamTurnArgs<TToolContext>
  ): ProviderTurnEventReducer {
    const sessionId = resolveGovernanceSessionKey(args.toolContext.sessionId)
    return new ProviderTurnEventReducer({
      turnId: `${sessionId}:stream:${args.turn}`,
    })
  }

  private emitProviderTurnSnapshot(
    args: ExecuteStreamTurnArgs<TToolContext>,
    reducer: LooseOptional<ProviderTurnEventReducer>,
    options: { requirePendingTools?: boolean } = {}
  ): void {
    emitCompletedProviderTurnSnapshot({
      reducer,
      onSnapshot: args.onProviderTurnSnapshot,
      requirePendingTools: options.requirePendingTools,
      log: this.log,
    })
  }
}

export { buildSystemPromptDelivery, PromptCacheMinStableSystemChars, StreamTurn }
export { StreamTurn as AgentStreamTurnHelper }
export type { StreamTurnEvents, StreamTurnProvider, StreamTurnToolContext, StreamTurnToolRegistry }
