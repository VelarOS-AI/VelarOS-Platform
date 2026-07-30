import type { LanguageModel, ModelMessage, ToolSet } from 'ai'

import { isEmpty, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import type {
  AgentEvent,
  AppLocale,
  ChatRuntimeEvent,
  ReasoningLanguagePreference,
  StreamAssistantGeneratedFilePayload,
  StreamAssistantSourcePayload,
  StreamReasoningPayload,
  StreamToolCallPayload,
  StreamToolMetadataPayload,
  StreamToolProgressPayload,
  StreamToolResultPayload,
} from '@velaros-ai/core/types'
import { ChatRuntimeEvents } from '@velaros-ai/core/types'
import type { EstimateContextUsageOptions } from '@velaros-ai/core/utils/contextUsage'

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
  type ToolSpanOpener,
} from '../kernel'
import type { AgentModSeamDispatcher } from '../mods/AgentModSeams'
import {
  ToolExecutionPolicy,
  type ToolExecutionPolicyContext,
  type ToolExecutionPolicyRegistry,
} from '../tools'
import { ToolExecutor, type ToolExecutorEvents } from '../tools'

import { compareStableStrings } from './context/residency/determinism'
import {
  compileProviderSendRequest,
  type ContextGovernanceSessionRegistry,
  type ContextPayloadStore,
  ProviderRequestCompiler,
} from './context'
import {
  type AgentHistoryToolContext,
  type AgentTurnHistoryHelper,
  createInternalFollowUpMessage,
} from './history'
import type { AgentModelRequestOptions } from './model'
import {
  type AgentModelRequestPort,
  type AgentModelStreamInput,
  AiSdkAgentModelRequestPort,
  applyModelRequestPolicy,
  mergeSessionPromptCacheProviderOptions,
} from './model'
import { ProviderTurnRequestHelper } from './ProviderTurnRequestHelper'
import { AgentConnectionRetryHelper, AiSdkMaxRetries, MaxConnectionRetryAttempts } from './retry'
import {
  buildOutputTruncationContinuationPrompt,
  type InterruptedStreamPartial,
  isOutputTruncationError,
  StreamConsumer,
  type StreamConsumerEvents,
  type StreamConsumerTurnState,
} from './stream'

type QueryTurnProvider = (modelId: string, options?: AgentModelRequestOptions) => LanguageModel

type QueryTurnToolContext = ToolExecutionPolicyContext &
  AgentHistoryToolContext & {
    abortSignal: AbortSignal
    sessionId?: string
    /** 非可展示响应兜底文案的语言；缺省时 StreamConsumer 回落 zh-CN。 */
    locale?: AppLocale
    contextPayloadStore?: ContextPayloadStore
  }

interface QueryTurnToolRegistry<
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

interface QueryTurnEvents {
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
  reasoningLanguage?: ReasoningLanguagePreference
  contextWindow?: LooseOptional<number>
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
  contextEpochGuard?: LooseOptional<KernelContextEpochGuardLike>
  onProviderTurnSnapshot?: LooseOptional<(snapshot: ProviderTurnSnapshot) => void>
  /**
   * 可选观测 tool span 开启器（#37 阶段 C 片 2）。子 Agent 的 QueryLoop 每轮把 turn scope 作开启器注入，
   * 令本轮内 ToolExecutor 产 tool span（挂在子 Agent 自己的 turn span 下）；缺省 no-op（零观测零付费）。
   */
  toolSpanOpener?: LooseOptional<ToolSpanOpener>
  /**
   * 可选 mod 拦截 seam 派发器（裁决 9 机制②）；由 QueryLoop 逐轮透传。缺省 null → 本轮
   * ToolExecutor 全链 no-op，行为逐字节不变。子面与主面共用同一派发器，钩子的「拦下/改写」
   * 才不会在委派边界上出现盲区。
   */
  seams?: LooseOptional<AgentModSeamDispatcher>
}

