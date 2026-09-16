import type { ModelMessage, ToolSet } from 'ai'

import { isEmpty, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import type {ProviderRequestSnapshot } from '../../types/context.js'
import type { AgentModelRequestPort, AgentModelStreamInput, ExecuteQueryTurnArgs, InterruptedStreamPartial, QueryTurnToolContext, QueryTurnToolRegistry } from '../../types/loop.js'
import type { ContextGovernanceSessionRegistryApi } from '../../types/residency.js'
import { assertProviderRequestSnapshotReconstructable } from '../../utils/context/provider-request-snapshot'
import { createInternalFollowUpMessage } from '../../utils/history/internal-messages'
import {
  buildProviderTurnId,
  createQueryTurnStreamConsumerEvents,
  createQueryTurnToolExecutorEvents,
} from '../../utils/loop/loop-turn-assembly'
import { assertModelInputCompatibility } from '../../utils/model/model-input-compatibility'
import { normalizeModelRequestError } from '../../utils/model/model-request-error'
import { mergeSessionPromptCacheProviderOptions } from '../../utils/model/prompt-cache'
import { compareStableStrings } from '../../utils/residency/determinism'
import { resolveGovernanceSessionKey } from '../../utils/residency/session-key'
import {
  buildOutputTruncationContinuationPrompt,
  isOutputTruncationError,
} from '../../utils/stream/output-truncation-recovery'
import { ChatRuntimeEvents } from '../../utils/wire/chat-runtime.js'
import { resolveModelContextUsageOptions } from '../context/AgentLoopContextUsageManager'
import { compileProviderSendRequest, ProviderRequestCompiler } from '../context/ProviderRequestCompiler'
import { emitCompletedProviderTurnSnapshot, ProviderTurnEventReducer } from '../records/ProviderTurnEventReducer'
import type { TurnHistoryApi } from '../records/TurnHistory'
import { KernelToolLoopGuard } from '../tools/KernelToolLoopGuard'
import { ToolExecutionPolicy } from '../tools/ToolExecutionPolicy'
import { ToolExecutor } from '../tools/ToolExecutor'

import { AiSdkAgentModelRequestPort, applyModelRequestPolicy } from './AiSdkAgentModelRequestPort'
import { buildKernelContextEpoch, recordKernelContextEpochDiagnostic } from './KernelContextEpochGuard'
import {
  buildKernelPrefixShape,
  KernelPrefixShapeTracker,
  recordKernelPrefixShapeDiagnostic,
} from './KernelPrefixShapeTracker'
import { createLinkedAbortScope } from './LinkedAbortScope'
import { ProviderTurnRequestHelper } from './ProviderTurnRequestHelper'
import {
  AgentConnectionRetryHelper,
  AiSdkMaxRetries,
  isContextOverflowError,
  markContextOverflowReplayUnsafe,
  MaxConnectionRetryAttempts,
} from './RetryPolicy'
import { StreamConsumer, type StreamConsumerTurnState } from './StreamConsumer'

/**
 * 子 Agent 一轮的收敛结果：`QueryLoop` 拿它判「还要不要再来一轮」，并把用量挂到本轮 model span。
 * 除 hasToolUse / text 外都是观测字段，供应方没回报就缺席（null），消费方一律容忍缺席。
 */
export interface QueryTurnResult {
  /** 本轮模型有没有发起工具调用。true = 工具结果已接回历史、循环继续；false = 这轮就是答复，可以收尾。 */
  hasToolUse: boolean
  /** 本轮累计的可见正文。它就是子 Agent 交回父 Agent 的工具结果；被中断时是空串。 */
  text: string
  /** 供应方返回的真实输入 token 数（若有）；用于 MMU 用量校准反馈。 */
  inputTokens?: LooseOptional<number>
  /** 与 inputTokens 同一次成功请求的编译后估算，含治理投影和实际工具面。 */
  predictedInputTokens?: LooseOptional<number>
  /**
   * 供应方回合收敛后的执行观测富化（#37 阶段 C 片 2，对齐 StreamTurnResult）：输出 token / 成本 /
   * 结束原因 / 请求指纹。交由 QueryLoop 挂到子 Agent 本确定 turn 的 model span。缺席用 null。
   */
  outputTokens?: LooseOptional<number>
  /** 本轮的美元成本，来自网关回报（自建 provider 通常没有）；`QueryLoop` 跨轮累加后随派发结果冒泡。 */
  costUsd?: LooseOptional<number>
  /** 推理 token（含在 outputTokens 里）与输入中命中 / 写入缓存的 token；子 Agent 用量据此分项计价。 */
  reasoningTokens?: LooseOptional<number>
  /** 输入里命中缓存的 token 数（便宜的那部分）。 */
  cacheReadInputTokens?: LooseOptional<number>
  /** 输入里写入缓存的 token 数（首次建缓存要额外计价的那部分）。 */
  cacheWriteInputTokens?: LooseOptional<number>
  /** 供应方给的结束原因（`stop` / `length` / `tool-calls` …），原样透传；事后区分「自己停」和「被截断」全靠它。 */
  finishReason?: LooseOptional<string>
  /** 本次请求指纹的稳定 id，与 context-replays 对齐；出事后按它把 span、账本、回放三处对上号。 */
  requestFingerprint?: LooseOptional<string>
  /** 本次真正发出去的请求快照（可重建校验已通过）；写进回合审计，供事后逐字节复现这一次请求。 */
  providerRequestSnapshot?: LooseOptional<ProviderRequestSnapshot>
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
 */
export interface QueryTurnApi<TToolContext extends QueryTurnToolContext = QueryTurnToolContext> {
  /**
   * 跑完子 Agent 的一轮：编译请求 → 校验上下文纪元 → 开流 → 由 `StreamConsumer` 消费 →
   * 把 assistant 内容与工具结果接回 `args.history`，返回本轮收敛结果。
   *
   * 由 `TurnRunner.executeQueryTurn` 转交，一轮一次。三层恢复自内向外：连接重试（`RetryPolicy`，
   * 仅限本轮尚无可见输出与工具调用时）→ 流中断/输出截断的续写（保留已出正文，追一条内部续写指令重来，
   * 次数有限）→ 都不适用就把错误原样抛给 `QueryLoop`，由它决定缺页降级还是终止。
   * 中断：`args.toolContext.abortSignal` 一断即丢弃未完成的 assistant 内容并返回空结果（不抛），
   * 以免历史里留下没有 tool-result 的孤儿 tool-call。
   */
  executeQueryTurn(args: ExecuteQueryTurnArgs<TToolContext>): Promise<QueryTurnResult>
}

/**
 * 流消费单脑化（S1）：本类**不再自带流消费状态机**——那份内联复制曾漂移出 4 处缺陷侧行为
 * （不过滤 DSML 泄漏标记 / 不抽内联 <think> / 工具入参硬 cast 放行 / locale 写死 zh-CN）。
 * 现统一走 {@link StreamConsumer}（全内核唯一流消费引擎），本类只保留子 Agent 独有的装配：
 * turn:null 轴语义、UI 投影按 events 装配面收敛、空流来源标签 'query'。
 */
class QueryTurn<TToolContext extends QueryTurnToolContext = QueryTurnToolContext>
  implements QueryTurnApi<TToolContext>
{
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
    private readonly turnHistoryHelper: TurnHistoryApi,
    /** 治理会话登记处（宿主级单实例，驻留账本与 epoch 状态跨回合共享一份，必传）。 */
    private readonly governanceSessions: ContextGovernanceSessionRegistryApi,
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
    const toolLoopGuard = args.toolLoopGuard ?? new KernelToolLoopGuard()
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
            const turnState: StreamConsumerTurnState = {
              turn: toNullable(args.turn),
              hasToolUse: false,
              accumulatedText: '',
              hasVisibleOutput: false,
            }
            activeTurnState = turnState
            return this.executeStreamingQueryTurn({ ...args, toolLoopGuard }, turnState, (partial) => {
              interrupted.partial = partial
            })
          },
          {
            policy: args.modelRetry,
            phase: 'query',
            turn: null,
            abortSignal: args.toolContext.abortSignal,
            hasVisibleOutput: () => !!activeTurnState?.hasVisibleOutput || (!!args.modelRetry && !!activeTurnState?.hasReasoningOutput),
            hasToolUse: () => !!activeTurnState?.hasToolUse,
            onRetry: (error, attempt) => {
              args.onModelRequestRetry?.(error, attempt)
              args.events?.emitRuntime(
                ChatRuntimeEvents.reconnecting(attempt, MaxConnectionRetryAttempts)
              )
            },
          }
        )
        return preservedText ? { ...result, text: `${preservedText}${result.text}` } : result
      } catch (error) {
        if (!(args.modelRetry?.allowPartialContinuation ?? true)) throw error
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
    const toolLoopGuard = args.toolLoopGuard ?? new KernelToolLoopGuard()
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
    const requestAbortScope = createLinkedAbortScope(args.toolContext.abortSignal)
    let didLogTurnEnd = false
    let providerTurnReducer: ProviderTurnEventReducer | undefined
    this.log.info('model query turn start', {
      turn: toNullable(args.turn),
      model: args.model,
    })

    try {
      requestAbortScope.signal.throwIfAborted()
      // 注意力路由内置常开，历史里随时可能出现 recall 句柄，context:recall 必须恒定可用。
      const providerToolNamePlan = this.turnRequestHelper.resolveProviderToolNamePlan(
        args.history,
        args.allowedTools ? [...args.allowedTools, 'context:recall'] : args.allowedTools
      )
      const providerToolNames = providerToolNamePlan.providerToolNames ?? []
      const aiTools = toolRegistry.toAiTools(args.toolContext, providerToolNames, {
        toolSchemaChars: args.toolSchemaChars,
        historyToolNames: providerToolNamePlan.historyToolNames,
      })
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
      const compiledRequest = await compileProviderSendRequest(
        {
          sessionId: resolveGovernanceSessionKey(args.toolContext.sessionId),
          governanceSessionId: toOptional(args.governanceSessionId),
          rawHistoryMessages: args.history,
          phase: 'query',
          turn: null,
          payloadStore: args.toolContext.contextPayloadStore,
          toolContext: args.toolContext,
          model: args.model,
          systemPrompt: args.systemPrompt,
          toolSchemaChars,
          toolSchemaHashes,
          providerTools,
          availableToolNames: providerAvailableToolNames,
          toolNameAliases: providerRequestToolNameAliases,
          activeTask: contextWorkingSetInputs.activeTask,
          pinnedEvidence: contextWorkingSetInputs.pinnedEvidence,
          contextWindow: args.contextWindow ?? args.contextUsageOptions?.contextWindow,
          contextUsageOptions: resolveModelContextUsageOptions(args.contextUsageOptions, args.modelRequestOptions),
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
      assertModelInputCompatibility({
        messages: compiledRequest.messages,
        supportedInputModalities: args.supportedInputModalities,
        model: args.model,
      })
      this.turnRequestHelper.assertProviderRequestAllowed(compiledRequest, args.turn)
      assertProviderRequestSnapshotReconstructable(compiledRequest.providerRequest)
      providerTurnReducer = new ProviderTurnEventReducer({
        turnId: buildProviderTurnId(
          resolveGovernanceSessionKey(args.toolContext.sessionId),
          'query',
          args.turn
        ),
      })
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
        sessionId: resolveGovernanceSessionKey(args.toolContext.sessionId),
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

      const executor = new ToolExecutor(
        args.toolContext,
        createQueryTurnToolExecutorEvents(args.events),
        executionPolicy,
        {
          providerTurnReducer,
          loopGuard: toolLoopGuard,
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
          abortSignal: requestAbortScope.signal,
          executor,
          events: createQueryTurnStreamConsumerEvents(args.events, !!args.streamTextDeltas),
          idleStallTimeoutMs: toOptional(args.idleStallTimeoutMs),
          model: args.model,
          contextPressure: {
            percent: compiledRequest.estimate.percent,
            usableContextWindow: compiledRequest.estimate.usableContextWindow,
          },
          requestFingerprint: compiledRequest.requestFingerprint,
          providerToCanonicalToolNames: toolTransportPlan.providerToCanonical,
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
        predictedInputTokens: compiledRequest.estimate.estimatedTokens,
        // 观测富化（#37 阶段 C 片 2）：与 StreamTurnResult 同款，StreamConsumer 从 stream
        // diagnostics + 请求指纹写入 turnState，此处原样回传。
        outputTokens: toNullable(turnState.outputTokens),
        costUsd: toNullable(turnState.costUsd),
        reasoningTokens: toNullable(turnState.reasoningTokens),
        cacheReadInputTokens: toNullable(turnState.cacheReadInputTokens),
        cacheWriteInputTokens: toNullable(turnState.cacheWriteInputTokens),
        finishReason: toNullable(turnState.finishReason),
        requestFingerprint: toNullable(turnState.requestFingerprint),
        providerRequestSnapshot: compiledRequest.providerRequest,
      }
    } catch (error) {
      requestAbortScope.abort(error)
      if (isContextOverflowError(error) && (turnState.hasVisibleOutput || turnState.hasToolUse)) {
        markContextOverflowReplayUnsafe(error, {
          hasVisibleOutput: turnState.hasVisibleOutput,
          hasToolUse: turnState.hasToolUse,
        })
      }
      if (!didLogTurnEnd) {
        this.log.info('model query turn end', {
          turn: toNullable(args.turn),
          status: 'error',
          durationMs: Date.now() - startedAt,
        })
      }
      this.emitProviderTurnSnapshot(args, providerTurnReducer, { requirePendingTools: true })
      throw error
    } finally {
      requestAbortScope.dispose()
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
