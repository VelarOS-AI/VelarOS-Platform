import type { ModelMessage } from 'ai'

import { isBlank, isEmpty, isNumber, isPresent, isString,isTrue } from '@velaros-ai/core'
import type { ToolCategoryId } from '@velaros-ai/core/types'
import {
  ContextOverflowRecoveryTargetPercent,
  DefaultContextSafetyMarginPercent,
  resolveReservedOutputTokens,
} from '@velaros-ai/core/utils/contextBudget'
import {
  ContextUsageCompactionPercent,
  type ContextUsageEstimate,
  ContextUsageSemanticPreSummaryPercent,
  type EstimateContextUsageOptions,
} from '@velaros-ai/core/utils/contextUsage'

import { SemanticPreSummaryCache } from './history/SemanticPreSummaryCache'
import { contextEvidenceLedger } from './ContextEvidenceLedger'
import { contextRetrievalPlanner } from './ContextRetrievalPlanner'
import { ContextUsageCalibrator } from './ContextUsageCalibrator'
import {
  type AgentHistoryHelper,
  type AgentHistoryToolContext,
  type HistoryCompactionPolicy,
  type HistoryCompactionResult,
} from './history'

/**
 * 语义级压缩触发水位：本地最大回收后仍达到发送门槛，才花一次模型请求升级为语义摘要。
 */
const SemanticCompactionTriggerPercent = ContextUsageCompactionPercent

/**
 * 语义压缩"无进展冷却"释放阈值（消息条数）。
 *
 * 当某次语义压缩没腾出空间（典型：最近若干轮原文本身过大，较老内容已无可折叠），
 * 若不设防，用量仍 >= 70% 会导致**每轮都白调一次摘要模型且毫无进展**——纯烧钱。
 * 因此记录"无进展时的历史长度"，只有历史又增长了至少这么多条消息（说明产生了新的
 * 可折叠较老内容）才允许再次尝试，把成本封顶在"有新料才重试"。
 */
const SemanticStallReleaseMessageDelta = 6

/** 预测式压缩：上一轮用量与常规阈值差距小于该值时才考虑提前压缩。 */
const PredictiveLookaheadMarginPercent = 12
/** 预测式压缩阈值前移后的下限，避免提前到过低水位反复压缩。 */
const MinPredictiveTriggerPercent = 55
/** 逐轮用量增速 EMA 学习率。 */
const UsageGrowthEmaRate = 0.5
/** 长 solo 执行进入多轮后，过长首轮任务提示不应一直原样随每轮请求重复发送。 */
const SoloLongTaskAnchorCompactionTurn = 6
const SoloLongTaskAnchorMinChars = 4_000
const SoloLongTaskAnchorMinMessages = 6
const SoloLongTaskAnchorTargetPercent = 1
const RuleCompactionStallReleaseMessageDelta = 6
const DefaultAgentContextWindow = 128_000

interface AgentLoopLogger {
  debug?(message: string, details?: Record<string, unknown>): void
  info(message: string, details?: Record<string, unknown>): void
  warn(message: string, details?: Record<string, unknown>): void
}

interface AgentLoopContextCompactionPayload {
  turn: number
  estimatedTokensBefore: number
  estimatedTokensAfter: number
  percentBefore: number
  percentAfter: number
  removedMessages: number
  passes: number
  targetPercent: number
}

interface AgentLoopRuntime<TEvents> {
  emitContextCompaction(payload: AgentLoopContextCompactionPayload, events: TEvents): void
}

interface AgentLoopToolDescriptor {
  name: string
  description: string
  categoryId?: LooseOptional<ToolCategoryId>
}

interface AgentLoopToolRegistry<TToolContext> {
  listAvailable(toolContext: TToolContext, allowedTools: string[]): AgentLoopToolDescriptor[]
  /**
   * 可选实现：返回当前可见工具集 JSON Schema 总字节数（含 name/description/wrapper）。
   * 提供时 LoopHistory 用它精确扣留上下文预算；缺省时回落到 `tools.length * 800` 启发值。
   */
  estimateToolsSerializedChars?(toolContext: TToolContext, allowedTools: string[]): number
}

interface PrepareAgentLoopHistoryArgs<TEvents, TToolContext extends AgentHistoryToolContext> {
  mode: 'query' | 'solo'
  model: string
  systemPrompt: string
  history: ModelMessage[]
  turn: number
  events?: TEvents
  contextUsageOptions: EstimateContextUsageOptions
  toolContext: TToolContext
}