export interface QueryTurnResult {
  hasToolUse: boolean
  text: string
  /** 供应方返回的真实输入 token 数（若有）；用于 MMU 用量校准反馈。 */
  inputTokens?: LooseOptional<number>
  /**
   * 供应方回合收敛后的执行观测富化（#37 阶段 C 片 2，对齐 StreamTurnResult）：输出 token / 成本 /
   * 结束原因 / 请求指纹。交由 QueryLoop 挂到子 Agent 本确定 turn 的 model span。缺席用 null。
   */
  outputTokens?: LooseOptional<number>
  costUsd?: LooseOptional<number>
  finishReason?: LooseOptional<string>
  requestFingerprint?: LooseOptional<string>
}

const MaxQueryStreamContinuationRecoveryAttempts = 1
const MaxQueryOutputTruncationRecoveryAttempts = 2

/**
 * 子智能体和团队执行单元使用的非交互式单轮调用工具。
 *
 * 命名陷阱：尽管叫 Query，内部仍然走流式模型调用，
 * 这样可以在事件流中实时排入工具调用，保证与流式轮次一致的并发执行行为。
 * 它跟 `StreamTurn` 真正的区别只有两条：
 *   1. 不会向界面投影文本或推理增量（除非显式打开流式文本），父智能体把累计文本作为工具结果使用。
 *   2. 工具结果直接在本轮内追加进历史，调用方不需要再单独追加工具结果。
 *
 * 用量遥测里 `turn: null` 也是这个原因：子智能体没有面向界面的轮次计数轴。
 *
 * 流消费单脑化（S1）：本类**不再自带流消费状态机**——那份内联复制曾漂移出 4 处缺陷侧行为
 * （不过滤 DSML 泄漏标记 / 不抽内联 <think> / 工具入参硬 cast 放行 / locale 写死 zh-CN）。
 * 现统一走 {@link StreamConsumer}（全内核唯一流消费引擎），本类只保留子 Agent 独有的装配：
 * turn:null 轴语义、UI 投影按 events 装配面收敛、空流来源标签 'query'。
 */
class QueryTurn<TToolContext extends QueryTurnToolContext = QueryTurnToolContext> {
  private readonly connectionRetryHelper = new AgentConnectionRetryHelper()
  private readonly executionPolicy: ToolExecutionPolicy
  /** 逐块消费 fullStream 的唯一引擎（与 StreamTurn 共用同一实现）。 */
  private readonly streamConsumerHelper: StreamConsumer
  private readonly requestCompiler: ProviderRequestCompiler
  private readonly log = logRuntime.tag('QueryTurn')
  private readonly turnRequestHelper = new ProviderTurnRequestHelper(this.log, 'query')
  private readonly prefixShapeTracker = new KernelPrefixShapeTracker()

  constructor(
    private readonly toolRegistry: QueryTurnToolRegistry<TToolContext>,
    private readonly turnHistoryHelper: AgentTurnHistoryHelper,
    /** 治理会话登记处（宿主级单实例，驻留账本与 epoch 状态跨回合共享一份，必传）。 */
    private readonly governanceSessions: ContextGovernanceSessionRegistry,
    private readonly modelRequestService: AgentModelRequestPort =
      new AiSdkAgentModelRequestPort()
  ) {
    this.executionPolicy = new ToolExecutionPolicy(toolRegistry)
    this.streamConsumerHelper = new StreamConsumer(toolRegistry)
    this.requestCompiler = new ProviderRequestCompiler(this.governanceSessions)
  }

