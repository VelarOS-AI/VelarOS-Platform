import type { ModelMessage, TextStreamPart, ToolSet } from 'ai'

import { isBlank, isEmpty, isTrue, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import type { ProviderRequestSnapshot } from '../../types/context.js'
import type { AssistantContentPart } from '../../types/history.js'
import type { AgentModelRequestPort, AgentModelStreamInput, ConsumeAssistantStreamArgs, ExecuteStreamTurnArgs, InterruptedStreamPartial, StreamTurnResult, StreamTurnToolContext, StreamTurnToolRegistry } from '../../types/loop.js'
import type { ContextGovernanceSessionRegistryContract } from '../../types/residency.js'
import { assertProviderRequestSnapshotReconstructable } from '../../utils/context/provider-request-snapshot'
import { createInternalFollowUpMessage } from '../../utils/history/internal-messages'
import { buildKernelContextEpoch, recordKernelContextEpochDiagnostic } from '../../utils/loop/kernel-context-epoch-guard'
import { buildProviderTurnId, resolveProviderToolChoiceName } from '../../utils/loop/loop-turn-assembly'
import { buildInterruptedStreamRecoveryPrompt, buildPrimaryReasoningOnlyVisibleAnswerRecoveryPrompt, shouldRecoverReasoningOnlyEmptyResponse, wasStreamTurnInterruptedByRuntimeInput } from '../../utils/loop/loop-turn-recovery'
import { buildSystemPromptDelivery } from '../../utils/loop/stream-turn'
import { assertModelInputCompatibility } from '../../utils/model/model-input-compatibility'
import { normalizeModelRequestError } from '../../utils/model/model-request-error'
import { mergeSessionPromptCacheProviderOptions } from '../../utils/model/prompt-cache'
import { emitCompletedProviderTurnSnapshot } from '../../utils/records/provider-turn-event-reducer'
import { compareStableStrings } from '../../utils/residency/determinism'
import { resolveGovernanceSessionKey } from '../../utils/residency/session-key'
import { buildOutputTruncationContinuationPrompt, isOutputTruncationError } from '../../utils/stream/output-truncation-recovery'
import { AgentTuning } from '../../utils/tuning'
import { resolveModelContextUsageOptions } from '../context/AgentLoopContextUsageManager'
import type { ProviderRequestCompilerApi } from '../context/ProviderRequestCompiler'
import { compileProviderSendRequest,ProviderRequestCompiler } from '../context/ProviderRequestCompiler'
import { chatRuntimeEvents } from '../records/ChatRuntimeEvents'
import type { ProviderTurnEventReducerApi } from '../records/ProviderTurnEventReducer'
import { ProviderTurnEventReducer } from '../records/ProviderTurnEventReducer'
import type { TurnHistoryApi } from '../records/TurnHistory'

import { AiSdkAgentModelRequestPort, applyModelRequestPolicy } from './AiSdkAgentModelRequestPort'
import { buildKernelPrefixShape, KernelPrefixShapeTracker, recordKernelPrefixShapeDiagnostic } from './KernelPrefixShapeTracker'
import { LinkedAbortScope } from './LinkedAbortScope'
import { ProviderTurnRequestHelper } from './ProviderTurnRequestHelper'
import { agentRetryPolicy, AiSdkMaxRetries, markContextOverflowReplayUnsafe, MaxConnectionRetryAttempts, type RetryPolicy } from './RetryPolicy'
import { StreamConsumer, type StreamConsumerTurnState } from './StreamConsumer'

/**
 * 主会话的一轮模型调用：从「把上下文编译成请求」到「assistant 内容写回历史」这一整段。
 *
 * 谁持有：`TurnRunner` 建一个，主面每轮经它下单。一轮里的次序固定为
 * 准备工具面与系统提示词 → 编译请求（含上下文用量估算与不可发送拦截）→ 领上下文纪元凭据 →
 * `AgentModelRequestPort` 开流 → `StreamConsumer` 逐块消费（文本投给界面、工具调用排进传入的 executor）→
 * 把 assistant 内容追加进 `args.history`。工具结果由外层 loop 面接着追加。
 *
 * 恢复与中断，由内向外三层：
 *  - 连接重试：`RetryPolicy` 包住整段请求，只在本轮尚未产出可见输出与工具调用时允许重发；
 *    每次尝试整体新建 turnState，失败尝试的 usage 绝不带进成功的那次。
 *  - 续写恢复：流被打断或输出被截断且已有部分正文时，保留已展示内容 + 追一条内部续写指令重来（次数有限）；
 *    只出思考不给可见答复也按同一路子要一次可见答复。
 *  - 都不适用：错误原样抛给 loop 面；上下文超限且本轮已有可见副作用时先打上「不可重放」标记再抛。
 * 中断有两根信号：执行中止（丢弃未完成 assistant 内容，返回 `hasToolUse:false`）与运行时插话
 * （仅在工具尚未派发时算数，本轮按被引导截断收尾，已出的正文保留）。
 */
export interface StreamTurnApi<TToolContext extends StreamTurnToolContext = StreamTurnToolContext> {
  /** 执行一轮流式模型调用；返回时 assistant 内容已写回历史，工具调用已排进 `args.executor`。 */
  executeStreamTurn(args: ExecuteStreamTurnArgs<TToolContext>): Promise<StreamTurnResult>
  /**
   * 直接消费一条已经开好的 provider 流（给 `TurnRunner` 用的转发入口）：把文本与思考增量投给事件总线、
   * 把工具调用排进 executor，并返回本轮的 assistant 内容。只消费，不负责发请求也不写历史。
   */
  consumeAssistantStream(
    fullStream: AsyncIterable<TextStreamPart<ToolSet>>,
    turnState: StreamConsumerTurnState,
    args: ConsumeAssistantStreamArgs
  ): Promise<AssistantContentPart[]>
}

/**
 * 单轮流式模型调用 helper。
 *
 * 它负责通过 AgentModelRequestPort 发起流式请求、处理连接重试、消费 fullStream、
 * 追加 assistant 消息，并把原始 assistant 内容发到 debug stream。
 */
class StreamTurn<TToolContext extends StreamTurnToolContext = StreamTurnToolContext>
  implements StreamTurnApi<TToolContext>
{
  /** 逐块消费 fullStream，并把文本/tool call 分发到事件总线和 ToolExecutor。 */
  private readonly streamConsumerHelper: StreamConsumer
  private readonly requestCompiler: ProviderRequestCompilerApi
  private readonly log = logRuntime.tag('StreamTurn')
  private readonly turnRequestHelper = new ProviderTurnRequestHelper(this.log, 'stream')
  private readonly prefixShapeTracker = new KernelPrefixShapeTracker()

  constructor(
    /** 用于生成当前可见 AI tools。 */
    private readonly toolRegistry: StreamTurnToolRegistry<TToolContext>,
    /** 网络/供应商瞬断重试策略。 */
    private readonly connectionRetryHelper: RetryPolicy,
    /** assistant/tool 历史拼接工具。 */
    private readonly turnHistoryHelper: TurnHistoryApi,
    /** 治理会话登记处（宿主级单实例，驻留账本与 epoch 状态跨回合共享一份，必传）。 */
    private readonly governanceSessions: ContextGovernanceSessionRegistryContract,
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
    let turnState: StreamConsumerTurnState = {
      turn: args.turn,
      hasToolUse: false,
      accumulatedText: '',
      hasVisibleOutput: false,
    }
    const startedAt = Date.now()
    let didLogTurnEnd = false
    let providerTurnReducer: LooseOptional<ProviderTurnEventReducerApi> = null
    let providerRequestSnapshot: LooseOptional<ProviderRequestSnapshot> = null
    let predictedInputTokens: LooseOptional<number> = null
    let streamContinuationRecoveries = 0
    let reasoningOnlyVisibleAnswerRecoveries = 0
    const turnAbortScope = new LinkedAbortScope([
      args.abortSignal,
      ...(args.runtimeInputInterruptSignal ? [args.runtimeInputInterruptSignal] : []),
    ])
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
              const requestAbortScope = new LinkedAbortScope([turnAbortScope.signal])
              // 每次尝试整体新建 turnState（S7），彻底消除失败尝试的 usage 残留。
              turnState = {
                turn: args.turn,
                hasToolUse: false,
                accumulatedText: '',
                hasVisibleOutput: false,
              }
              try {
                requestAbortScope.signal.throwIfAborted()
                // system、history、tools 和 model 在这里交给统一请求层；重试边界由 RetryPolicy 控制。
                args.events.emitRuntime(chatRuntimeEvents.phase('requesting-model'))
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
                const providerToolNamePlan = this.turnRequestHelper.resolveProviderToolNamePlan(
                  args.history,
                  args.allowTools
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
                const providerRequestToolNameAliases =
                  this.turnRequestHelper.resolveProviderRequestToolNameAliases(
                    toolTransportPlan,
                    providerToolNamePlan.historyToolNames
                  )
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
                const providerTools = await this.turnRequestHelper.resolveProviderToolDefinitions(
                  aiTools,
                  toolTransportPlan,
                  toolSchemaChars,
                  toolSchemaHashes
                )
                const providerToolChoice = this.turnRequestHelper.resolveProviderToolChoice(
                  toolTransportPlan,
                  args.toolChoice
                )
                const toolChoiceName = resolveProviderToolChoiceName(providerToolChoice)
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
                    toolNameAliases: providerRequestToolNameAliases,
                    activeTask: contextWorkingSetInputs.activeTask,
                    pinnedEvidence: contextWorkingSetInputs.pinnedEvidence,
                    contextWindow: args.contextWindow ?? args.contextUsageOptions?.contextWindow,
                    contextUsageOptions: resolveModelContextUsageOptions(args.contextUsageOptions, args.modelRequestOptions),
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
                predictedInputTokens = compiledRequest.estimate.estimatedTokens
                providerTurnReducer = new ProviderTurnEventReducer({
                  turnId: buildProviderTurnId(
                    resolveGovernanceSessionKey(args.toolContext.sessionId),
                    'stream',
                    args.turn
                  ),
                })
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
              policy: args.modelRetry,
              phase: 'stream',
              turn: args.turn,
              abortSignal: turnAbortScope.signal,
              hasVisibleOutput: () => turnState.hasVisibleOutput || (!!args.modelRetry && !!turnState.hasReasoningOutput),
              hasToolUse: () => turnState.hasToolUse,
              onRetry: (error, attempt) => {
                args.onModelRequestRetry?.(error, attempt)
                args.events.emitRuntime(
                  chatRuntimeEvents.retryingTurn(
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
          if (wasStreamTurnInterruptedByRuntimeInput(args, turnState)) {
            assistantContent = interrupted.partial?.assistantContent ?? assistantContent
            break
          }
          if (!(args.modelRetry?.allowPartialContinuation ?? true)) throw error
          if (
            shouldRecoverReasoningOnlyEmptyResponse({
              error,
              phase: 'stream',
              aborted: args.abortSignal.aborted,
              recoveryAttempts: reasoningOnlyVisibleAnswerRecoveries,
              maxAttempts: AgentTuning.loop.reasoningOnlyAnswerRecoveryAttempts,
            })
          ) {
            reasoningOnlyVisibleAnswerRecoveries += 1
            this.emitProviderTurnSnapshot(args, providerTurnReducer, { requirePendingTools: true })
            providerTurnReducer = null
            args.history.push(
              createInternalFollowUpMessage(
                buildPrimaryReasoningOnlyVisibleAnswerRecoveryPrompt()
              )
            )
            args.events.emitRuntime(
              chatRuntimeEvents.retryingTurn(
                args.turn,
                reasoningOnlyVisibleAnswerRecoveries,
                AgentTuning.loop.reasoningOnlyAnswerRecoveryAttempts,
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
            ? AgentTuning.loop.outputTruncationRecoveryAttempts
            : AgentTuning.loop.streamContinuationRecoveryAttempts
          const appendedAssistant = this.appendInterruptedStreamRecoveryMessages(
            args.history,
            interruptedPartial,
            outputWasTruncated ? 'output-truncation' : 'connection'
          )
          args.events.emitRuntime(
            chatRuntimeEvents.retryingTurn(
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
          : wasStreamTurnInterruptedByRuntimeInput(args, turnState)
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

      const interruptedByRuntimeInput = wasStreamTurnInterruptedByRuntimeInput(args, turnState)

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
        predictedInputTokens,
        outputTokens: toNullable(turnState.outputTokens),
        costUsd: toNullable(turnState.costUsd),
        reasoningTokens: toNullable(turnState.reasoningTokens),
        cacheReadInputTokens: toNullable(turnState.cacheReadInputTokens),
        cacheWriteInputTokens: toNullable(turnState.cacheWriteInputTokens),
        finishReason: toNullable(turnState.finishReason),
        requestFingerprint: toNullable(turnState.requestFingerprint),
        providerRequestSnapshot: toOptional(providerRequestSnapshot),
      }
    } catch (error) {
      if (agentRetryPolicy.isContextOverflowError(error) && (turnState.hasVisibleOutput || turnState.hasToolUse)) {
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

  /** 对外暴露给 TurnRunner 的 stream 消费入口。 */
  public async consumeAssistantStream(
    fullStream: AsyncIterable<TextStreamPart<ToolSet>>,
    turnState: StreamConsumerTurnState,
    args: ConsumeAssistantStreamArgs
  ): Promise<AssistantContentPart[]> {
    return this.streamConsumerHelper.consumeAssistantStream(fullStream, turnState, args)
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
      return recoveryAttempts < AgentTuning.loop.outputTruncationRecoveryAttempts
    if (recoveryAttempts >= AgentTuning.loop.streamContinuationRecoveryAttempts) return false

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
          : buildInterruptedStreamRecoveryPrompt(partial, appendedAssistant)
      )
    )
    return appendedAssistant
  }

  private emitProviderTurnSnapshot(
    args: ExecuteStreamTurnArgs<TToolContext>,
    reducer: LooseOptional<ProviderTurnEventReducerApi>,
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

export { buildSystemPromptDelivery, StreamTurn }
export { StreamTurn as AgentStreamTurnHelper }
