import type { ModelMessage, ToolCallPart, ToolResultPart } from 'ai'

import { isArray,isEmpty, isString, toNullable } from '@velaros-ai/core'

import { SummaryHighlights } from './highlights'
import { HistoryMessages } from './messages'
import {
  type SummarySections,
  SummarySectionsHelper,
} from './sections'

interface AgentHistoryTurn {
  messages: ModelMessage[]
}

/**
 * 历史压缩摘要构造器。
 *
 * 当历史辅助器决定丢弃较老轮次时，使用本辅助器把这些被丢弃的内容
 * 折叠成一段压缩摘要系统消息，注入历史头部供后续模型读取。
 *
 * 摘要按分区组织（目标、决策、文件、验证、后续事项等），
 * 多次压缩会把旧分区与新分区合并去重，保证关键信息在多轮压缩中不丢失。
 *
 * 拆分到高亮辅助器和分区辅助器是因为：
 *  - 高亮：从单条消息中抽取“决策、失败、文件、模块”等结构化片段；
 *  - section：负责跨轮合并、按字符 / 条数限额渲染最终 Markdown 文本。
 */
class HistorySummary {
  private readonly maxSummaryLength = 220
  private readonly maxToolPreviewLength = 180
  private readonly maxVerbatimUserAnchorLength = 1_200
  private readonly sectionHelper: SummarySectionsHelper

  constructor(
    private readonly messageHelper = new HistoryMessages(),
    private readonly highlightHelper = new SummaryHighlights(messageHelper),
  ) {
    this.sectionHelper = new SummarySectionsHelper(messageHelper, highlightHelper)
  }

  /** 根据已有摘要和较旧轮次生成新的上下文压缩摘要。 */
  public buildCompactionSummary(
    existingSummarySections: SummarySections,
    olderTurns: AgentHistoryTurn[],
  ): Nullable<string> {
    const sections = this.sectionHelper.cloneSummarySections(existingSummarySections)
    let shouldCaptureGoal = isEmpty(sections.goal)
    olderTurns.forEach((turn) => {
      const turnSections = this.summarizeTurnSections(turn, shouldCaptureGoal)
      this.sectionHelper.mergeSummarySections(sections, turnSections)
      if (!isEmpty(turnSections.goal)) {
        shouldCaptureGoal = false
      }
    })

    return toNullable(this.sectionHelper.buildCompactionSummaryText(sections))
  }

  /** 只根据本次被折叠的旧轮次生成摘要，不合并既有压缩摘要。 */
  public buildFreshCompactionSummary(
    olderTurns: AgentHistoryTurn[],
  ): Nullable<string> {
    return this.buildCompactionSummary(
      this.sectionHelper.createEmptySummarySections(),
      olderTurns,
    )
  }

  /** 抽取需要跨语义压缩稳定保留的早期用户目标和约束。 */
  public buildProtectedUserAnchorSummary(
    olderTurns: AgentHistoryTurn[],
  ): Nullable<string> {
    const sections = this.sectionHelper.createEmptySummarySections()
    let shouldCaptureGoal = true
    olderTurns.forEach((turn) => {
      const userPreviews = this.collectTurnMessagePreviews(turn, 'user')
      const userPreview = toNullable(userPreviews[0])
      if (shouldCaptureGoal && userPreview) {
        this.sectionHelper.addSummaryItem(sections, 'goal', userPreview)
        shouldCaptureGoal = false
      }
      this.highlightHelper.extractUserConstraintHighlights(userPreviews).forEach((item) => {
        this.sectionHelper.addSummaryItem(sections, 'constraints', item)
      })
    })

    return toNullable(this.sectionHelper.buildCompactionSummaryText(sections))
  }