interface PrepareAgentLoopHistoryResult {
  /**
   * 本轮发送前对上下文用量的估算（压缩后若发生压缩则为压缩后的值）。
   * 调用方在拿到供应方真实用量后用它喂给校准器（MMU 反馈）。
   */
  estimate: ContextUsageEstimate
  /** 75% 语义预摘要提示：本地规则压缩尚未触发，但已接近 80% 自动压缩阈值。 */
  semanticPreSummaryArmed?: boolean
}

interface EmergencyCompactArgs<TEvents> {
  mode: 'query' | 'solo'
  model: string
  systemPrompt: string
  history: ModelMessage[]
  turn: number
  events?: TEvents
  contextUsageOptions: EstimateContextUsageOptions
  /**
   * 降级阶梯指定的历史压缩级别参考值。当前 compactHistory 会最大化回收，
   * 该值仅作为兼容字段随结果/日志保留，不再作为“压到某百分比即停止”的目标。
   */
  targetPercent?: LooseOptional<number>
}

interface DropHistoryToFallbackArgs {
  mode: 'query' | 'solo'
  history: ModelMessage[]
  turn: number
}

interface DropHistoryToFallbackResult {
  /** 是否真正缩短了历史。false 表示历史已是最小集，无法再丢。 */
  dropped: boolean
  removedMessages: number
}

/**
 * 语义摘要回调：把较老消息压成结构化摘要正文（不含 marker），失败/为空时返回 null。
 * 由调用方用其已解析的 provider 现场构造（见 ContextSemanticSummarizer）。
 */
interface SemanticHistorySummarizeFn {
  (input: {
    olderMessages: ModelMessage[]
    ruleSummary: Nullable<string>
    summaryGuidance?: readonly string[]
    targetChars: number
    signal?: LooseOptional<AbortSignal>
  }): Promise<Nullable<string>>
}

interface SemanticCompactArgs<TEvents> {
  mode: 'query' | 'solo'
  model: string
  systemPrompt: string
  history: ModelMessage[]
  turn: number
  events?: TEvents
  contextUsageOptions: EstimateContextUsageOptions
  summarize: SemanticHistorySummarizeFn
  summaryGuidance?: readonly string[]
  signal?: LooseOptional<AbortSignal>
  /** 仅写入预摘要缓存，不修改 history、不 emit compaction。 */
  cacheOnly?: boolean
}

interface SemanticCompactResult {
  /** 是否真正用语义摘要替换了较老历史并腾出空间。 */
  compacted: boolean
  estimatedTokensBefore: number
  estimatedTokensAfter: number
  percentBefore: number
  percentAfter: number
  removedMessages: number
}

interface EmergencyCompactResult {
  /** 是否真正腾出了空间（历史被压缩）。false 表示无法再压缩，调用方应放弃重试。 */
  recovered: boolean
  estimatedTokensBefore: number
  estimatedTokensAfter: number
  percentBefore: number
  percentAfter: number
  removedMessages: number
}

class AgentLoopHistoryManager<TEvents, TToolContext extends AgentHistoryToolContext> {
  /**
   * MMU 校准器：跨轮、按模型学习“估算↔真实”偏差。
   * 由本管理器持有；SoloLoop/QueryLoop 在 Runtime 中各构造一次后长期复用，因此学习可跨请求累积。
   */
  private readonly calibrator = new ContextUsageCalibrator()

  /**
   * 预测式回收（proactive reclamation）状态：跟踪上一轮压缩前用量百分比与其逐轮增速 EMA。
   * 当“上一轮已接近水位 + 增速陡峭 → 预计下一轮将越过常规压缩阈值”时，本轮提前压缩，
   * 避免恰好撞墙触发缺页。无历史/无增长时不介入，保持既有行为。
   */
  /** 语义压缩上次"无进展"时的历史长度；非 null 表示处于冷却,直到历史增长足够才解冻。 */
  private semanticStallAtHistoryLength: Nullable<number> = null
  private ruleCompactionStallAtHistoryLength: Nullable<number> = null
  private consecutiveIneffectiveRuleCompactions = 0
  private readonly semanticPreSummaryCache = new SemanticPreSummaryCache()
  private semanticPreSummaryInFlightHash: Nullable<string> = null
  private lastUsagePercent: Nullable<number> = null
  private usageGrowthEma = 0

  constructor(
    private readonly historyHelper: AgentHistoryHelper,
    private readonly runtimeHelper: AgentLoopRuntime<TEvents>,
    private readonly toolRegistry: AgentLoopToolRegistry<TToolContext>,
    private readonly log: AgentLoopLogger
  ) {}

