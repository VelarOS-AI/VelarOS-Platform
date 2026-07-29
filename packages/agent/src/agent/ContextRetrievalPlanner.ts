import type { ModelMessage } from 'ai'

import { isEmpty, isRecord,isString } from '@velaros-ai/core'
import { logRuntime } from '@velaros-ai/core/logger'
import type {
  ChatContextRetrievalHandle,
  SerializedMessage,
} from '@velaros-ai/core/types'

import {
  DynamicHandlesInstruction,
  DynamicHandlesMarker,
  isContextOSGeneratedAssistantMessage,
} from './history/contextOSMessage'

const MaxHandles = 80
const MaxInjectedHandles = 40
const MaxSummaryChars = 180
const MaxInlineChars = 8_000
const log = logRuntime.tag('ContextRetrievalPlanner')

interface BuildContextRetrievalHandlesInput {
  sessionId: string
  messages: SerializedMessage[]
}

interface BuildModelHistoryRetrievalHandlesInput {
  sessionId: string
  messages: ModelMessage[]
}

function truncate(value: string, maxChars: number): string {
  const trimmed = value.trim()
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars).trimEnd()}...` : trimmed
}

function estimateSerializedChars(value: unknown): number {
  try {
    return JSON.stringify(value).length
  } catch (error) {
    log.debug('估算上下文检索句柄大小失败，使用字符串长度兜底', {
      error: String(error),
    })
    return String(value).length
  }
}

function toRetrievalHandleRole(role: ModelMessage['role']): LooseOptional<SerializedMessage['role']> {
  return role === 'user' || role === 'assistant' ? role : undefined
}

function buildMessageSummary(message: SerializedMessage): string {
  const text = message.textBlocks
    .map((block) => block.trim())
    .filter((block) => block.length)
    .join('\n')
  const toolNames = message.toolCalls.map((toolCall) => toolCall.toolName)
  const parts = [
    text ? truncate(text, MaxSummaryChars) : null,
    !isEmpty(toolNames) ? `tools: ${[...new Set(toolNames)].join(', ')}` : null,
  ].filter((item): item is string => Boolean(item))

  return parts.join(' | ') || `${message.role} message`
}

/** 负责为压缩上下文生成动态检索句柄，并把索引注入模型历史。 */
class ContextRetrievalPlanner {
  /** 根据会话消息构建可供后续轮次按需读取的检索句柄。 */
  public buildHandles(input: BuildContextRetrievalHandlesInput): ChatContextRetrievalHandle[] {
    const handles: ChatContextRetrievalHandle[] = []

    input.messages.forEach((message, messageIndex) => {
      if (!isEmpty(message.textBlocks) || !isEmpty(message.toolCalls)) {
        handles.push({
          id: `message:${messageIndex}`,
          kind: 'message',
          sessionId: input.sessionId,
          sourceMessageIndex: messageIndex,
          role: message.role,
          label: `${message.role} message #${messageIndex + 1}`,
          summary: buildMessageSummary(message),
          estimatedChars: estimateSerializedChars(message),
          priority: messageIndex,
          metadata: {
            textBlocks: message.textBlocks.length,
            toolCalls: message.toolCalls.length,
          },
        })
      }

      message.toolCalls.forEach((toolCall, toolIndex) => {
        handles.push({
          id: `tool:${toolCall.toolCallId}`,
          kind: 'tool-result',
          sessionId: input.sessionId,
          sourceMessageIndex: messageIndex,
          role: message.role,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          label: `${toolCall.toolName} result`,
          summary: truncate(
            `${toolCall.toolName} result from message #${messageIndex + 1}`,
            MaxSummaryChars
          ),
          estimatedChars: estimateSerializedChars(toolCall.serializedResult ?? toolCall.args),
          priority: messageIndex * 10 + toolIndex,
          metadata: {
            hasSerializedResult:isString(toolCall.serializedResult),
          },
        })
      })
    })

    return this.prioritizeHandles(handles)
  }

  /** 从 provider 回放历史构建检索句柄（runtime compact 后自动注入 manifest 时使用）。 */
  public buildHandlesFromModelHistory(
    input: BuildModelHistoryRetrievalHandlesInput
  ): ChatContextRetrievalHandle[] {
    const handles: ChatContextRetrievalHandle[] = []

    input.messages.forEach((message, messageIndex) => {
      if (isString(message.content) && message.content.trim()) {
        handles.push({
          id: `message:${messageIndex}`,
          kind: 'message',
          sessionId: input.sessionId,
          sourceMessageIndex: messageIndex,
          role: toRetrievalHandleRole(message.role),
          label: `${message.role} message #${messageIndex + 1}`,
          summary: truncate(message.content, MaxSummaryChars),
          estimatedChars: message.content.length,
          priority: messageIndex,
        })
      }

      if (!Array.isArray(message.content)) return

      const content: unknown[] = message.content
      content.forEach((part, partIndex) => {
        if (!isRecord(part) || part.type !== 'tool-result') return

        const toolCallId = part.toolCallId
        const toolName = part.toolName
        const output = part.output
        if (!isString(toolCallId) || !isString(toolName) || !isRecord(output)) return

        const outputValue = output.value
        const estimatedChars = isString(outputValue) ? outputValue.length : 0
        handles.push({
          id: `tool:${toolCallId}`,
          kind: 'tool-result',
          sessionId: input.sessionId,
          sourceMessageIndex: messageIndex,
          role: toRetrievalHandleRole(message.role),
          toolCallId,
          toolName,
          label: `${toolName} result`,
          summary: truncate(`${toolName} result from message #${messageIndex + 1}`, MaxSummaryChars),
          estimatedChars,
          priority: messageIndex * 10 + partIndex,
          metadata: {
            hasSerializedResult: isString(outputValue),
          },
        })
      })
    })

    return this.prioritizeHandles(handles)
  }

  /** 把检索句柄索引注入模型历史，供后续轮次按需读取压缩细节。 */
  public injectRetrievalIndex(
    history: ModelMessage[],
    handles: ChatContextRetrievalHandle[]
  ): ModelMessage[] {
    const text = this.buildRetrievalIndexText(handles)
    if (!text) return history

    const firstMessage = history[0]
    if (
      firstMessage?.role === 'assistant' && isString(firstMessage.content) &&
      isContextOSGeneratedAssistantMessage(firstMessage)
    ) return [
        {
          ...firstMessage,
          content: `${firstMessage.content}\n\n${text}`,
        },
        ...history.slice(1),
      ]

    return [
      {
        role: 'assistant',
        content: text,
      },
      ...history,
    ]
  }

  private prioritizeHandles(
    handles: ChatContextRetrievalHandle[]
  ): ChatContextRetrievalHandle[] {
    return handles
      .sort((left, right) => {
        const kindPriority =
          (left.kind === 'tool-result' ? 0 : 1) - (right.kind === 'tool-result' ? 0 : 1)
        if (kindPriority !== 0) return kindPriority

        return right.priority - left.priority
      })
      .slice(0, MaxHandles)
      .sort((left, right) => left.priority - right.priority)
  }

  private buildRetrievalIndexText(handles: ChatContextRetrievalHandle[]): LooseOptional<string> {
    if (isEmpty(handles)) return null

    const lines = [
      DynamicHandlesMarker,
      DynamicHandlesInstruction,
    ]
    let inlineChars = lines.join('\n').length

    for (const handle of handles.slice(-MaxInjectedHandles)) {
      const tool = handle.toolName ? ` | tool=${handle.toolName}` : ''
      const role = handle.role ? ` | role=${handle.role}` : ''
      const entry =
        `- ${handle.id} | ${handle.kind}${role}${tool} | ` +
        `${handle.estimatedChars} chars | ${handle.summary}`
      if (inlineChars + entry.length > MaxInlineChars) {
        lines.push('- 检索句柄内联预算已用尽；请先使用已经可见的句柄。')
        break
      }

      lines.push(entry)
      inlineChars += entry.length
    }

    return lines.join('\n')
  }
}

const contextRetrievalPlanner = new ContextRetrievalPlanner()

export { ContextRetrievalPlanner, contextRetrievalPlanner }
export type { BuildContextRetrievalHandlesInput }
