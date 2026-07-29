import type { ModelMessage } from 'ai'

import { isBlank,isEmpty, isFiniteNumber, isPresent } from '@velaros-ai/core'
import {
  ContextUsageCompactionPercent,
  type ContextUsageEstimate,
  ContextUsageHighWatermarkPercent,
  estimateContextUsage,
  type EstimateContextUsageOptions,
} from '@velaros-ai/core/utils/contextUsage'

import {
  CompactionSummaryInstruction,
  CompactionSummaryMarker,
} from './contextOSMessage'
import { isInternalFollowUpMessage } from './internalMessages'
import {
  HistoryMessages,
  type HistoryToolCallReference,
} from './messages'
import { enforceConversationScopedToolResultBudget } from './microCompaction'
import {
  isReplayUnsafeAssistantMessage,
  sanitizeModelHistory,
  type SanitizeModelHistoryOptions,
  sanitizeModelMessage,
} from './sanitize'
import {
  type AgentHistoryTurn,
  HistorySummary,
} from './summary'
import { stripOrphanToolResultParts } from './validate'

interface HistorySanitizationResult {
  history: ModelMessage[]
  removedMessages: number
  changedMessages: number
  issues: HistorySanitizationIssue[]
}

interface HistorySanitizationIssue {
  kind:
    | 'orphan-tool-result'
    | 'unsafe-assistant-message'
    | 'missing-tool-results'
  messageIndex: number
  role: ModelMessage['role']
  removedMessages: number
  reason: string
  toolCallIds?: string[]
  missingToolCallIds?: string[]
}

interface HistoryCompactionResult {
  compacted: boolean
  history: ModelMessage[]
  estimatedBefore: ContextUsageEstimate
  estimatedAfter: ContextUsageEstimate
  removedMessages: number
  passes: number
  keptRecentTurns: number
  /** 已压缩时表示实际压缩后的 percent；未压缩时保留触发策略的参考目标。 */
  targetPercent: number
}

interface HistoryCompactionCandidate {
  history: ModelMessage[]
  estimatedAfter: ContextUsageEstimate
  keptRecentTurns: number
}

interface HistoryReclaimCandidate {
  history: ModelMessage[]
  estimatedAfter: ContextUsageEstimate
}

const InterruptedToolResultValue =
  '[no result: the previous turn was interrupted before this tool call completed]'

interface HistoryCompactionPolicy {
  triggerPercent?: LooseOptional<number>
  /** 兼容缺页降级调用的策略字段；最大回收算法不会以该值作为停止条件。 */
  targetPercent?: LooseOptional<number>
  /**
   * 至少保留的最近外部 conversation 数。默认 2；缺页/仅 1–2 轮且仍超阈值时可放宽至 1 或 0。
   */
  minRecentConversationsToKeep?: LooseOptional<number>
}

interface SemanticCompactionPlan {
  /** 待折叠的较老历史消息（已剔除既有压缩摘要消息）。 */
  olderMessages: ModelMessage[]
  /** 不再交给语义摘要器二次改写的稳定保留层。 */
  preservedMessages: ModelMessage[]
  /** 需保留的最近若干轮原文消息。 */
  recentMessages: ModelMessage[]
  /** 规则式摘要（作为语义摘要的种子/兜底）。 */
  ruleSummary: Nullable<string>
  keptRecentTurns: number
  estimatedBefore: ContextUsageEstimate
}

interface SemanticSummaryValidationResult {
  valid: boolean
  anchors: string[]
  missingAnchors: string[]
}

const MaxSemanticSummaryAnchors = 16
const FileAnchorPattern =
  /\b[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|toml|yaml|yml|sql|py|rb|go|rs|java|kt|swift|sh)\b/g
const CommandAnchorPatterns = [
  /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?[A-Za-z0-9_./:-]+(?:\s+[A-Za-z0-9_./:=@-]+){0,5}/g,
  /\b(?:pytest|jest|vitest|tsc|cargo\s+test|go\s+test)\b(?:\s+[A-Za-z0-9_./:=@-]+){0,5}/g,
]
const CommandAnchorStopWords = new Set([
  'and',
  'or',
  'then',
  'as',
  'with',
  'before',
  'after',
  'passed',
  'failed',
  'success',
  'succeeded',
  'timed',
  'timeout',
  'it',
  'was',
  'were',
  'is',
  'in',
  'for',
])