  public prepareHistory(
    args: PrepareAgentLoopHistoryArgs<TEvents, TToolContext>
  ): PrepareAgentLoopHistoryResult {
    const originalHistory = [...args.history]
    // 这里只做结构性清洗（孤儿 tool-call/result 配对修复）；per-message 截断/预算交给 streamText 调用前的
    // sanitizeHistoryForProvider 一次完成，避免每个 turn 双重 sanitize 同一份消息体。
    const sanitization = this.historyHelper.sanitizeHistory(
      args.history,
      undefined,
      { skipPerMessageBudget: true }
    )
    if (sanitization.removedMessages > 0 || sanitization.changedMessages > 0) {
      args.history.splice(0, args.history.length, ...sanitization.history)
      const details = {
        mode: args.mode,
        turn: args.turn,
        removedMessages: sanitization.removedMessages,
        changedMessages: sanitization.changedMessages,
        issues: sanitization.issues,
        remainingMessages: args.history.length,
      }
      const hasStructuralIssues = !isEmpty(sanitization.issues) || sanitization.removedMessages > 0
      if (hasStructuralIssues) {
        this.log.warn('history sanitized', details)
      } else {
        this.log.debug?.('history sanitized', details)
      }
    }

    this.ensureNonEmptyHistory(args.history, originalHistory, args.mode, args.turn)

    const skipConversationCompaction = isTrue(args.toolContext.contextViewActive)
    const proactiveSoloCompaction = !skipConversationCompaction && this.shouldProactivelyCompactLongSoloTaskAnchor(args)
    const predictiveTrigger = skipConversationCompaction ? null : this.resolvePredictiveCompactionTrigger()
    const compactionPolicy: HistoryCompactionPolicy = proactiveSoloCompaction
      ? {
          triggerPercent: 0,
          targetPercent: SoloLongTaskAnchorTargetPercent,
        }
      : isNumber(predictiveTrigger)
        ? { triggerPercent: predictiveTrigger }
        : {}
    const ruleCompactionPaused =
      !skipConversationCompaction && this.isRuleCompactionPaused(args.history.length)
    const compaction = skipConversationCompaction || ruleCompactionPaused
      ? this.buildNoopCompactionResult(args, compactionPolicy)
      : this.historyHelper.compactHistory(
          args.model,
          args.systemPrompt,
          args.history,
          args.contextUsageOptions,
          compactionPolicy
        )
    this.updateUsageGrowthTracker(compaction.estimatedBefore.percent)
    if (!skipConversationCompaction && !ruleCompactionPaused) {
      this.recordRuleCompactionEffect(compaction, args)
    }
    if (compaction.compacted) {
      args.history.splice(0, args.history.length, ...compaction.history)
      this.rehydrateCompactedHistory(args)
      if (args.events) {
        this.runtimeHelper.emitContextCompaction(
          {
            turn: args.turn,
            estimatedTokensBefore: compaction.estimatedBefore.estimatedTokens,
            estimatedTokensAfter: compaction.estimatedAfter.estimatedTokens,
            percentBefore: compaction.estimatedBefore.percent,
            percentAfter: compaction.estimatedAfter.percent,
            removedMessages: compaction.removedMessages,
            passes: compaction.passes,
            targetPercent: compaction.targetPercent,
          },
          args.events
        )
      }
      this.log.warn('history compacted', {
        mode: args.mode,
        turn: args.turn,
        removedMessages: compaction.removedMessages,
        passes: compaction.passes,
        keptRecentTurns: compaction.keptRecentTurns,
        estimatedTokensBefore: compaction.estimatedBefore.estimatedTokens,
        estimatedTokensAfter: compaction.estimatedAfter.estimatedTokens,
        percentBefore: compaction.estimatedBefore.percent,
        percentAfter: compaction.estimatedAfter.percent,
        targetPercent: compaction.targetPercent,
      })
      this.ensureNonEmptyHistory(args.history, originalHistory, args.mode, args.turn)
      return {
        estimate: compaction.estimatedAfter,
        semanticPreSummaryArmed: this.shouldArmSemanticPreSummary(compaction.estimatedAfter.percent),
      }
    }

    if (compaction.estimatedBefore.percent >= this.historyHelper.getHighWatermarkPercent()) {
      this.log.info('context usage high', {
        mode: args.mode,
        turn: args.turn,
        estimatedTokens: compaction.estimatedBefore.estimatedTokens,
        estimatedChars: compaction.estimatedBefore.estimatedChars,
        contextWindow: compaction.estimatedBefore.contextWindow,
        usableContextWindow: compaction.estimatedBefore.usableContextWindow,
        reservedOutputTokens: compaction.estimatedBefore.reservedOutputTokens,
        percent: compaction.estimatedBefore.percent,
        tokenPercent: compaction.estimatedBefore.tokenPercent,
        payloadPercent: compaction.estimatedBefore.payloadPercent,
        historyMessages: args.history.length,
      })
    }

    return {
      estimate: compaction.estimatedBefore,
      semanticPreSummaryArmed: this.shouldArmSemanticPreSummary(compaction.estimatedBefore.percent),
    }
  }