  /**
   * 选出压缩后仍应以原始 user role 保留的早期目标/约束。
   *
   * 语义摘要会改写内容，规则摘要也会裁剪长句；首个短用户目标和显式约束
   * 属于后续执行的硬边界，保留原文可避免压缩链路把“不要/必须/只能”等要求弱化。
   */
  public collectVerbatimUserAnchorMessages(olderTurns: AgentHistoryTurn[]): ModelMessage[] {
    const anchors: ModelMessage[] = []
    const seen = new Set<string>()
    let sawOlderUserText = false

    olderTurns.forEach((turn) => {
      turn.messages.forEach((message) => {
        if (message.role !== 'user') return

        const text = this.messageHelper.extractTextContent(message)
        if (!text) return

        const isFirstOlderUserText = !sawOlderUserText
        sawOlderUserText = true
        if (!this.isVerbatimUserAnchorCandidate(message, text)) return

        const isExplicitConstraint =
          !isEmpty(this.highlightHelper.extractUserConstraintHighlights([text]))
        if (!isFirstOlderUserText && !isExplicitConstraint) return

        if (seen.has(text)) return
        seen.add(text)
        anchors.push({ ...message })
      })
    })

    return anchors
  }

  /**
   * 无条件逐字返回最后一条 user 消息（全文不截，克隆）。
   *
   * keepRecentTurns=0 的超压路径会把含当前对话的全部 turn 折进摘要，而
   * {@link collectVerbatimUserAnchorMessages} 只挑首个短用户目标/显式约束（≤1200 字且 string
   * content）——超长或多 part 的活指令会只剩预览。最新用户指令是下一步执行的唯一准绳，必须原文
   * 送达，故此路径无条件逐字保留它。
   */
  public collectMandatoryLastUserAnchorMessage(
    turns: AgentHistoryTurn[],
  ): Nullable<ModelMessage> {
    for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
      const messages = turns[turnIndex]?.messages ?? []
      for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const message = messages[messageIndex]
        if (message?.role === 'user') return { ...message }
      }
    }

    return null
  }

  /** 从模型历史中提取已有压缩摘要，并合并成结构化分段。 */
  public extractExistingCompactionSummarySections(history: ModelMessage[]): SummarySections {
    const sections = this.sectionHelper.createEmptySummarySections()

    history.forEach((message) => {
      const summary = this.sectionHelper.extractCompactionSummaryText(message)
      if (!summary) return

      this.sectionHelper.mergeSummarySections(
        sections,
        this.sectionHelper.parseCompactionSummary(summary),
      )
    })

    return sections
  }

  /** 判断摘要分段中是否存在可渲染内容。 */
  public hasSummarySections(sections: SummarySections): boolean {
    return this.sectionHelper.hasSummarySections(sections)
  }

  /** 判断消息是否为上下文压缩流程生成的摘要消息。 */
  public isCompactionSummaryMessage(message: ModelMessage): boolean {
    return !!this.sectionHelper.extractCompactionSummaryText(message)
  }

  /** 生成指定长度以内的摘要预览文本。 */
  public previewText(text: string, maxLength = this.maxSummaryLength): Nullable<string> {
    return this.messageHelper.previewText(text, maxLength)
  }

  private summarizeTurnSections(turn: AgentHistoryTurn, includeGoal: boolean): SummarySections {
    const sections = this.sectionHelper.createEmptySummarySections()
    const userPreviews = this.collectTurnMessagePreviews(turn, 'user')
    const assistantPreviews = this.collectTurnMessagePreviews(turn, 'assistant')
    const toolResultPreviews = this.collectTurnToolResultPreviews(turn)
    const userPreview = (toNullable(userPreviews[0]))
    const assistantPreview = toNullable(assistantPreviews.at(-1))
    const toolResultPreview = toNullable(toolResultPreviews.at(-1))
    const toolNames = this.getTurnToolNames(turn)
    const allTextSources = [...userPreviews, ...assistantPreviews, ...toolResultPreviews]

    if (includeGoal) {
      const goalPreview = userPreview ?? assistantPreview
      if (goalPreview) {
        this.sectionHelper.addSummaryItem(sections, 'goal', goalPreview)
      }
    }

    this.highlightHelper.extractUserConstraintHighlights(userPreviews).forEach((item) => {
      this.sectionHelper.addSummaryItem(sections, 'constraints', item)
    })
    this.highlightHelper.extractDecisionHighlights(assistantPreviews).forEach((item) => {
      this.sectionHelper.addSummaryItem(sections, 'decisions', item)
    })
    this.highlightHelper.extractFileHighlights(allTextSources).forEach((item) => {
      this.sectionHelper.addSummaryItem(sections, 'files', item)
    })
    this.highlightHelper.extractOpenIssueHighlights(allTextSources).forEach((item) => {
      this.sectionHelper.addSummaryItem(sections, 'openIssues', item)
    })
    this.highlightHelper
      .extractVerificationHighlights([...assistantPreviews, ...toolResultPreviews])
      .forEach((item) => {
        this.sectionHelper.addSummaryItem(sections, 'verification', item)
      })

    const progress = this.buildTurnProgressHighlight(
      userPreview,
      assistantPreview,
      toolResultPreview,
      toolNames,
    )
    if (progress) {
      this.sectionHelper.addSummaryItem(sections, 'progress', progress)
    }

    return sections
  }

  private buildTurnProgressHighlight(
    userPreview: Nullable<string>,
    assistantPreview: Nullable<string>,
    toolResultPreview: Nullable<string>,
    toolNames: string[],
  ): Nullable<string> {
    const segments: string[] = []
    if (userPreview) {
      segments.push(`用户：${userPreview}`)
    } else if (assistantPreview) {
      segments.push(`状态：${assistantPreview}`)
    }

    if (!isEmpty(toolNames)) {
      segments.push(`工具：${toolNames.join(', ')}`)
    }

    const outcomePreview = assistantPreview || toolResultPreview
    if (outcomePreview) {
      const outcomeLabel = userPreview ? '结果' : '细节'
      const hasDuplicateOutcome = segments.some((segment) => segment.includes(outcomePreview))
      if (!hasDuplicateOutcome) {
        segments.push(`${outcomeLabel}：${outcomePreview}`)
      }
    }

    return !isEmpty(segments)
      ? this.previewText(segments.join(' | '), this.maxSummaryLength + 80)
      : null
  }

  private collectTurnMessagePreviews(
    turn: AgentHistoryTurn,
    role: Extract<ModelMessage['role'], 'assistant' | 'user'>,
  ): string[] {
    return turn.messages
      .filter((message) =>
        message.role === role && (role !== 'assistant' || !this.isCompactionSummaryMessage(message))
      )
      .map((message) =>
        this.previewText(
          this.messageHelper.extractTextContent(message),
          this.maxSummaryLength + 120,
        )
      )
      .filter((preview): preview is string => !!preview)
  }

  private isVerbatimUserAnchorCandidate(message: ModelMessage, text: string): boolean {
    return (
      isString(message.content) &&
      text.length <= this.maxVerbatimUserAnchorLength
    )
  }

  private getTurnToolNames(turn: AgentHistoryTurn): string[] {
    const toolNames: string[] = []
    const seen = new Set<string>()

    turn.messages.forEach((message) => {
      if (message.role === 'assistant' && isArray(message.content)) {
        message.content
          .filter((part): part is ToolCallPart => this.messageHelper.isToolCallPart(part))
          .forEach((part) => {
            if (!seen.has(part.toolName)) {
              seen.add(part.toolName)
              toolNames.push(part.toolName)
            }
          })
      }

      if (message.role === 'tool' && isArray(message.content)) {
        message.content
          .filter((part): part is ToolResultPart => this.messageHelper.isToolResultPart(part))
          .forEach((part) => {
            if (!seen.has(part.toolName)) {
              seen.add(part.toolName)
              toolNames.push(part.toolName)
            }
          })
      }
    })

    return toolNames
  }

  private collectTurnToolResultPreviews(turn: AgentHistoryTurn): string[] {
    const previews: string[] = []

    for (let messageIndex = turn.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = turn.messages[messageIndex]
      if (message.role !== 'tool' || !isArray(message.content)) {
        continue
      }

      for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
        const part = message.content[partIndex]
        if (!this.messageHelper.isToolResultPart(part)) {
          continue
        }

        const outputPreview = this.messageHelper.previewDynamicValue(
          part.output,
          this.maxToolPreviewLength,
        )
        if (outputPreview) {
          previews.push(`${part.toolName}: ${outputPreview}`)
        }
      }
    }

    return previews
  }
}

export { HistorySummary }
export type { AgentHistoryTurn, SummarySections }
export { HistorySummary as AgentHistorySummaryHelper }