/**
 * 历史辅助器：模型消息历史的“清洗 + 压缩”双层保险。
 *
 * 设计动机：
 * - 不同模型供应方对历史结构的容忍度不同，
 *   清洗流程负责修复工具调用与工具结果配对错乱、回放不安全的推理段、
 *   以及超长二进制内容；这一步是请求模型前的强制前置。
 * - 当估算的上下文使用率超过 `ContextUsageCompactionPercent` 时，
 *   先把旧工具结果替换成可检索引用；若仍超阈值，再将较老 conversation 折叠成压缩摘要系统消息。
 *   折叠时默认保留最近两个外部用户 conversation 原文；仅 1–2 轮且仍超阈值时可放宽至 1 或 0。
 *
 * 整轮流程：
 *   清洗历史 → 估算上下文用量 → 免费工具结果回收 → 必要时折叠旧 conversation
 *   → 由调用方更新历史引用。
 *
 * 与外部协作：
 * - 智能体运行时辅助器在每个轮次开始前调用压缩流程；
 * - 流式循环和查询循环在流失败或检测到非法结构时调用清洗流程。
 */
class HistoryHelper {
  /** 触发压缩的上限百分比，达到该值开始压缩。 */
  private readonly highWatermarkPercent = ContextUsageHighWatermarkPercent
  /** 历史压缩触发水位；触发后会最大化回收，而不是压到某个固定目标即停止。 */
  private readonly compactionPercent = ContextUsageCompactionPercent
  /**
   * 至少保留的最近外部 conversation 数。conversation 以真实用户消息为边界，
   * legacy/internal follow-up 不单独计数，避免一次用户会话中的内部续跑挤掉真实上下文。
   */
  private readonly minRecentConversationsToKeep = 2
  private readonly messageHelper = new HistoryMessages()
  private readonly summaryHelper = new HistorySummary(this.messageHelper)

  public estimateContextUsage(
    model: string,
    systemPrompt: string,
    history: ModelMessage[],
    options: EstimateContextUsageOptions = {},
  ): ContextUsageEstimate {
    return estimateContextUsage(model, systemPrompt, history, options)
  }

  public getHighWatermarkPercent(): number {
    return this.highWatermarkPercent
  }

  public getCompactionTargetPercent(): number {
    return this.compactionPercent
  }