  private buildNoopCompactionResult(
    args: PrepareAgentLoopHistoryArgs<TEvents, TToolContext>,
    policy: HistoryCompactionPolicy = {}
  ): HistoryCompactionResult {
    const estimate = this.historyHelper.estimateContextUsage(
      args.model,
      args.systemPrompt,
      args.history,
      args.contextUsageOptions
    )

    return {
      compacted: false,
      history: args.history,
      estimatedBefore: estimate,
      estimatedAfter: estimate,
      removedMessages: 0,
      passes: 0,
      keptRecentTurns: 0,
      targetPercent: policy.targetPercent ?? policy.triggerPercent ?? ContextUsageCompactionPercent,
    }
  }

  private resetRuleCompactionStall(): void {
    this.ruleCompactionStallAtHistoryLength = null
    this.consecutiveIneffectiveRuleCompactions = 0
  }

  private isRuleCompactionPaused(historyLength: number): boolean {
    const stalledAt = this.ruleCompactionStallAtHistoryLength
    if (!isNumber(stalledAt)) return false

    if (historyLength > stalledAt + RuleCompactionStallReleaseMessageDelta) {
      this.resetRuleCompactionStall()
      return false
    }

    return true
  }

  private recordRuleCompactionEffect(
    compaction: HistoryCompactionResult,
    args: PrepareAgentLoopHistoryArgs<TEvents, TToolContext>
  ): void {
    if (!compaction.compacted) {
      if (compaction.estimatedBefore.percent < ContextUsageCompactionPercent) {
        this.resetRuleCompactionStall()
      }
      return
    }

    if (compaction.estimatedAfter.percent < ContextUsageCompactionPercent) {
      this.resetRuleCompactionStall()
      return
    }

    this.consecutiveIneffectiveRuleCompactions += 1
    if (
      this.consecutiveIneffectiveRuleCompactions < 2 ||
      isNumber(this.ruleCompactionStallAtHistoryLength)
    ) return

    this.ruleCompactionStallAtHistoryLength = args.history.length
    this.log.warn('rule compaction paused after repeated ineffective compactions', {
      mode: args.mode,
      turn: args.turn,
      historyMessages: args.history.length,
      percentBefore: compaction.estimatedBefore.percent,
      percentAfter: compaction.estimatedAfter.percent,
      triggerPercent: ContextUsageCompactionPercent,
      releaseAfterNewMessages: RuleCompactionStallReleaseMessageDelta,
    })
  }

  /** 75% 异步语义预摘要提示：尚未到 80% 同步压缩，但已接近阈值。 */
  public shouldArmSemanticPreSummary(currentPercent: number): boolean {
    return (
      isNumber(currentPercent) &&
      currentPercent >= ContextUsageSemanticPreSummaryPercent &&
      currentPercent < ContextUsageCompactionPercent
    )
  }

  public hasSemanticPreSummaryCache(history: readonly ModelMessage[]): boolean {
    const hash = this.semanticPreSummaryCache.buildHistoryHash(history)
    return !!this.semanticPreSummaryCache.get(hash)
  }

  /**
   * 75% 异步预摘要：后台跑 semanticCompact 并写入跨轮缓存，供 80% 同步路径复用。
   */
  public async warmSemanticPreSummary(args: SemanticCompactArgs<TEvents>): Promise<void> {
    const historyHash = this.semanticPreSummaryCache.buildHistoryHash(args.history)
    if (
      this.semanticPreSummaryCache.get(historyHash) ||
      this.semanticPreSummaryInFlightHash === historyHash
    ) return

    this.semanticPreSummaryInFlightHash = historyHash
    try {
      await this.semanticCompact({
        ...args,
        cacheOnly: true,
        events: undefined,
      })
    } finally {
      if (this.semanticPreSummaryInFlightHash === historyHash) {
        this.semanticPreSummaryInFlightHash = null
      }
    }
  }

