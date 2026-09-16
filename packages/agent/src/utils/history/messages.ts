import type { ModelMessage, ToolCallPart, ToolResultPart } from 'ai'

import { isArray, isBoolean,isNonBlankString,isNumber, isObject, isPresent, isString } from '@velaros-ai/core'
import { logRuntime } from '@velaros-ai/core/logger'

import type { HistoryToolCallReference } from '../../types/history.js'

const log = logRuntime.tag('AgentHistoryMessages')

/** 判断一个片段是不是结构完整的 tool-call（类型、调用 id、工具名、入参都在）。 */
export function isToolCallPart(part: unknown): part is ToolCallPart {
  if (!isObject(part) || !isPresent(part)) return false
  const record = part as {
    type?: unknown
    toolCallId?: unknown
    toolName?: unknown
    input?: unknown
  }
  return (
    record.type === 'tool-call' &&
    isNonBlankString(record.toolCallId) &&
    isNonBlankString(record.toolName) &&
    isPresent(record.input)
  )
}

/** 判断一个片段是不是结构完整的 tool-result（类型、调用 id、工具名、输出都在）。 */
export function isToolResultPart(part: unknown): part is ToolResultPart {
  if (!isObject(part) || !isPresent(part)) return false
  const record = part as {
    type?: unknown
    toolCallId?: unknown
    toolName?: unknown
    output?: unknown
  }
  return (
    record.type === 'tool-result' &&
    isNonBlankString(record.toolCallId) &&
    isNonBlankString(record.toolName) &&
    isPresent(record.output)
  )
}

/** 从一条助手消息里取出这一轮发出的全部工具调用（调用 id + 工具名）；不是助手消息返回空数组。 */
export function extractAssistantToolCalls(message: ModelMessage): HistoryToolCallReference[] {
  if (message.role !== 'assistant' || !isArray(message.content)) return []

  return message.content
    .filter((part): part is ToolCallPart => isToolCallPart(part))
    .map((part) => ({
      toolCallId: part.toolCallId,
      toolName: part.toolName,
    }))
}

/** 同 extractAssistantToolCalls，只要调用 id 列表；结构自愈按 id 配对时用。 */
export function extractAssistantToolCallIds(message: ModelMessage): string[] {
  return extractAssistantToolCalls(message).map((part) => part.toolCallId)
}

/** 从一条 tool 消息里取出它回填了哪些调用 id；不是 tool 消息返回空数组。 */
export function extractToolResultIds(message: ModelMessage): string[] {
  if (message.role !== 'tool' || !isArray(message.content)) return []

  return message.content
    .filter((part): part is ToolResultPart => isToolResultPart(part))
    .map((part) => part.toolCallId)
}

/** 把一条消息里的文本片段拼成一段纯文本（字符串正文原样返回），非文本片段一律跳过。 */
export function extractTextContent(message: ModelMessage): string {
  if (isString(message.content)) return message.content

  if (!isArray(message.content)) return ''

  return message.content
    .filter((part): part is { type: 'text'; text: string } => {
      if (!isObject(part) || !isPresent(part)) return false
      const record = part as { type?: unknown; text?: unknown }
      return record.type === 'text' && isString(record.text)
    })
    .map((part) => part.text)
    .join(' ')
}

/** 把一段文本压成预览：折叠空白并按 maxLength 截断加省略号；压完为空时返回 null。 */
export function previewText(text: string, maxLength: number): Nullable<string> {
  const normalized = text.trim().replace(/\s+/g, ' ')
  if (!normalized) return null

  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}…`
    : normalized
}

/** 把任意类型的值压成一段预览文本：字符串/数字/布尔直接转，其余走 JSON；空值与空结构返回 null。 */
export function previewDynamicValue(value: unknown, maxLength: number): Nullable<string> {
  if (isString(value)) return previewText(value, maxLength)

  if (isNumber(value) || isBoolean(value)) return previewText(String(value), maxLength)

  if (!isPresent(value)) return null

  try {
    const serialized = JSON.stringify(value)
    if (!serialized || serialized === '{}' || serialized === '[]' || serialized === 'null') return null

    return previewText(serialized, maxLength)
  } catch (error) {
    log.debug('序列化未知历史消息片段失败，跳过预览', {
      error: String(error),
    })
    return null
  }
}