  public sanitizeHistory(
    history: ModelMessage[],
    options?: SanitizeModelHistoryOptions,
    flags?: { skipPerMessageBudget?: boolean },
  ): HistorySanitizationResult {
    const sanitized: ModelMessage[] = []
    let removedMessages = 0
    let changedMessages = 0
    const issues: HistorySanitizationIssue[] = []
    let stableLength = 0
    const pushSanitized = (message: ModelMessage): void => {
      const result = sanitizeModelMessage(message, {
        skipToolResultBudget: flags?.skipPerMessageBudget,
      })
      if (result.changed) {
        changedMessages += 1
      }
      sanitized.push(result.message)
    }

    for (let index = 0; index < history.length; index += 1) {
      const message = history[index]
      if (message.role === 'user') {
        pushSanitized(message)
        stableLength = sanitized.length
        continue
      }

      if (message.role === 'tool') {
        removedMessages += 1
        issues.push({
          kind: 'orphan-tool-result',
          messageIndex: index,
          role: message.role,
          removedMessages: 1,
          reason: 'tool result message appeared without a preceding assistant tool-call group',
          toolCallIds: this.messageHelper.extractToolResultIds(message),
        })
        continue
      }

      if (message.role === 'assistant' && isReplayUnsafeAssistantMessage(message)) {
        removedMessages += 1
        issues.push({
          kind: 'unsafe-assistant-message',
          messageIndex: index,
          role: message.role,
          removedMessages: 1,
          reason: 'assistant message is unsafe for provider replay and was removed',
          toolCallIds: this.messageHelper.extractAssistantToolCallIds(message),
        })
        stableLength = sanitized.length
        continue
      }

      const toolCalls = this.messageHelper.extractAssistantToolCalls(message)
      const toolCallIds = toolCalls.map((toolCall) => toolCall.toolCallId)
      if (isEmpty(toolCallIds)) {
        pushSanitized(message)
        stableLength = sanitized.length
        continue
      }

      const collectedMessages: ModelMessage[] = [message]
      const resultIds = new Set<string>()
      let nextIndex = index + 1

      while (nextIndex < history.length) {
        const nextMessage = history[nextIndex]
        if (nextMessage.role !== 'tool') {
          break
        }

        collectedMessages.push(nextMessage)
        for (const resultId of this.messageHelper.extractToolResultIds(nextMessage)) {
          resultIds.add(resultId)
        }
        nextIndex += 1
      }

      const hasAllResults = toolCallIds.every((toolCallId) => resultIds.has(toolCallId))
      if (!hasAllResults) {
        const missingToolCalls = this.resolveBackfillableInterruptedToolCalls(
          toolCalls,
          resultIds
        )
        if (missingToolCalls) {
          collectedMessages.forEach((collectedMessage) => pushSanitized(collectedMessage))
          pushSanitized(this.buildInterruptedToolResultMessage(missingToolCalls))
          changedMessages += 1
          issues.push({
            kind: 'missing-tool-results',
            messageIndex: index,
            role: message.role,
            removedMessages: 0,
            reason: 'assistant tool-call group was preserved by backfilling interrupted tool-results for missing calls',
            toolCallIds,
            missingToolCallIds: missingToolCalls.map((toolCall) => toolCall.toolCallId),
          })
          stableLength = sanitized.length
          index = nextIndex - 1
          continue
        }

        const removedGroupMessages = (sanitized.length - stableLength) + collectedMessages.length
        removedMessages += removedGroupMessages
        issues.push({
          kind: 'missing-tool-results',
          messageIndex: index,
          role: message.role,
          removedMessages: removedGroupMessages,
          reason: 'assistant tool-call group was removed because one or more tool-results were missing',
          toolCallIds,
          missingToolCallIds: toolCallIds.filter((toolCallId) => !resultIds.has(toolCallId)),
        })
        sanitized.length = stableLength
        index = nextIndex - 1
        continue
      }

      collectedMessages.forEach((collectedMessage) => pushSanitized(collectedMessage))
      stableLength = sanitized.length
      index = nextIndex - 1
    }

    // 调用方（如 prepareHistory）若已确认请求时会再走 sanitizeHistoryForProvider 做 per-message 预算/截断，
    // 可设置 skipPerMessageBudget 跳过这里的重复计算，避免每个 turn 双重 sanitize 同一份消息体。
    if (flags?.skipPerMessageBudget) return {
        history: sanitized,
        removedMessages,
        changedMessages,
        issues,
      }

    const budgeted = sanitizeModelHistory(sanitized, options)

    return {
      history: budgeted.changedMessages > 0 ? budgeted.history : sanitized,
      removedMessages,
      changedMessages: changedMessages + budgeted.changedMessages,
      issues,
    }
  }

  private resolveBackfillableInterruptedToolCalls(
    toolCalls: readonly HistoryToolCallReference[],
    resultIds: ReadonlySet<string>
  ): Nullable<HistoryToolCallReference[]> {
    const missingToolCalls = toolCalls.filter((toolCall) => !resultIds.has(toolCall.toolCallId))
    if (isEmpty(missingToolCalls)) return []

    const seen = new Set<string>()
    for (const toolCall of toolCalls) {
      if (!toolCall.toolCallId.trim()) return null
      if (seen.has(toolCall.toolCallId)) return null

      seen.add(toolCall.toolCallId)
    }

    return missingToolCalls
  }

  private buildInterruptedToolResultMessage(
    toolCalls: readonly HistoryToolCallReference[]
  ): ModelMessage {
    return {
      role: 'tool',
      content: toolCalls.map((toolCall) => ({
        type: 'tool-result' as const,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        output: {
          type: 'error-text' as const,
          value: InterruptedToolResultValue,
        },
      })),
    }
  }