  public async executeQueryTurn(
    args: ExecuteQueryTurnArgs<TToolContext>
  ): Promise<QueryTurnResult> {
    // turnState 每次尝试整体新建（同 StreamTurn S7 纪律）：连接重试/续写恢复后不带失败尝试的
    // usage 残留；hasVisibleOutput/hasToolUse 由 activeTurnState 指针实时反映当前尝试。
    let activeTurnState: Nullable<StreamConsumerTurnState> = null
    let connectionContinuationRecoveries = 0
    let outputTruncationRecoveries = 0
    let preservedText = ''

    while (true) {
      const interrupted = { partial: null as Nullable<InterruptedStreamPartial> }
      try {
        const result = await this.connectionRetryHelper.runWithConnectionRetry(
          () => {
            interrupted.partial = null
            const turnState = this.createTurnState(args)
            activeTurnState = turnState
            return this.executeStreamingQueryTurn(args, turnState, (partial) => {
              interrupted.partial = partial
            })
          },
          {
            phase: 'query',
            turn: null,
            abortSignal: args.toolContext.abortSignal,
            hasVisibleOutput: () => !!activeTurnState?.hasVisibleOutput,
            hasToolUse: () => !!activeTurnState?.hasToolUse,
            onRetry: (_error, attempt) => {
              args.events?.emitRuntime(
                ChatRuntimeEvents.reconnecting(attempt, MaxConnectionRetryAttempts)
              )
            },
          }
        )
        return preservedText ? { ...result, text: `${preservedText}${result.text}` } : result
      } catch (error) {
        const partial = interrupted.partial
        const appError = AppError.from(error)
        const outputWasTruncated = isOutputTruncationError(appError)
        const recoveryAttempts = outputWasTruncated
          ? outputTruncationRecoveries
          : connectionContinuationRecoveries
        if (
          !this.shouldRecoverInterruptedStream(
            error,
            args,
            activeTurnState,
            partial,
            recoveryAttempts,
            outputWasTruncated
          )
        ) {
          throw error
        }

        if (outputWasTruncated) {
          outputTruncationRecoveries += 1
        } else {
          connectionContinuationRecoveries += 1
        }
        const maxAttempts = outputWasTruncated
          ? MaxQueryOutputTruncationRecoveryAttempts
          : MaxQueryStreamContinuationRecoveryAttempts
        const appendedAssistant = this.appendInterruptedStreamRecoveryMessages(
          args.history,
          partial,
          outputWasTruncated ? 'output-truncation' : 'connection'
        )
        preservedText += partial.assistantContent
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('')
        args.events?.emitRuntime(
          ChatRuntimeEvents.reconnecting(
            outputWasTruncated ? outputTruncationRecoveries : connectionContinuationRecoveries,
            maxAttempts
          )
        )
        this.log.warn(
          outputWasTruncated
            ? 'sub-agent model output truncated after partial output, requesting continuation'
            : 'model query stream interrupted after partial output, requesting continuation',
          {
            turn: toNullable(args.turn),
            model: args.model,
            recoveryAttempt: outputWasTruncated
              ? outputTruncationRecoveries
              : connectionContinuationRecoveries,
            assistantContentParts: partial.assistantContent.length,
            appendedAssistant,
            hasPendingToolCalls: partial.hasPendingToolCalls,
            code: appError.code,
          }
        )
      }
    }
  }

