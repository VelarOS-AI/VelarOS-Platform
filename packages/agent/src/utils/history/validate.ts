import type { ModelMessage } from 'ai'

import { isArray, isEmpty,toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { coerceTrimmedString, isRecord } from '@velaros-ai/core/utils/unknownJsonRecord'

import type { AssertValidModelHistoryOptions,ModelHistoryValidationIssue, ModelHistoryValidationResult, ToolCallReference } from '../../types/history.js'

/** 往问题清单里追加一条校验问题（消息序号、角色、说明，`toolCallId` 可缺）。`toOptional` 把各种缺席形态归一成省略位的 `undefined`，避免问题详情里出现 `toolCallId: null` 这种第三态。 */
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

/** 把从 0 开始的消息下标写成给人看的「第 N 条消息」（下标 +1）。报错要让人能直接数到那一条，不是让人自己换算。 */
function formatMessagePosition(messageIndex: number): string {
  return `第 ${messageIndex + 1} 条消息`
}

/** 把一条校验问题拼成一行人话：`第 N 条消息 <角色>: <说明>`，有 `toolCallId` 时在末尾补上 `（toolCallId: …）`。带上 id 是为了在一条消息里有多个工具调用时，能指明是哪一个坏了。 */
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

/**
 * 在发请求**之前**把整份历史按供应方的配对规则核一遍，返回全部问题（不抛，也不在第一条就停——
 * 一次把问题列全，才不用修一条发一次、被拒一次）。
 *
 * 核心是一张「待结果的 tool-call」台账：assistant 的每个 tool-call 入账，tool-result 命中就销账；
 * 遇到非 tool 消息说明这组本该已经闭合，台账里还剩的一律记「缺少紧随其后的 tool-result」并清空；
 * 扫完历史还剩的记「到历史末尾仍缺少 tool-result」。
 * 另外还查：tool-call/tool-result 缺 `toolCallId` 或 `toolName`、同一 id 被重复 replay、
 * tool 消息 content 不是数组或为空、tool 消息里混进非 tool-result 片段、没有对应 tool-call 的孤儿 tool-result，
 * 以及 tool-result 的 `toolName` 与对应 tool-call 不一致。
 * 这些每一条都会让供应方整轮请求 400，本地先查是为了当场说清哪条消息坏了，而不是把一句供应方错误码丢给用户。
 */
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

/**
 * `validateModelHistory` 的抛错版，外加一条它不查的规则：历史**不能以 assistant 或 system 消息收尾**。
 * 以 assistant 收尾会被供应方当成 assistant prefill（要求模型接着这半句往下写）而报错；
 * 内部续跑提醒必须作为 user/tool 后续输入发出去，不能直接挂成 system 垫在最后。
 *
 * 有问题就抛 `AppError('VALIDATION')`，消息里摘前 5 条问题、其余只报个数（错误提示本身不该长得没法读），
 * 详情里再带上 `phase`、`turn` 与前 20 条问题供排查。抛出即意味着这一轮请求**根本没发出去**，
 * 宁可当场失败也不让一份坏历史撞上供应方。
 */
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