  public compactHistory(
    model: string,
    systemPrompt: string,
    history: ModelMessage[],
    options: EstimateContextUsageOptions = {},
    policy: HistoryCompactionPolicy = {},
  ): HistoryCompactionResult {
    const estimatedBefore = this.estimateContextUsage(model, systemPrompt, history, options)
    const triggerPercent = policy.triggerPercent ?? this.compactionPercent
    const targetPercent = this.resolveCompactionTargetPercent(policy)
    if (estimatedBefore.percent < triggerPercent) return {
        compacted: false,
        history,
        estimatedBefore,
        estimatedAfter: estimatedBefore,
        removedMessages: 0,
        passes: 0,
        keptRecentTurns: 0,
        targetPercent,
      }

    const reclaimed = this.reclaimToolResultsBeforeCompaction(
      model,
      systemPrompt,
      history,
      estimatedBefore,
      options,
      triggerPercent,
    )
    if (reclaimed && reclaimed.estimatedAfter.percent < triggerPercent) return {
        compacted: true,
        history: reclaimed.history,
        estimatedBefore,
        estimatedAfter: reclaimed.estimatedAfter,
        removedMessages: 0,
        passes: 0,
        keptRecentTurns: 0,
        targetPercent: reclaimed.estimatedAfter.percent,
      }

    const workingHistory = reclaimed?.history ?? history
    const candidate = this.resolveCompactionCandidate(
      model,
      systemPrompt,
      workingHistory,
      estimatedBefore,
      options,
      policy,
      triggerPercent,
    )

    if (!candidate && reclaimed) return {
        compacted: true,
        history: reclaimed.history,
        estimatedBefore,
        estimatedAfter: reclaimed.estimatedAfter,
        removedMessages: 0,
        passes: 0,
        keptRecentTurns: 0,
        targetPercent: reclaimed.estimatedAfter.percent,
      }

    if (!candidate) return {
        compacted: false,
        history,
        estimatedBefore,
        estimatedAfter: estimatedBefore,
        removedMessages: 0,
        passes: 0,
        keptRecentTurns: 0,
        targetPercent,
      }

    return {
      compacted: true,
      history: candidate.history,
      estimatedBefore,
      estimatedAfter: candidate.estimatedAfter,
      removedMessages: Math.max(history.length - candidate.history.length, 0),
      passes: 1,
      keptRecentTurns: candidate.keptRecentTurns,
      targetPercent: candidate.estimatedAfter.percent,
    }
  }

  /**
   * 为语义级压缩构建计划：尽量多折叠（仅保留最近两个外部 conversation），
   * 给出待折叠的较老消息、需保留的最近消息、规则摘要种子和当前估算。
   * 无可折叠的较老 turn 时返回 null（调用方应放弃语义压缩）。
   */
  public buildSemanticCompactionPlan(
    model: string,
    systemPrompt: string,
    history: ModelMessage[],
    options: EstimateContextUsageOptions = {},
    policy: Pick<HistoryCompactionPolicy, 'minRecentConversationsToKeep'> = {},
  ): Nullable<SemanticCompactionPlan> {
    const minKeep = this.resolveMinRecentConversationsToKeep(policy)
    const existingSummaryMessages = history.filter((message) =>
      this.summaryHelper.isCompactionSummaryMessage(message)
    )
    const turns = this.splitHistoryIntoConversations(
      history.filter((message) => !this.summaryHelper.isCompactionSummaryMessage(message)),
    )
    if (turns.length <= minKeep) return null

    const olderTurns = turns.slice(0, Math.max(turns.length - minKeep, 0))
    const recentTurns = minKeep === 0 ? [] : turns.slice(-minKeep)
    const olderMessages = olderTurns.flatMap((turn) => turn.messages)
    if (isEmpty(olderMessages)) return null

    const preservedMessages = [...existingSummaryMessages]
    const verbatimUserAnchors =
      this.summaryHelper.collectVerbatimUserAnchorMessages(olderTurns)
    const protectedUserAnchors =
      this.summaryHelper.buildProtectedUserAnchorSummary(olderTurns)
    if (protectedUserAnchors) {
      preservedMessages.push({
        role: 'assistant',
        content: protectedUserAnchors,
      })
    }
    preservedMessages.push(...verbatimUserAnchors)

    const recentMessages = recentTurns.flatMap((turn) => turn.messages)
    // minKeep=0 时全部 turn 进 olderTurns,最新用户指令可能只在语义摘要里留预览(还会被 LLM 改写)。
    // 无条件逐字保留最后一条 user 消息(全文不截),放在 recentMessages 尾部(摘要之后的最新位)。
    const mandatoryLastUserAnchors =
      minKeep === 0
        ? this.collectMandatoryLastUserAnchors(turns, [...verbatimUserAnchors, ...recentMessages])
        : []

    return {
      olderMessages,
      preservedMessages,
      recentMessages: [...recentMessages, ...mandatoryLastUserAnchors],
      ruleSummary: this.summaryHelper.buildFreshCompactionSummary(olderTurns),
      keptRecentTurns: minKeep,
      estimatedBefore: this.estimateContextUsage(model, systemPrompt, history, options),
    }
  }