  private async executeStreamingQueryTurn(
    args: ExecuteQueryTurnArgs<TToolContext>,
    turnState: StreamConsumerTurnState,
    onInterruptedPartial?: (partial: InterruptedStreamPartial) => void
  ): Promise<QueryTurnResult> {
    const toolRegistry = args.toolRegistry ?? this.toolRegistry
    const executionPolicy =
      toolRegistry === this.toolRegistry
        ? this.executionPolicy
        : new ToolExecutionPolicy(toolRegistry)
    const streamConsumerHelper =
      toolRegistry === this.toolRegistry
        ? this.streamConsumerHelper
        : new StreamConsumer(toolRegistry)
    const startedAt = Date.now()
    let didLogTurnEnd = false
    let providerTurnReducer: ProviderTurnEventReducer | undefined
    this.log.info('model query turn start', {
      turn: toNullable(args.turn),
      model: args.model,
    })

    try {
      // 注意力路由内置常开，历史里随时可能出现 recall 句柄，recall_context 必须恒定可用。
      const providerToolNamePlan = this.turnRequestHelper.resolveProviderToolNamePlan(
        args.history,
        args.allowedTools ? [...args.allowedTools, 'recall_context'] : args.allowedTools
      )
      const providerToolNames = providerToolNamePlan.providerToolNames ?? []
      const aiTools = toolRegistry.toAiTools(args.toolContext, providerToolNames, {
        toolSchemaChars: args.toolSchemaChars,
        historyToolNames: providerToolNamePlan.historyToolNames,
      })
      // P7 确定性序列化：工具清单顺序直接进 prompt 字节，禁 locale 相关比较。
      const providerAvailableToolNames = Object.keys(aiTools).sort(compareStableStrings)
      const contextWorkingSetInputs = await this.turnRequestHelper.resolveContextWorkingSetInputs(
        args.toolContext
      )
      const toolSchemaChars = this.turnRequestHelper.resolveToolSchemaChars(
        toolRegistry,
        args.toolContext,
        providerAvailableToolNames,
        aiTools,
        args.toolSchemaChars
      )
      const toolSchemaHashes = toolRegistry.estimateToolSchemaHashesByName?.(
        args.toolContext,
        providerAvailableToolNames
      )
      const compiledRequest = await compileProviderSendRequest(
        {
          sessionId: args.toolContext.sessionId?.trim() || 'unknown-session',
          rawHistoryMessages: args.history,
          phase: 'query',
          turn: null,
          payloadStore: args.toolContext.contextPayloadStore,
          toolContext: args.toolContext,
          reasoningLanguage: args.reasoningLanguage,
          model: args.model,
          systemPrompt: args.systemPrompt,
          toolSchemaChars,
          availableToolNames: providerAvailableToolNames,
          activeTask: contextWorkingSetInputs.activeTask,
          pinnedEvidence: contextWorkingSetInputs.pinnedEvidence,
          contextWindow: args.contextWindow ?? args.contextUsageOptions?.contextWindow,
          contextUsageOptions: args.contextUsageOptions,
          buildToolPayloadRefs: (providerMessages) =>
            this.turnRequestHelper.buildToolPayloadRefs(
              args.toolContext,
              providerMessages,
              (toolName) => executionPolicy.isToolOutputInline(toolName)
            ),
        },
        this.requestCompiler
      )
      this.turnRequestHelper.emitContextUsageEstimate(compiledRequest, {
        events: args.events,
        turn: args.turn,
        model: args.model,
      })
      this.turnRequestHelper.assertProviderRequestAllowed(compiledRequest, args.turn)
      providerTurnReducer = this.createProviderTurnReducer(args)
      providerTurnReducer.apply({ type: 'turn-started' })
      providerTurnReducer.apply({
        type: 'request',
        availableToolNames: providerAvailableToolNames,
        toolChoiceName: null,
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
        phase: 'query',
        model: args.model,
        current: buildKernelPrefixShape({
          systemPrompt: compiledRequest.system,
          availableToolNames: providerAvailableToolNames,
          toolSchemaChars,
          toolSchemaHashes,
          historyRewriteFingerprint: compiledRequest.historyRewriteFingerprint,
        }),
      })
      recordKernelPrefixShapeDiagnostic(providerTurnReducer, prefixShapeRecord)
      const contextEpoch = buildKernelContextEpoch({
        sessionId: args.toolContext.sessionId?.trim() || 'unknown-session',
        scope: args.contextEpochScope,
        phase: 'query',
        turn: toNullable(args.turn),
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
      const stream = this.modelRequestService.openAgentQueryTurn<ToolSet>(
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
            providerOptions: mergeSessionPromptCacheProviderOptions(
              args.modelRequestOptions,
              args.toolContext.sessionId
            ) as AgentModelStreamInput<ToolSet>['providerOptions'],
            abortSignal: args.toolContext.abortSignal,
            maxRetries: AiSdkMaxRetries,
            includeRawChunks: true,
            onError: ({ error }) => {
              const appError = AppError.from(error)
              this.log.warn('streamText error event', {
                code: appError.code,
              })
            },
          },
          args.modelRequestOptions
        )
      )

      const executor = new ToolExecutor(
        args.toolContext,
        this.createToolExecutorEvents(args),
        executionPolicy,
        {
          providerTurnReducer,
          onProviderTurnSnapshot: args.onProviderTurnSnapshot,
          // 观测：子 Agent 本轮 tool span 开启器（QueryLoop 注入的 turn scope）；缺省 no-op。
          toolSpanOpener: args.toolSpanOpener,
          // mod 接缝：与主面同一派发器；缺省 null → 全链 no-op。
          seams: args.seams,
        }
      )

      // 流消费单脑化：整段 fullStream 消费交给唯一引擎 StreamConsumer。DSML 泄漏标记过滤、
      // 内联 <think> 抽取、工具入参校验（非法入参拒绝而非硬 cast 放行）、非可展示兜底 locale、
      // 空流/截断续写抗体全在引擎里，与主 Agent 逐字一致。子 Agent 装配面差异只有三点：
      // turn:null（consumer turnState）、UI 投影经 events 装配面收敛、空流来源标签 'query'。
      const assistantContent = await streamConsumerHelper.consumeAssistantStream(
        stream.fullStream,
        turnState,
        {
          abortSignal: args.toolContext.abortSignal,
          executor,
          events: this.createStreamConsumerEvents(args),
          idleStallTimeoutMs: toOptional(args.idleStallTimeoutMs),
          model: args.model,
          contextPressure: {
            percent: compiledRequest.estimate.percent,
            usableContextWindow: compiledRequest.estimate.usableContextWindow,
          },
          requestFingerprint: compiledRequest.requestFingerprint,
          contextEpochClaim,
          contextEpochGuard: args.contextEpochGuard,
          providerTurnReducer,
          toolContext: { locale: toOptional(args.toolContext.locale) },
          emptyStreamSource: 'query',
          onInterruptedPartial,
        }
      )

      // 取消时丢弃尚未完成的 assistantContent，避免在 history 留下没有对应 tool-result 的孤儿 tool-call。
      if (args.toolContext.abortSignal.aborted) {
        this.log.info('model query turn end', {
          turn: toNullable(args.turn),
          status: 'aborted',
          durationMs: Date.now() - startedAt,
        })
        didLogTurnEnd = true
        this.emitProviderTurnSnapshot(args, providerTurnReducer, { requirePendingTools: true })
        return { hasToolUse: false, text: '' }
      }

      this.log.info('model query turn end', {
        turn: toNullable(args.turn),
        status: 'completed',
        durationMs: Date.now() - startedAt,
      })
      didLogTurnEnd = true

      this.turnHistoryHelper.appendAssistantMessage(args.history, assistantContent)

      if (turnState.hasToolUse) {
        await this.turnHistoryHelper.appendToolResultsToHistory(args.history, executor)
      } else {
        this.emitProviderTurnSnapshot(args, providerTurnReducer)
      }

      return {
        hasToolUse: turnState.hasToolUse,
        text: turnState.accumulatedText,
        inputTokens: toNullable(turnState.inputTokens),
        // 观测富化（#37 阶段 C 片 2）：与 StreamTurnResult 同款，StreamConsumer 从 stream
        // diagnostics + 请求指纹写入 turnState，此处原样回传。
        outputTokens: toNullable(turnState.outputTokens),
        costUsd: toNullable(turnState.costUsd),
        finishReason: toNullable(turnState.finishReason),
        requestFingerprint: toNullable(turnState.requestFingerprint),
      }
    } catch (error) {
      if (!didLogTurnEnd) {
        this.log.info('model query turn end', {
          turn: toNullable(args.turn),
          status: 'error',
          durationMs: Date.now() - startedAt,
        })
      }
      this.emitProviderTurnSnapshot(args, providerTurnReducer, { requirePendingTools: true })
      throw error
    }
  }

