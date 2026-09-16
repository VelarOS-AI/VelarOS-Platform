import type { ModelMessage, ToolResultPart } from 'ai'

import { isEmpty, isNonBlankString,isNumber, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { SerializedMessage } from '../../types/agent.js'
import type { AssistantModelContentPart, UserModelContentPart } from '../../types/chat.js'
import { buildInternalFollowUpContent } from '../history/internal-messages'
import { compactToolInputForModel } from '../tools/tool-result-serialization'

/**
 * 宿主写的系统通知（当前只有会话回退说明）在模型协议里只能以 user role 传输，但它**不是**一轮
 * 用户诉求：直接当普通 user 消息投递，轮边界计数会把它算成一轮，默认只保护最近 2 轮的尾窗立刻
 * 变成「通知轮 + 当前轮」，回退点之前那个真实轮次直接掉出保护、可被降级成摘要——恰好是回退之后
 * 模型最需要看清的一段。
 *
 * 复用内部续跑的 `<sys_note>` 信封：`isInternalFollowUpMessage` 认得它，于是既不占轮边界，模型
 * 读到的也是一段明确署名「系统」的说明，而不是一句冒充用户的话。
 */
export function buildUserModelMessage(
  message: SerializedMessage,
  content: string | UserModelContentPart[]
): ModelMessage {
  if (message.conversationKind !== 'system-notice' || !isString(content))
    return { role: 'user', content }

  return { role: 'user', content: buildInternalFollowUpContent(content) }
}

/**
 * 折叠形如 [a,b,a,b,a,b] 的整体重复序列为 [a,b]。
 *
 * 用来解决某些模型在 retry/分段输出时把同一段 text block 重复多次的问题；
 * 只折叠“整体周期重复”的情况，避免误判正常重复内容。
 */
export function collapseRepeatedSequence<T>(
  values: T[],
  isEqual: (left: T, right: T) => boolean
): T[] {
  if (values.length < 2) return values

  for (let length = 1; length <= Math.floor(values.length / 2); length += 1) {
    if (values.length % length !== 0) {
      continue
    }

    let repeated = true
    for (let index = length; index < values.length; index += 1) {
      if (!isEqual(values[index], values[index % length])) {
        repeated = false
        break
      }
    }

    if (repeated) return values.slice(0, length)
  }

  return values
}

/**
 * 折叠一条消息里**整体周期性重复**的文本块（`[a,b,a,b]` → `[a,b]`），按逐字相等比对。
 * 治的是某些模型在 retry 或分段输出时把同一段正文重发好几遍的毛病。
 * 只折叠整体周期，不折叠局部重复——正常正文里出现两段一样的话（同一条命令、同一句提示）是合法的，误折会把内容改掉。
 * 折不出周期时原样返回。
 */
export function normalizeTextBlocks(textBlocks: string[]): string[] {
  return collapseRepeatedSequence(textBlocks, (left, right) => left === right)
}

/**
 * 同一 toolCallId 多条记录时保留最后一条。
 *
 * Agent 重试或 stream 重发时可能出现同 id 两条 tool call 记录，
 * 这里按 toolCallId 收敛，保证发给模型的历史里每个调用只出现一次。
 */
export function dedupeSerializedToolCalls(
  toolCalls: SerializedMessage['toolCalls']
): SerializedMessage['toolCalls'] {
  const deduped: SerializedMessage['toolCalls'] = []
  const seenIndexes = new Map<string, number>()

  toolCalls.forEach((toolCall) => {
    const existingIndex = seenIndexes.get(toolCall.toolCallId)
    if (isNumber(existingIndex)) {
      deduped[existingIndex] = toolCall
      return
    }

    seenIndexes.set(toolCall.toolCallId, deduped.length)
    deduped.push(toolCall)
  })

  return deduped
}

/**
 * 把一条用户消息压成模型能收的 content：没有图片附件时合成一段纯文本（空白就返回 null，
 * 这一条整个不投递），有图片时改走 part 数组，文本在前、图片按原顺序跟在后面。
 * 文本块先过 `normalizeTextBlocks` 折叠整体重复，再逐块去掉首尾空白并丢掉空块。
 */
export function buildUserModelContent(
  message: SerializedMessage
): Nullable<string | UserModelContentPart[]> {
  const imageAttachments = message.imageAttachments ?? []
  const textParts = normalizeTextBlocks(
    message.textBlocks.map((text) => text.trim()).filter(Boolean)
  )

  if (!imageAttachments.length) {
    const text = textParts.join('\n').trim()
    return text || null
  }

  const content: UserModelContentPart[] = textParts.map((text) => ({
    type: 'text',
    text,
  }))

  for (const attachment of imageAttachments) {
    content.push({
      type: 'image',
      image: attachment.data,
      mediaType: attachment.mediaType,
    })
  }

  return !isEmpty(content) ? content : null
}

/**
 * 把一条助手消息压成模型能收的 content part 数组：先是折叠重复后的非空文本块，再是按
 * toolCallId 去重后的 tool-call。回放给模型的历史工具入参只留压缩版（超大字段值会被裁），
 * 保证长历史不会被一次工具调用的巨型参数撑爆。返回空数组表示这条助手消息不必投递。
 */
export function buildAssistantModelContent(
  message: SerializedMessage
): AssistantModelContentPart[] {
  const content: AssistantModelContentPart[] = []

  for (const text of normalizeTextBlocks(message.textBlocks)) {
    if (text.trim()) {
      content.push({ type: 'text', text })
    }
  }

  for (const toolCall of dedupeSerializedToolCalls(message.toolCalls)) {
    content.push({
      type: 'tool-call',
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      input: compactToolInputForModel(toolCall.args, toolCall.toolCallId),
    })
  }

  return content
}

/**
 * 按助手消息里去重后的 tool call，逐个生成配对的 tool-result part。顺序与 `buildAssistantModelContent`
 * 产出的 tool-call 一致，模型侧靠 toolCallId 配对；任一条缺结果就整体抛错，宁可不发也不投递半截历史。
 */
export function buildToolResultParts(message: SerializedMessage): ToolResultPart[] {
  return dedupeSerializedToolCalls(message.toolCalls).map((toolCall) => ({
    type: 'tool-result',
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    output: {
      type: 'text',
      value: requireSerializedToolResult(toolCall),
    },
  }))
}

/**
 * 取一次工具调用落盘时存下的结果文本。缺失或全空白说明这条历史本身就是坏的（结果没写进去），
 * 此时抛 `VALIDATION` 的 `AppError` 而不是塞空串，免得模型收到一个假装成功的空结果。
 */
export function requireSerializedToolResult(
  toolCall: SerializedMessage['toolCalls'][number]
): string {
  if (isNonBlankString(toolCall.serializedResult)) return toolCall.serializedResult

  throw new AppError(
    'VALIDATION',
    `工具调用 "${toolCall.toolCallId}" 没有 serializedResult：这条历史本身就是坏的（结果没写进去），不能把它当成一次成功调用继续往下拼历史。`
  )
}