  /**
   * 语义压缩计划：先按默认下限（2）尝试，仍无计划且用量超阈值时逐级放宽至 1、0。
   */
  public resolveSemanticCompactionPlan(
    model: string,
    systemPrompt: string,
    history: ModelMessage[],
    options: EstimateContextUsageOptions = {},
    triggerPercent: number = this.compactionPercent,
    policy: Pick<HistoryCompactionPolicy, 'minRecentConversationsToKeep'> = {},
  ): Nullable<SemanticCompactionPlan> {
    const estimatedBefore = this.estimateContextUsage(model, systemPrompt, history, options)
    if (triggerPercent > 0 && estimatedBefore.percent < triggerPercent) return null

    for (const minKeep of this.resolveCompactionMinKeepAttempts(policy)) {
      const plan = this.buildSemanticCompactionPlan(model, systemPrompt, history, options, {
        minRecentConversationsToKeep: minKeep,
      })
      if (plan) return plan
    }

    return null
  }

  /** 把语义摘要正文包裹成可被后续压缩流程识别的压缩摘要消息文本。 */
  public wrapSemanticSummary(body: string): string {
    return [CompactionSummaryMarker, CompactionSummaryInstruction, body.trim()].join('\n')
  }

  /** 用语义摘要 + 保留的最近消息组装新历史。 */
  public assembleSemanticHistory(
    wrappedSummary: string,
    recentMessages: ModelMessage[],
    preservedMessages: ModelMessage[] = [],
  ): ModelMessage[] {
    return [
      ...preservedMessages,
      {
        role: 'assistant',
        content: wrappedSummary,
      },
      ...recentMessages,
    ]
  }

  /**
   * 语义摘要是模型产物，不能只因“更短”就采纳。这里校验规则摘要里的强锚点
   * （文件路径、文件名、验证/构建命令）是否仍逐字可见；缺失时调用方应回落规则压缩。
   */
  public validateSemanticSummary(
    ruleSummary: Nullable<string>,
    semanticSummary: string,
  ): SemanticSummaryValidationResult {
    const anchors = this.extractSemanticSummaryAnchors(ruleSummary)
    if (isEmpty(anchors)) return {
        valid: true,
        anchors,
        missingAnchors: [],
      }

    const haystack = this.normalizeSemanticSummaryAnchorText(semanticSummary)
    const missingAnchors = anchors.filter((anchor) =>
      !haystack.includes(this.normalizeSemanticSummaryAnchorText(anchor))
    )

    return {
      valid: isEmpty(missingAnchors),
      anchors,
      missingAnchors,
    }
  }

  public buildFallbackHistory(history: ModelMessage[]): ModelMessage[] {
    const lastUserMessage = [...history].reverse().find((message) => message.role === 'user')
    if (lastUserMessage) return [lastUserMessage]

    const lastAssistantPreview = [...history]
      .reverse()
      .find((message) => message.role === 'assistant')
    const preview = lastAssistantPreview
      ? this.summaryHelper.previewText(this.messageHelper.extractTextContent(lastAssistantPreview))
      : null
    if (preview) return [
        {
          role: 'user',
          content: `继续处理刚才的任务。最近上下文摘要：${preview}`,
        },
      ]

    return [
      {
        role: 'user',
        content: '继续处理当前任务。',
      },
    ]
  }

