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

import type { HistorySanitizationIssue, HistorySanitizationResult, HistoryStructureRepairOptions,HistoryToolCallReference } from '../../types/history.js'

import { extractAssistantToolCallIds, extractAssistantToolCalls, extractToolResultIds } from './messages'
import { isReplayUnsafeAssistantMessage, sanitizeModelMessage } from './sanitize'
import { stripOrphanToolResultParts } from './validate'

const InterruptedToolResultValue =
  '[no result: the previous turn was interrupted before this tool call completed]'

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

/**
 * 为一组「有 tool-call 却没等到结果」的调用造一条占位 tool 消息，每个缺的调用配一条
 * `output: { type: 'error-text', value: InterruptedToolResultValue }` 的 tool-result。
 * 供应方要求 tool-call 与 tool-result 严格成对，补占位是为了**把这组调用整组保下来**——
 * 否则只能把整组（连同助手那条消息）从历史里删掉，模型就彻底看不见自己上一轮调过什么了。
 * 写成 error-text 而不是空结果，是要让模型明白这次调用是被中断的、需要时得重调，而不是真的返回了空。
 */
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
 * 结构自愈的主扫描：顺序走一遍历史，把每个 assistant tool-call 组连同紧随其后的 tool 消息当作一个整体处理，
 * 保证交出去的历史里 tool-call 与 tool-result **严格成对**（供应方的硬要求，缺一个整轮请求被拒）。
 * 处理规则：
 * - 整条无前驱的 `tool` 消息 = 孤儿，直接丢弃并记一条 `orphan-tool-result`；
 * - `isReplayUnsafeAssistantMessage` 认定不可重放的 assistant 消息丢弃（记 `unsafe-assistant-message`）；
 * - tool-call 组缺结果时，先问 `resolveBackfillableInterruptedToolCalls` 能不能回填：能就补占位结果**整组留下**，
 *   不能（toolCallId 有空或重复，回填会张冠李戴）就整组移除；
 * - 组内每条消息都过 `sanitizeModelMessage`（跳过 tool-result 预算裁剪——这里只管结构，不管长度）。
 *
 * `stableLength` 是移除整组时的回退水位：它只在「一个完整单元收尾」时推进，所以一旦判定要丢整组，
 * 把 `sanitized` 截回该水位就能连带丢掉本组已经推进去的助手消息，不会留下半组。
 */
function repairHistoryStructure(
  history: ModelMessage[],
  options: HistoryStructureRepairOptions = {}
): HistorySanitizationResult {
  const sanitized: ModelMessage[] = []
  let removedMessages = 0
  let changedMessages = 0
  const issues: HistorySanitizationIssue[] = []
  let stableLength = 0
  const pushSanitized = (message: ModelMessage): void => {
    const result = sanitizeModelMessage(message, {
      skipToolResultBudget: true,
      preserveToolCallInputIds: options.preserveToolCallInputIds,
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
        toolCallIds: extractToolResultIds(message),
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
        toolCallIds: extractAssistantToolCallIds(message),
      })
      stableLength = sanitized.length
      continue
    }

    const toolCalls = extractAssistantToolCalls(message)
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
      for (const resultId of extractToolResultIds(nextMessage)) {
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
function repairHistoryStructureForProvider(
  history: ModelMessage[],
  options: HistoryStructureRepairOptions = {}
): HistorySanitizationResult {
  let identityChangedMessages = 0
  const identitySanitized = history.map((message) => {
    const result = sanitizeModelMessage(message, {
      skipToolResultBudget: true,
      preserveToolCallInputIds: options.preserveToolCallInputIds,
    })
    if (result.changed) identityChangedMessages += 1
    return result.message
  })
  // 先剥掉与合法结果混在同一条 tool 消息里的孤儿 tool-result 片段（逐条扫描只能丢整条），
  // 再走结构修复处理「整条无前驱的 tool 消息」和「缺结果的 tool-call 组」（回填/移除）。
  const stripped = stripOrphanToolResultParts(identitySanitized)
  const base = stripped.changedMessages > 0 ? stripped.history : identitySanitized
  const sanitized = repairHistoryStructure(base, options)
  const changedMessages =
    identityChangedMessages + stripped.changedMessages + sanitized.changedMessages
  if (changedMessages === sanitized.changedMessages) return sanitized
  return { ...sanitized, changedMessages }
}

export { InterruptedToolResultValue, repairHistoryStructureForProvider }