  private tryApplyCachedSemanticCompaction(
    args: SemanticCompactArgs<TEvents>,
    plan: NonNullable<ReturnType<AgentHistoryHelper['resolveSemanticCompactionPlan']>>
  ): Nullable<SemanticCompactResult> {
    const historyHash = this.semanticPreSummaryCache.buildHistoryHash(args.history)
    const cachedHistory = this.semanticPreSummaryCache.get(historyHash)
    if (!cachedHistory) return null

    const estimatedAfter = this.historyHelper.estimateContextUsage(
      args.model,
      args.systemPrompt,
      cachedHistory,
      args.contextUsageOptions
    )
    if (estimatedAfter.estimatedTokens >= plan.estimatedBefore.estimatedTokens) {
      this.semanticPreSummaryCache.clear()
      return null
    }

    if (args.cacheOnly) return {
        compacted: true,
        estimatedTokensBefore: plan.estimatedBefore.estimatedTokens,
        estimatedTokensAfter: estimatedAfter.estimatedTokens,
        percentBefore: plan.estimatedBefore.percent,
        percentAfter: estimatedAfter.percent,
        removedMessages: plan.olderMessages.length,
      }

    this.semanticStallAtHistoryLength = null
    const originalHistory = [...args.history]
    args.history.splice(0, args.history.length, ...cachedHistory)
    this.ensureNonEmptyHistory(args.history, originalHistory, args.mode, args.turn)
    if (args.events) {
      this.runtimeHelper.emitContextCompaction(
        {
          turn: args.turn,
          estimatedTokensBefore: plan.estimatedBefore.estimatedTokens,
          estimatedTokensAfter: estimatedAfter.estimatedTokens,
          percentBefore: plan.estimatedBefore.percent,
          percentAfter: estimatedAfter.percent,
          removedMessages: plan.olderMessages.length,
          passes: 1,
          targetPercent: estimatedAfter.percent,
        },
        args.events
      )
    }
    this.log.info('semantic compaction applied from pre-summary cache', {
      mode: args.mode,
      turn: args.turn,
      removedMessages: plan.olderMessages.length,
    })

    return {
      compacted: true,
      estimatedTokensBefore: plan.estimatedBefore.estimatedTokens,
      estimatedTokensAfter: estimatedAfter.estimatedTokens,
      percentBefore: plan.estimatedBefore.percent,
      percentAfter: estimatedAfter.percent,
      removedMessages: plan.olderMessages.length,
    }
  }

  private rehydrateCompactedHistory(
    args: PrepareAgentLoopHistoryArgs<TEvents, TToolContext>
  ): void {
    const evidenceRecords = args.toolContext.evidenceLedger
    if (evidenceRecords && !isEmpty(evidenceRecords)) {
      const selected = contextEvidenceLedger.selectCompactionEvidence([...evidenceRecords])
      const rehydrated = contextEvidenceLedger.injectPinnedEvidenceMessage(args.history, selected)
      args.history.splice(0, args.history.length, ...rehydrated)
    }

    const sessionId = args.toolContext.sessionId?.trim()
    if (sessionId) {
      const handles = contextRetrievalPlanner.buildHandlesFromModelHistory({
        sessionId,
        messages: args.history,
      })
      const withHandles = contextRetrievalPlanner.injectRetrievalIndex(args.history, handles)
      args.history.splice(0, args.history.length, ...withHandles)
    }
  }

  /**
   * 缺页中断处理：在模型因上下文超限报错后，强制对历史做一次激进压缩（目标 ~60%），
   * 不论当前估算水位是否达标。腾出空间后由调用方原样重试本轮请求。
   * 返回 recovered=false 表示已无可压缩内容（如仅剩最近两轮且本身超大），调用方应放弃重试。
   */
  public emergencyCompact(
    args: EmergencyCompactArgs<TEvents>
  ): EmergencyCompactResult {
    const originalHistory = [...args.history]
    const compaction = this.historyHelper.compactHistory(
      args.model,
      args.systemPrompt,
      args.history,
      args.contextUsageOptions,
      {
        // triggerPercent=0：无视常规水位，强制压缩。
        triggerPercent: 0,
        targetPercent: isNumber(args.targetPercent)
          ? args.targetPercent
          : ContextOverflowRecoveryTargetPercent,
        minRecentConversationsToKeep: 0,
      }
    )

    if (!compaction.compacted) return {
        recovered: false,
        estimatedTokensBefore: compaction.estimatedBefore.estimatedTokens,
        estimatedTokensAfter: compaction.estimatedAfter.estimatedTokens,
        percentBefore: compaction.estimatedBefore.percent,
        percentAfter: compaction.estimatedAfter.percent,
        removedMessages: 0,
      }

    args.history.splice(0, args.history.length, ...compaction.history)
    this.ensureNonEmptyHistory(args.history, originalHistory, args.mode, args.turn)
    if (args.events) {
      this.runtimeHelper.emitContextCompaction(
        {
          turn: args.turn,
          estimatedTokensBefore: compaction.estimatedBefore.estimatedTokens,
          estimatedTokensAfter: compaction.estimatedAfter.estimatedTokens,
          percentBefore: compaction.estimatedBefore.percent,
          percentAfter: compaction.estimatedAfter.percent,
          removedMessages: compaction.removedMessages,
          passes: compaction.passes,
          targetPercent: compaction.targetPercent,
        },
        args.events
      )
    }
    this.log.warn('context overflow emergency compaction', {
      mode: args.mode,
      turn: args.turn,
      removedMessages: compaction.removedMessages,
      passes: compaction.passes,
      estimatedTokensBefore: compaction.estimatedBefore.estimatedTokens,
      estimatedTokensAfter: compaction.estimatedAfter.estimatedTokens,
      percentBefore: compaction.estimatedBefore.percent,
      percentAfter: compaction.estimatedAfter.percent,
    })

    return {
      recovered: true,
      estimatedTokensBefore: compaction.estimatedBefore.estimatedTokens,
      estimatedTokensAfter: compaction.estimatedAfter.estimatedTokens,
      percentBefore: compaction.estimatedBefore.percent,
      percentAfter: compaction.estimatedAfter.percent,
      removedMessages: compaction.removedMessages,
    }
  }