  private splitHistoryIntoConversations(history: ModelMessage[]): AgentHistoryTurn[] {
    const conversations: AgentHistoryTurn[] = []
    let currentMessages: ModelMessage[] = []

    history.forEach((message) => {
      if (this.isConversationStartMessage(message) && !isEmpty(currentMessages)) {
        conversations.push({ messages: currentMessages })
        currentMessages = []
      }

      currentMessages.push(message)
    })

    if (!isEmpty(currentMessages)) {
      conversations.push({ messages: currentMessages })
    }

    return conversations
  }

  private isConversationStartMessage(message: ModelMessage): boolean {
    return message.role === 'user' && !isInternalFollowUpMessage(message)
  }

  /**
   * keepRecentTurns=0（含语义路径 minKeep=0）的超压路径强制活指令锚：逐字取回最后一条 user
   * 消息（全文不截），与已逐字保留的锚去重，避免同一 user 消息被重复注入。
   */
  private collectMandatoryLastUserAnchors(
    turns: AgentHistoryTurn[],
    alreadyIncluded: ModelMessage[],
  ): ModelMessage[] {
    const lastUser = this.summaryHelper.collectMandatoryLastUserAnchorMessage(turns)
    if (!lastUser) return []

    const lastUserContent = JSON.stringify(lastUser.content)
    const duplicate = alreadyIncluded.some(
      (message) => JSON.stringify(message.content) === lastUserContent,
    )
    return duplicate ? [] : [lastUser]
  }

  private resolveCompactionCandidate(
    model: string,
    systemPrompt: string,
    history: ModelMessage[],
    estimatedBefore: ContextUsageEstimate,
    options: EstimateContextUsageOptions,
    policy: HistoryCompactionPolicy,
    triggerPercent: number,
  ): Nullable<HistoryCompactionCandidate> {
    for (const minKeep of this.resolveCompactionMinKeepAttempts(policy, estimatedBefore, triggerPercent)) {
      const candidate = this.buildCompactionCandidate(
        model,
        systemPrompt,
        history,
        estimatedBefore,
        options,
        { ...policy, minRecentConversationsToKeep: minKeep },
        triggerPercent,
      )
      if (candidate) return candidate
    }

    return null
  }

  private resolveCompactionMinKeepAttempts(
    policy: Pick<HistoryCompactionPolicy, 'minRecentConversationsToKeep'>,
    estimatedBefore?: ContextUsageEstimate,
    triggerPercent?: number,
  ): number[] {
    const requestedMin = this.resolveMinRecentConversationsToKeep(policy)
    const attempts = [requestedMin]
    const shouldRelax =
      !isFiniteNumber(policy.minRecentConversationsToKeep)
      && (
        !estimatedBefore
        || !isFiniteNumber(triggerPercent)
        || estimatedBefore.percent >= triggerPercent
      )

    if (shouldRelax) {
      if (requestedMin > 1) attempts.push(1)
      if (requestedMin > 0) attempts.push(0)
    }

    return attempts.filter((value, index, values) => values.indexOf(value) === index)
  }

  private resolveMinRecentConversationsToKeep(
    policy: Pick<HistoryCompactionPolicy, 'minRecentConversationsToKeep'>,
  ): number {
    if (isFiniteNumber(policy.minRecentConversationsToKeep)) return Math.max(0, Math.floor(policy.minRecentConversationsToKeep))

    return this.minRecentConversationsToKeep
  }