  private createTurnState(args: ExecuteQueryTurnArgs<TToolContext>): StreamConsumerTurnState {
    return {
      turn: toNullable(args.turn),
      hasToolUse: false,
      accumulatedText: '',
      hasVisibleOutput: false,
    }
  }

  private shouldRecoverInterruptedStream(
    error: unknown,
    args: ExecuteQueryTurnArgs<TToolContext>,
    turnState: Nullable<StreamConsumerTurnState>,
    partial: Nullable<InterruptedStreamPartial>,
    recoveryAttempts: number,
    outputWasTruncated: boolean
  ): partial is InterruptedStreamPartial {
    if (!partial || args.toolContext.abortSignal.aborted) return false
    // 已接受的 tool call 可能已经产生副作用且没有完整 tool-result，不能自动重放。
    if (turnState?.hasToolUse) return false
    if (isEmpty(partial.assistantContent) && !partial.hasPendingToolCalls) return false
    if (outputWasTruncated) return recoveryAttempts < MaxQueryOutputTruncationRecoveryAttempts
    if (recoveryAttempts >= MaxQueryStreamContinuationRecoveryAttempts) return false
    return this.connectionRetryHelper.isTransientConnectionError(AppError.from(error))
  }

  private appendInterruptedStreamRecoveryMessages(
    history: ModelMessage[],
    partial: InterruptedStreamPartial,
    reason: 'connection' | 'output-truncation'
  ): boolean {
    const beforeLength = history.length
    this.turnHistoryHelper.appendAssistantMessage(history, partial.assistantContent)
    const appendedAssistant = history.length > beforeLength

    if (reason === 'output-truncation') {
      history.push(
        createInternalFollowUpMessage(buildOutputTruncationContinuationPrompt(appendedAssistant))
      )
      return appendedAssistant
    }

    const lines = [
      'The previous sub-agent response stream was interrupted by a transient provider connection failure.',
    ]
    if (appendedAssistant) {
      lines.push(
        'The partial assistant text is preserved above. Continue from it without repeating it.'
      )
    }
    if (partial.hasPendingToolCalls) {
      lines.push(
        'A tool call was incomplete and was not executed. If it is still needed, emit a fresh complete tool call with valid arguments.'
      )
    }
    lines.push('Continue the subtask now and finish the requested answer.')
    history.push(createInternalFollowUpMessage(lines.join('\n')))
    return appendedAssistant
  }