  /**
   * 降级阶梯末端动作：把历史压到“仅保留最近用户消息”的兜底集。
   * 当应急压缩仍无法腾出空间时使用——相当于 OOM killer 杀掉除必要工作集外的一切。
   */
  public dropHistoryToFallback(
    args: DropHistoryToFallbackArgs
  ): DropHistoryToFallbackResult {
    const before = args.history.length
    const fallback = this.historyHelper.buildFallbackHistory(args.history)
    if (fallback.length >= before) return { dropped: false, removedMessages: 0 }

    args.history.splice(0, args.history.length, ...fallback)
    this.log.warn('context overflow dropped history to fallback', {
      mode: args.mode,
      turn: args.turn,
      removedMessages: before - args.history.length,
      remainingMessages: args.history.length,
    })
    return { dropped: true, removedMessages: before - args.history.length }
  }

  /** 规则压缩后用量仍达到该水位才值得花一次模型调用做语义压缩。 */
  public getSemanticCompactionTriggerPercent(): number {
    return SemanticCompactionTriggerPercent
  }

  /**
   * 是否值得尝试一次语义压缩。除了水位门槛,还带"无进展冷却":上次白调过且历史尚未
   * 增长出足够新的可折叠内容时,直接跳过,避免每轮空烧摘要模型。
   */
  public shouldAttemptSemanticCompaction(currentPercent: number, historyLength: number): boolean {
    if (!isNumber(currentPercent) || currentPercent < SemanticCompactionTriggerPercent) return false

    if (isNumber(this.semanticStallAtHistoryLength)) {
      // 历史相比"上次无进展时"增长不足,说明没有新的较老内容可折叠,继续冷却。
      if (historyLength <= this.semanticStallAtHistoryLength + SemanticStallReleaseMessageDelta) return false
    }

    return true
  }