  private buildCompactionCandidate(
    model: string,
    systemPrompt: string,
    history: ModelMessage[],
    estimatedBefore: ContextUsageEstimate,
    options: EstimateContextUsageOptions,
    policy: Pick<HistoryCompactionPolicy, 'minRecentConversationsToKeep'>,
    triggerPercent: number,
  ): Nullable<HistoryCompactionCandidate> {
    const minKeep = this.resolveMinRecentConversationsToKeep(policy)
    const existingSummarySections =
      this.summaryHelper.extractExistingCompactionSummarySections(history)
    const turns = this.splitHistoryIntoConversations(
      history.filter((message) => !this.summaryHelper.isCompactionSummaryMessage(message))
    )
    if (isEmpty(turns)) return null

    const maxKeepRecentTurns = this.summaryHelper.hasSummarySections(existingSummarySections)
      ? turns.length
      : turns.length - 1
    if (maxKeepRecentTurns < minKeep) return null

    let bestBelowThreshold: Nullable<HistoryCompactionCandidate> = null
    let strongestReduction: Nullable<HistoryCompactionCandidate> = null

    for (let keepRecentTurns = maxKeepRecentTurns; keepRecentTurns >= minKeep; keepRecentTurns -= 1) {
      const olderTurns = turns.slice(0, Math.max(turns.length - keepRecentTurns, 0))
      if (isEmpty(olderTurns) && !this.summaryHelper.hasSummarySections(existingSummarySections)) {
        continue
      }

      const recentTurns = keepRecentTurns === 0 ? [] : turns.slice(-keepRecentTurns)
      const verbatimUserAnchors =
        this.summaryHelper.collectVerbatimUserAnchorMessages(olderTurns)
      // keepRecentTurns=0 时全部 turn(含当前对话)进 olderTurns,最新用户指令可能只在摘要里留预览。
      // 无条件逐字保留最后一条 user 消息(全文不截),避免活指令被折进摘要。
      const mandatoryLastUserAnchors =
        keepRecentTurns === 0
          ? this.collectMandatoryLastUserAnchors(turns, verbatimUserAnchors)
          : []
      const summary = this.summaryHelper.buildCompactionSummary(
        existingSummarySections,
        olderTurns,
      )
      if (!summary) {
        continue
      }

      const compactedHistory: ModelMessage[] = [
        {
          role: 'assistant',
          content: summary,
        },
        ...verbatimUserAnchors,
        ...mandatoryLastUserAnchors,
        ...recentTurns.flatMap((turn) => turn.messages),
      ]
      const estimatedAfter = this.estimateContextUsage(
        model,
        systemPrompt,
        compactedHistory,
        options,
      )
      const candidate = {
        history: compactedHistory,
        estimatedAfter,
        keptRecentTurns: keepRecentTurns,
      }

      if (candidate.estimatedAfter.percent < triggerPercent) {
        if (
          !bestBelowThreshold
          || candidate.keptRecentTurns > bestBelowThreshold.keptRecentTurns
          || (
            candidate.keptRecentTurns === bestBelowThreshold.keptRecentTurns
            && this.isStrongerReductionCandidate(candidate, bestBelowThreshold)
          )
        ) {
          bestBelowThreshold = candidate
        }
      }

      if (!strongestReduction || this.isStrongerReductionCandidate(candidate, strongestReduction)) {
        strongestReduction = candidate
      }
    }

    const selected = bestBelowThreshold ?? strongestReduction
    if (!selected) return null

    const madeProgress =
      selected.estimatedAfter.estimatedTokens < estimatedBefore.estimatedTokens
      || selected.history.length < history.length
    return madeProgress ? selected : null
  }

  private reclaimToolResultsBeforeCompaction(
    model: string,
    systemPrompt: string,
    history: ModelMessage[],
    estimatedBefore: ContextUsageEstimate,
    options: EstimateContextUsageOptions,
    triggerPercent: number,
  ): Nullable<HistoryReclaimCandidate> {
    const reclaimed = enforceConversationScopedToolResultBudget(history)
    if (reclaimed.changedMessages <= 0) return null

    const estimatedAfter = this.estimateContextUsage(
      model,
      systemPrompt,
      reclaimed.history,
      options
    )
    const madeProgress =
      estimatedAfter.estimatedTokens < estimatedBefore.estimatedTokens
      || estimatedAfter.percent < Math.min(estimatedBefore.percent, triggerPercent)
    if (!madeProgress) return null

    return {
      history: reclaimed.history,
      estimatedAfter,
    }
  }

  private isStrongerReductionCandidate(
    candidate: HistoryCompactionCandidate,
    currentBest: HistoryCompactionCandidate,
  ): boolean {
    if (candidate.estimatedAfter.estimatedTokens !== currentBest.estimatedAfter.estimatedTokens) return candidate.estimatedAfter.estimatedTokens < currentBest.estimatedAfter.estimatedTokens

    if (candidate.history.length !== currentBest.history.length) return candidate.history.length < currentBest.history.length

    return candidate.keptRecentTurns < currentBest.keptRecentTurns
  }

