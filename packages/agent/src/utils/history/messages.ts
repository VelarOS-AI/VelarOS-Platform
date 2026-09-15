import type { ModelMessage, ToolCallPart, ToolResultPart } from 'ai'

import { isArray, isBoolean,isNonBlankString,isNumber, isObject, isPresent, isString } from '@velaros-ai/core'
import { logRuntime } from '@velaros-ai/core/logger'

const log = logRuntime.tag('AgentHistoryMessages')

export interface HistoryToolCallReference {
  toolCallId: string
  toolName: string
}

class HistoryMessages {
  public extractAssistantToolCalls(message: ModelMessage): HistoryToolCallReference[] {
    if (message.role !== 'assistant' || !isArray(message.content)) return []

    return message.content
      .filter((part): part is ToolCallPart => this.isToolCallPart(part))
      .map((part) => ({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
      }))
  }

  public extractAssistantToolCallIds(message: ModelMessage): string[] {
    return this.extractAssistantToolCalls(message).map((part) => part.toolCallId)
  }

  public extractToolResultIds(message: ModelMessage): string[] {
    if (message.role !== 'tool' || !isArray(message.content)) return []

    return message.content
      .filter((part): part is ToolResultPart => this.isToolResultPart(part))
      .map((part) => part.toolCallId)
  }

  public extractTextContent(message: ModelMessage): string {
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

  public isToolCallPart(part: unknown): part is ToolCallPart {
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

  public isToolResultPart(part: unknown): part is ToolResultPart {
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

  public previewDynamicValue(value: unknown, maxLength: number): Nullable<string> {
    if (isString(value)) return this.previewText(value, maxLength)

    if (isNumber(value) || isBoolean(value)) return this.previewText(String(value), maxLength)

    if (!isPresent(value)) return null

    try {
      const serialized = JSON.stringify(value)
      if (!serialized || serialized === '{}' || serialized === '[]' || serialized === 'null') return null

      return this.previewText(serialized, maxLength)
    } catch (error) {
      log.debug('序列化未知历史消息片段失败，跳过预览', {
        error: String(error),
      })
      return null
    }
  }

  public previewText(text: string, maxLength: number): Nullable<string> {
    const normalized = text.trim().replace(/\s+/g, ' ')
    if (!normalized) return null

    return normalized.length > maxLength
      ? `${normalized.slice(0, maxLength)}…`
      : normalized
  }
}

export { HistoryMessages }
export { HistoryMessages as AgentHistoryMessageHelper }