  /**
   * 多级压缩第二级：用一次模型调用把较老历史压成语义摘要，替换规则摘要 + 较老原文。
   * 仅在调用方判断“规则压缩仍不够”或缺页降级到该档时调用；失败/无收益时原样返回 false。
   */
  public async semanticCompact(
    args: SemanticCompactArgs<TEvents>
  ): Promise<SemanticCompactResult> {
    const plan = this.historyHelper.resolveSemanticCompactionPlan(
      args.model,
      args.systemPrompt,
      args.history,
      args.contextUsageOptions,
      0,
    )
    const noop = (): SemanticCompactResult => ({
      compacted: false,
      estimatedTokensBefore: plan?.estimatedBefore.estimatedTokens ?? 0,
      estimatedTokensAfter: plan?.estimatedBefore.estimatedTokens ?? 0,
      percentBefore: plan?.estimatedBefore.percent ?? 0,
      percentAfter: plan?.estimatedBefore.percent ?? 0,
      removedMessages: 0,
    })
    if (!plan) {
      // 无可折叠较老内容：进入冷却,等历史增长出新料再试。
      this.semanticStallAtHistoryLength = args.history.length
      return noop()
    }

    const cachedResult = this.tryApplyCachedSemanticCompaction(args, plan)
    if (cachedResult) return cachedResult

    // 语义摘要正文目标长度：对齐规则摘要的体量（~3200 字符）。
    const summaryBody = await args.summarize({
      olderMessages: plan.olderMessages,
      ruleSummary: plan.ruleSummary,
      summaryGuidance: args.summaryGuidance,
      targetChars: 3_200,
      signal: args.signal,
    })
    if (!isPresent(summaryBody) || isBlank(summaryBody)) {
      // 摘要失败/为空(含模型不可用):进入冷却,避免每轮重复白调。
      this.semanticStallAtHistoryLength = args.history.length
      return noop()
    }
    const semanticValidation = this.historyHelper.validateSemanticSummary(
      plan.ruleSummary,
      summaryBody
    )
    if (!semanticValidation.valid) {
      this.semanticStallAtHistoryLength = args.history.length
      this.log.warn('semantic compaction rejected lossy summary', {
        mode: args.mode,
        turn: args.turn,
        missingAnchors: semanticValidation.missingAnchors,
        anchorCount: semanticValidation.anchors.length,
      })
      return noop()
    }

    const wrapped = this.historyHelper.wrapSemanticSummary(summaryBody)
    const nextHistory = this.historyHelper.assembleSemanticHistory(
      wrapped,
      plan.recentMessages,
      plan.preservedMessages
    )
    const estimatedAfter = this.historyHelper.estimateContextUsage(
      args.model,
      args.systemPrompt,
      nextHistory,
      args.contextUsageOptions
    )
    // 只有确实更小才提交；否则保留规则压缩结果，避免语义摘要反而变大。
    if (estimatedAfter.estimatedTokens >= plan.estimatedBefore.estimatedTokens) {
      // 调了但没收益(典型:最近轮原文过大):进入冷却。
      this.semanticStallAtHistoryLength = args.history.length
      return noop()
    }

    // 有进展:解除冷却。
    this.semanticStallAtHistoryLength = null
    const originalHistory = [...args.history]
    this.semanticPreSummaryCache.set(
      this.semanticPreSummaryCache.buildHistoryHash(originalHistory),
      nextHistory
    )
    if (args.cacheOnly) return {
        compacted: true,
        estimatedTokensBefore: plan.estimatedBefore.estimatedTokens,
        estimatedTokensAfter: estimatedAfter.estimatedTokens,
        percentBefore: plan.estimatedBefore.percent,
        percentAfter: estimatedAfter.percent,
        removedMessages: plan.olderMessages.length,
      }

    args.history.splice(0, args.history.length, ...nextHistory)
    this.ensureNonEmptyHistory(args.history, originalHistory, args.mode, args.turn)
    if (args.events) {
      this.runtimeHelper.emitContextCompaction(
        {
          turn: args.turn,
          estimatedTokensBefore: plan.estimatedBefore.estimatedTokens,
          estimatedTokensAfter: estimatedAfter.estimatedTokens,
          percentBefore: plan.estimatedBefore.percent,
          percentAfter: estimatedAfter.percent,
          removedMessages: plan.olderMessages.length,
          passes: 1,
          targetPercent: estimatedAfter.percent,
        },
        args.events
      )
    }
    this.log.warn('semantic compaction applied', {
      mode: args.mode,
      turn: args.turn,
      removedMessages: plan.olderMessages.length,
      estimatedTokensBefore: plan.estimatedBefore.estimatedTokens,
      estimatedTokensAfter: estimatedAfter.estimatedTokens,
      percentBefore: plan.estimatedBefore.percent,
      percentAfter: estimatedAfter.percent,
    })

    return {
      compacted: true,
      estimatedTokensBefore: plan.estimatedBefore.estimatedTokens,
      estimatedTokensAfter: estimatedAfter.estimatedTokens,
      percentBefore: plan.estimatedBefore.percent,
      percentAfter: estimatedAfter.percent,
      removedMessages: plan.olderMessages.length,
    }
  }

  /** 用供应方真实输入 token 更新该模型的校准系数（MMU 反馈闭环）。 */
  public recordActualUsage(
    model: string,
    predictedInputTokens: number,
    actualInputTokens: Nullable<number>
  ): void {
    if (!isNumber(actualInputTokens)) return

    this.calibrator.record(model, predictedInputTokens, actualInputTokens)
  }

