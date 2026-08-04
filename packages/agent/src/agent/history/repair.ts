/**
 * 历史**结构自愈**（孤儿 tool-result / 不完整 tool-call 组）。
 *
 * 这段逻辑原先寄居在 v1 压缩机器 `history/compaction.ts` 的 `HistoryHelper` 里。压缩机器随上下文
 * 治理 v2 整台拆除，但结构自愈是**救命逻辑，一行不动**：流中止 / 异常会在持久历史里留下孤儿
 * tool-result 或缺结果的 tool-call 组，导致此后每次 send 都被 `assertValidModelHistory` 拦下、
 * 会话被永久锁死（真机踩过：4 次 mid-tool-call 中止 0 brick 就是靠这条）。所以它从死楼里整器官
 * 平移到本文件，与压缩策略彻底分开演化。
 *
 * 只做结构修复，不做预算截断——per-message 预算是 `sanitize.ts` 的事，投影预算是驻留账本的事。
 */
import type { ModelMessage } from 'ai'

import { isEmpty } from '@velaros-ai/core'

import { HistoryMessages, type HistoryToolCallReference } from './messages'
import { isReplayUnsafeAssistantMessage, sanitizeModelMessage } from './sanitize'
import { stripOrphanToolResultParts } from './validate'

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

interface HistorySanitizationResult {
  history: ModelMessage[]
  removedMessages: number
  changedMessages: number
  issues: HistorySanitizationIssue[]
}

const InterruptedToolResultValue =
  '[no result: the previous turn was interrupted before this tool call completed]'

const messageHelper = new HistoryMessages()

/**
 * 回填判据：tool-call 组里缺结果的调用能否用「被中断」占位结果补齐。
 * 任一 toolCallId 为空或重复时返回 null——回填会张冠李戴，此时只能整组移除。
 */
function resolveBackfillableInterruptedToolCalls(
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

function buildInterruptedToolResultMessage(
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

/**
 * 逐条扫描历史，修复三类结构损坏：
 *  - 无前驱 assistant tool-call 的整条 tool 消息 → 丢弃；
 *  - 回放不安全的 assistant 消息 → 丢弃；
 *  - 缺结果的 tool-call 组 → 能回填就补「被中断」占位结果，不能回填就整组移除。
 */
function repairHistoryStructure(history: ModelMessage[]): HistorySanitizationResult {
  const sanitized: ModelMessage[] = []
  let removedMessages = 0
  let changedMessages = 0
  const issues: HistorySanitizationIssue[] = []
  let stableLength = 0
  const pushSanitized = (message: ModelMessage): void => {
    const result = sanitizeModelMessage(message, { skipToolResultBudget: true })
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
        toolCallIds: messageHelper.extractToolResultIds(message),
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
        toolCallIds: messageHelper.extractAssistantToolCallIds(message),
      })
      stableLength = sanitized.length
      continue
    }

    const toolCalls = messageHelper.extractAssistantToolCalls(message)
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
      for (const resultId of messageHelper.extractToolResultIds(nextMessage)) {
        resultIds.add(resultId)
      }
      nextIndex += 1
    }

    const hasAllResults = toolCallIds.every((toolCallId) => resultIds.has(toolCallId))
    if (!hasAllResults) {
      const missingToolCalls = resolveBackfillableInterruptedToolCalls(toolCalls, resultIds)
      if (missingToolCalls) {
        collectedMessages.forEach((collectedMessage) => pushSanitized(collectedMessage))
        pushSanitized(buildInterruptedToolResultMessage(missingToolCalls))
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

  return { history: sanitized, removedMessages, changedMessages, issues }
}

/**
 * provider 编译前的历史结构自愈：清理流中止/异常留下的孤儿 tool-result 与不完整
 * tool-call 组，避免一次损坏永久锁死会话（每次 send 都被 assertValidModelHistory 拦下）。
 */
function repairHistoryStructureForProvider(history: ModelMessage[]): HistorySanitizationResult {
  let identityChangedMessages = 0
  const identitySanitized = history.map((message) => {
    const result = sanitizeModelMessage(message, { skipToolResultBudget: true })
    if (result.changed) identityChangedMessages += 1
    return result.message
  })
  // 先剥掉与合法结果混在同一条 tool 消息里的孤儿 tool-result 片段（逐条扫描只能丢整条），
  // 再走结构修复处理「整条无前驱的 tool 消息」和「缺结果的 tool-call 组」（回填/移除）。
  const stripped = stripOrphanToolResultParts(identitySanitized)
  const base = stripped.changedMessages > 0 ? stripped.history : identitySanitized
  const sanitized = repairHistoryStructure(base)
  const changedMessages =
    identityChangedMessages + stripped.changedMessages + sanitized.changedMessages
  if (changedMessages === sanitized.changedMessages) return sanitized
  return { ...sanitized, changedMessages }
}

export { InterruptedToolResultValue, repairHistoryStructureForProvider }
export type { HistorySanitizationIssue, HistorySanitizationResult }
