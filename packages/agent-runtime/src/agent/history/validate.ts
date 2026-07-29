import type { ModelMessage } from 'ai'

import { isArray, isEmpty,toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { coerceTrimmedString, isRecord } from '@velaros-ai/core/utils/unknownJsonRecord'

interface ToolCallReference {
  messageIndex: number
  toolName: string
}

export interface ModelHistoryValidationIssue {
  messageIndex: number
  role: string
  message: string
  toolCallId?: string
}

export interface ModelHistoryValidationResult {
  valid: boolean
  issues: ModelHistoryValidationIssue[]
}

export interface AssertValidModelHistoryOptions {
  phase: 'stream' | 'query' | 'compile'
  turn: Nullable<number>
}

function addIssue(
  issues: ModelHistoryValidationIssue[],
  messageIndex: number,
  role: string,
  message: string,
  toolCallId?: string
): void {
  issues.push({
    messageIndex,
    role,
    message,
    toolCallId: toOptional(toolCallId),
  })
}

function formatMessagePosition(messageIndex: number): string {
  return `第 ${messageIndex + 1} 条消息`
}

function formatIssue(issue: ModelHistoryValidationIssue): string {
  const suffix = issue.toolCallId ? `（toolCallId: ${issue.toolCallId}）` : ''
  return `${formatMessagePosition(issue.messageIndex)} ${issue.role}: ${issue.message}${suffix}`
}

/**
 * 结构自愈的第一步：剥掉「孤儿 tool-result 片段」——即 toolCallId 在紧邻之前的 assistant
 * tool-call 组里找不到对应项的 tool-result。流中止会留下这种孤儿（对应 tool-call 已丢），
 * 单靠 HistoryHelper.sanitizeHistory 只能丢弃「整条无前驱的 tool 消息」，无法剥掉与合法结果
 * 混在同一条 tool 消息里的孤儿片段。剥空的 tool 消息整条丢弃；剥掉结果后遗留的无结果
 * tool-call 交给后续 sanitizeHistory 回填/移除。语义严格对齐 {@link validateModelHistory}。
 */
export function stripOrphanToolResultParts(
  history: ModelMessage[]
): { history: ModelMessage[]; changedMessages: number } {
  let changedMessages = 0
  const result: ModelMessage[] = []
  // 只承认「紧邻在前的 assistant tool-call 组」声明的 toolCallId；任何非 tool 消息都重置。
  let pending = new Set<string>()

  for (const message of history) {
    if (message.role === 'tool') {
      if (!isArray(message.content)) {
        result.push(message)
        pending = new Set<string>()
        continue
      }
      const parts: unknown[] = message.content
      const kept: unknown[] = []
      let dropped = 0
      parts.forEach((part) => {
        if (!isRecord(part) || part.type !== 'tool-result') {
          kept.push(part)
          return
        }
        const toolCallId = coerceTrimmedString(part.toolCallId)
        // 空 toolCallId 交给下游 repairBlankToolCallIdsByAdjacentResults 按位置修复，这里不碰。
        if (!toolCallId) {
          kept.push(part)
          return
        }
        if (pending.has(toolCallId)) {
          pending.delete(toolCallId)
          kept.push(part)
          return
        }
        // 非空且在紧邻 assistant 组里找不到对应 tool-call → 真孤儿，丢弃。
        dropped += 1
      })
      if (dropped === 0) {
        result.push(message)
        continue
      }
      changedMessages += 1
      // 剥空则整条丢弃，避免留下空 tool 消息。
      if (!isEmpty(kept)) {
        result.push({ ...message, content: kept } as ModelMessage)
      }
      continue
    }

    // user/assistant/system：重置 pending（对齐 validate 的 closePendingBefore）。
    pending = new Set<string>()
    if (message.role === 'assistant' && isArray(message.content)) {
      const content: unknown[] = message.content
      content.forEach((part) => {
        if (!isRecord(part) || part.type !== 'tool-call') return
        const toolCallId = coerceTrimmedString(part.toolCallId)
        if (toolCallId) pending.add(toolCallId)
      })
    }
    result.push(message)
  }

  return { history: result, changedMessages }
}

export function validateModelHistory(
  history: ModelMessage[]
): ModelHistoryValidationResult {
  const issues: ModelHistoryValidationIssue[] = []
  const pendingToolCalls = new Map<string, ToolCallReference>()

  const closePendingBefore = (messageIndex: number, role: string): void => {
    if (!pendingToolCalls.size) return

    for (const [toolCallId, reference] of pendingToolCalls) {
      addIssue(
        issues,
        messageIndex,
        role,
        `${formatMessagePosition(reference.messageIndex)} 的 tool-call 缺少紧随其后的 tool-result`,
        toolCallId
      )
    }
    pendingToolCalls.clear()
  }

  history.forEach((message, messageIndex) => {
    const role = message.role

    if (role !== 'tool') {
      closePendingBefore(messageIndex, role)
    }

    if (role === 'assistant') {
      if (!isArray(message.content)) return

      const content: unknown[] = message.content
      content.forEach((part) => {
        if (!isRecord(part) || part.type !== 'tool-call') return

        const toolCallId = coerceTrimmedString(part.toolCallId)
        const toolName = coerceTrimmedString(part.toolName)
        if (!toolCallId) {
          addIssue(issues, messageIndex, role, 'tool-call 缺少 toolCallId')
          return
        }

        if (!toolName) {
          addIssue(issues, messageIndex, role, 'tool-call 缺少 toolName', toolCallId)
        }

        if (pendingToolCalls.has(toolCallId)) {
          addIssue(issues, messageIndex, role, '重复 replay 同一个 tool-call', toolCallId)
          return
        }

        pendingToolCalls.set(toolCallId, { messageIndex, toolName })
      })
      return
    }

    if (role !== 'tool') return

    if (!isArray(message.content)) {
      addIssue(issues, messageIndex, role, 'tool 消息 content 必须是 tool-result 数组')
      return
    }

    if (isEmpty(message.content)) {
      addIssue(issues, messageIndex, role, 'tool 消息不能为空')
      return
    }

    if (!pendingToolCalls.size) {
      addIssue(issues, messageIndex, role, '发现没有对应 assistant tool-call 的孤儿 tool-result')
    }

    const content: unknown[] = message.content
    const seenToolResultIds = new Set<string>()
    content.forEach((part) => {
      if (!isRecord(part) || part.type !== 'tool-result') {
        addIssue(issues, messageIndex, role, 'tool 消息只能包含 tool-result')
        return
      }

      const toolCallId = coerceTrimmedString(part.toolCallId)
      const toolName = coerceTrimmedString(part.toolName)
      if (!toolCallId) {
        addIssue(issues, messageIndex, role, 'tool-result 缺少 toolCallId')
        return
      }

      if (!toolName) {
        addIssue(issues, messageIndex, role, 'tool-result 缺少 toolName', toolCallId)
      }

      if (seenToolResultIds.has(toolCallId)) {
        addIssue(issues, messageIndex, role, '重复 replay 同一个 tool-result', toolCallId)
        return
      }

      seenToolResultIds.add(toolCallId)
      const pendingToolCall = pendingToolCalls.get(toolCallId)
      if (!pendingToolCall) {
        addIssue(issues, messageIndex, role, 'tool-result 没有匹配的待处理 tool-call', toolCallId)
        return
      }

      if (toolName && pendingToolCall.toolName && toolName !== pendingToolCall.toolName) {
        addIssue(
          issues,
          messageIndex,
          role,
          `tool-result 的 toolName 与 tool-call 不一致，应为 ${pendingToolCall.toolName}`,
          toolCallId
        )
      }

      pendingToolCalls.delete(toolCallId)
    })
  })

  if (pendingToolCalls.size) {
    const lastIndex = Math.max(history.length - 1, 0)
    for (const [toolCallId, reference] of pendingToolCalls) {
      addIssue(
        issues,
        lastIndex,
        history[lastIndex]?.role ?? 'unknown',
        `${formatMessagePosition(reference.messageIndex)} 的 tool-call 到历史末尾仍缺少 tool-result`,
        toolCallId
      )
    }
  }

  return {
    valid: isEmpty(issues),
    issues,
  }
}

export function assertValidModelHistory(
  history: ModelMessage[],
  options: AssertValidModelHistoryOptions
): void {
  const validation = validateModelHistory(history)
  const lastMessage = history.at(-1)
  if (lastMessage?.role === 'assistant' || lastMessage?.role === 'system') {
    validation.issues.push({
      messageIndex: history.length - 1,
      role: lastMessage.role,
      message:
        '模型请求历史不能以 assistant/system 消息收尾；内部续跑提醒必须作为 user/tool 后续输入发送，避免触发 provider assistant prefill 错误',
    })
    validation.valid = false
  }

  if (validation.valid) return

  const issueSummary = validation.issues.slice(0, 5).map(formatIssue).join('；')
  const hiddenCount = Math.max(validation.issues.length - 5, 0)
  const hiddenSuffix = hiddenCount ? `；另有 ${hiddenCount} 个问题` : ''
  throw new AppError(
    'VALIDATION',
    `模型上下文本地校验失败，已取消发送请求：${issueSummary}${hiddenSuffix}`,
    undefined,
    {
      phase: options.phase,
      turn: options.turn,
      issueCount: validation.issues.length,
      issues: validation.issues.slice(0, 20),
    }
  )
}
export { assertValidModelHistory as assertValidModelHistoryForProvider }
export { validateModelHistory as validateModelHistoryForProvider }