  public buildContextUsageOptions(
    model: string,
    toolContext: TToolContext,
    allowedTools: string[],
    contextWindow?: number,
    toolSchemaChars?: Readonly<Record<string, number>>,
    turnToolRegistry: AgentLoopToolRegistry<TToolContext> = this.toolRegistry
  ): EstimateContextUsageOptions {
    const tools = turnToolRegistry.listAvailable(toolContext, allowedTools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      categoryId: tool.categoryId,
    }))
    // 优先用 registry 提供的精确测量（按 zod -> JSON Schema 实测，结果带缓存）；
    // 缺省时回落到旧版 `工具数 × 800` 平均估算，保持兼容。
    const schemaReserveChars =
      this.sumToolSchemaChars(allowedTools, toolSchemaChars) ??
      turnToolRegistry.estimateToolsSerializedChars?.(toolContext, allowedTools) ??
      tools.length * 800
    // 输出预留按“有效窗口”推导：优先用 runtime 解析出的 contextWindow，否则回落模型目录值。
    const effectiveWindow = isNumber(contextWindow)
      ? contextWindow
      : DefaultAgentContextWindow
    const reservedOutputTokens = resolveReservedOutputTokens(effectiveWindow)

    return {
      contextWindow,
      extraContext: {
        tools,
      },
      extraEstimatedChars: schemaReserveChars,
      extraEstimatedTokens: Math.ceil(schemaReserveChars / 4),
      reservedOutputTokens,
      safetyMarginPercent: DefaultContextSafetyMarginPercent,
      calibrationFactor: this.calibrator.getFactor(model),
    }
  }

  private sumToolSchemaChars(
    allowedTools: readonly string[],
    toolSchemaChars?: Readonly<Record<string, number>>
  ): Nullable<number> {
    if (!toolSchemaChars) return null

    let total = 0
    for (const toolName of allowedTools) {
      if (!Object.prototype.hasOwnProperty.call(toolSchemaChars, toolName)) return null
      total += Math.max(0, toolSchemaChars[toolName] ?? 0)
    }

    return total
  }

  /**
   * 据上一轮用量与增速预测本轮是否应提前压缩；返回提前后的触发阈值，或 null（保持默认）。
   * 仅在“上一轮已逼近常规阈值（差距 < PredictiveLookaheadMargin）且按当前增速预计下一轮越过阈值”
   * 时介入，避免在小会话里过度压缩。
   */
  private resolvePredictiveCompactionTrigger(): Nullable<number> {
    const last = this.lastUsagePercent
    if (!isNumber(last) || this.usageGrowthEma <= 0) return null

    if (last < ContextUsageCompactionPercent - PredictiveLookaheadMarginPercent) return null

    if (last + this.usageGrowthEma < ContextUsageCompactionPercent) return null

    // 把触发阈值前移一个增速身位，让本轮就压，而不是等下轮撞阈值。
    return Math.max(
      MinPredictiveTriggerPercent,
      ContextUsageCompactionPercent - Math.ceil(this.usageGrowthEma)
    )
  }

  /** 用本轮压缩前用量更新逐轮增速 EMA（只累计正增长）。 */
  private updateUsageGrowthTracker(currentPercent: number): void {
    if (!isNumber(currentPercent)) return

    if (isNumber(this.lastUsagePercent)) {
      const delta = Math.max(0, currentPercent - this.lastUsagePercent)
      this.usageGrowthEma =
        this.usageGrowthEma * (1 - UsageGrowthEmaRate) + delta * UsageGrowthEmaRate
    }

    this.lastUsagePercent = currentPercent
  }

  private shouldProactivelyCompactLongSoloTaskAnchor(
    args: PrepareAgentLoopHistoryArgs<TEvents, TToolContext>
  ): boolean {
    if (
      args.mode !== 'solo' ||
      args.turn < SoloLongTaskAnchorCompactionTurn ||
      args.history.length < SoloLongTaskAnchorMinMessages
    ) return false

    const firstUser = args.history.find((message) => message.role === 'user')
    return (
      isString(firstUser?.content) &&
      firstUser.content.length >= SoloLongTaskAnchorMinChars
    )
  }

  private ensureNonEmptyHistory(
    history: ModelMessage[],
    originalHistory: ModelMessage[],
    mode: 'query' | 'solo',
    turn: number
  ): void {
    if (!isEmpty(history)) return

    const fallbackHistory = this.historyHelper.buildFallbackHistory(originalHistory)
    history.splice(0, history.length, ...fallbackHistory)
    this.log.warn(`${mode} history unexpectedly empty; fallback restored`, {
      turn,
      fallbackMessages: history.length,
    })
  }
}

export { AgentLoopHistoryManager }
export type {
  AgentLoopContextCompactionPayload,
  AgentLoopLogger,
  AgentLoopRuntime,
  AgentLoopToolDescriptor,
  AgentLoopToolRegistry,
  DropHistoryToFallbackArgs,
  DropHistoryToFallbackResult,
  EmergencyCompactArgs,
  EmergencyCompactResult,
  PrepareAgentLoopHistoryArgs,
  PrepareAgentLoopHistoryResult,
  SemanticCompactArgs,
  SemanticCompactResult,
  SemanticHistorySummarizeFn,
}