  private createToolExecutorEvents(args: ExecuteQueryTurnArgs<TToolContext>): ToolExecutorEvents {
    return {
      emitRuntime: (event) => args.events?.emitRuntime?.(event),
      emitNotice: (event) => args.events?.emitNotice?.(event),
      emitToolStart: (payload) => args.events?.emitToolStart?.(payload),
      emitToolProgress: (payload) => args.events?.emitToolProgress?.(payload),
      emitToolMetadata: (payload) => args.events?.emitToolMetadata?.(payload),
      emitToolDone: (payload) => args.events?.emitToolDone?.(payload),
    }
  }

  /**
   * 把子 Agent 的 {@link QueryTurnEvents} 装配成 StreamConsumer 的 {@link StreamConsumerEvents}。
   * 这一层就是「是否投影 UI」的装配面：文本增量只在 streamTextDeltas 打开时才投影（其余转发到
   * 可选监听器，缺省 no-op）；reducer 累积与 turnState 更新在引擎内无条件发生，不受投影开关影响。
   */
  private createStreamConsumerEvents(
    args: ExecuteQueryTurnArgs<TToolContext>
  ): StreamConsumerEvents {
    const events = args.events
    return {
      emitRuntime: (event) => events?.emitRuntime?.(event),
      emitReasoningDelta: (payload) => events?.emitReasoningDelta?.(payload),
      emitTextDelta: (text) => {
        if (args.streamTextDeltas) events?.emitTextDelta?.(text)
      },
      emitGeneratedFile: (payload) => events?.emitGeneratedFile?.(payload),
      emitSource: (payload) => events?.emitSource?.(payload),
      emitToolStart: (payload) => events?.emitToolStart?.(payload),
      emitToolMetadata: (payload) => events?.emitToolMetadata?.(payload),
    }
  }

  private createProviderTurnReducer(
    args: ExecuteQueryTurnArgs<TToolContext>
  ): ProviderTurnEventReducer {
    const sessionId = args.toolContext.sessionId?.trim() || 'unknown-session'
    return new ProviderTurnEventReducer({
      turnId: `${sessionId}:query:${args.turn ?? 'internal'}`,
    })
  }

  private emitProviderTurnSnapshot(
    args: ExecuteQueryTurnArgs<TToolContext>,
    reducer?: ProviderTurnEventReducer,
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

export { QueryTurn }
export { QueryTurn as AgentQueryTurnHelper }
export type { QueryTurnEvents, QueryTurnProvider, QueryTurnToolContext, QueryTurnToolRegistry }