  private resolveCompactionTargetPercent(policy: HistoryCompactionPolicy): number {
    if (isFiniteNumber(policy.targetPercent)) return Math.max(1, Math.min(policy.targetPercent, 100))

    return this.getCompactionTargetPercent()
  }

  private extractSemanticSummaryAnchors(ruleSummary: Nullable<string>): string[] {
    if (!isPresent(ruleSummary) || isBlank(ruleSummary)) return []

    const anchors: string[] = []
    const addAnchor = (value: string): void => {
      const normalized = this.normalizeSemanticSummaryAnchorText(value)
      if (!normalized || anchors.includes(normalized)) return

      anchors.push(normalized)
    }

    for (const match of ruleSummary.matchAll(FileAnchorPattern)) {
      addAnchor(match[0])
    }
    CommandAnchorPatterns.forEach((pattern) => {
      for (const match of ruleSummary.matchAll(pattern)) {
        addAnchor(this.trimSemanticSummaryCommandAnchor(match[0]))
      }
    })

    return anchors.slice(0, MaxSemanticSummaryAnchors)
  }

  private normalizeSemanticSummaryAnchorText(value: string): string {
    return value
      .replace(/[`'"“”‘’]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private trimSemanticSummaryCommandAnchor(value: string): string {
    const normalized = this.normalizeSemanticSummaryAnchorText(value)
      .replace(/[.,;，。；]+$/g, '')
    const tokens = normalized.split(' ').filter(Boolean)
    if (tokens.length <= 2) return normalized

    const first = tokens[0]?.toLowerCase()
    const second = tokens[1]?.toLowerCase()
    const minimumCommandTokens =
      first && ['bun', 'npm', 'pnpm', 'yarn'].includes(first) && second === 'run'
        ? 3
        : 2
    const stopIndex = tokens.findIndex((token, index) =>
      index >= minimumCommandTokens
      && CommandAnchorStopWords.has(token.replace(/[.,;，。；]+$/g, '').toLowerCase())
    )
    const selected = stopIndex >= 0 ? tokens.slice(0, stopIndex) : tokens
    return selected.join(' ').replace(/[.,;，。；]+$/g, '')
  }
}

/**
 * 仅做结构性修复的共享 HistoryHelper：丢弃孤儿 tool-result、回填/移除缺结果的
 * tool-call 组，使历史满足 provider 校验。无构造依赖，可安全复用。
 */
const sharedHistoryStructureRepairHelper = new HistoryHelper()

/**
 * provider 编译前的历史结构自愈：清理流中止/异常留下的孤儿 tool-result 与不完整
 * tool-call 组，避免一次损坏永久锁死会话（每次 send 都被 assertValidModelHistory 拦下）。
 * 只做结构修复，不做预算截断（skipPerMessageBudget），预算由编译链路自己负责。
 */
function repairHistoryStructureForProvider(history: ModelMessage[]): HistorySanitizationResult {
  // 先剥掉与合法结果混在同一条 tool 消息里的孤儿 tool-result 片段（sanitizeHistory 只能丢整条），
  // 再走 sanitizeHistory 处理「整条无前驱的 tool 消息」和「缺结果的 tool-call 组」（回填/移除）。
  const stripped = stripOrphanToolResultParts(history)
  const base = stripped.changedMessages > 0 ? stripped.history : history
  const sanitized = sharedHistoryStructureRepairHelper.sanitizeHistory(base, undefined, {
    skipPerMessageBudget: true,
  })
  if (stripped.changedMessages === 0) return sanitized
  return { ...sanitized, changedMessages: sanitized.changedMessages + stripped.changedMessages }
}

export type {
  ContextUsageEstimate,
  HistoryCompactionPolicy,
  HistoryCompactionResult,
  HistorySanitizationIssue,
  HistorySanitizationResult,
  SemanticCompactionPlan,
  SemanticSummaryValidationResult,
}
export { HistoryHelper, repairHistoryStructureForProvider }
export { HistoryHelper as AgentHistoryHelper }
