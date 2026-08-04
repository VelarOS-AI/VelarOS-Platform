import type { ModelMessage, ToolCallPart, ToolResultPart } from 'ai'

import type { SerializedMessage } from '@velaros-ai/agent/protocol'
import { isEmpty, isNonBlankString,isNumber } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { compactToolInputForModel } from '../tools/toolResultSerialization'

type AssistantModelContentPart = { type: 'text'; text: string } | ToolCallPart
type UserModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; mediaType?: string }

/**
 * 折叠形如 [a,b,a,b,a,b] 的整体重复序列为 [a,b]。
 *
 * 用来解决某些模型在 retry/分段输出时把同一段 text block 重复多次的问题；
 * 只折叠“整体周期重复”的情况，避免误判正常重复内容。
 */
function collapseRepeatedSequence<T>(
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

function normalizeTextBlocks(textBlocks: string[]): string[] {
  return collapseRepeatedSequence(textBlocks, (left, right) => left === right)
}

/**
 * 同一 toolCallId 多条记录时保留最后一条。
 *
 * Agent 重试或 stream 重发时可能出现同 id 两条 tool call 记录，
 * 这里按 toolCallId 收敛，保证发给模型的历史里每个调用只出现一次。
 */
function dedupeSerializedToolCalls(
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
 * 聊天历史消息转换器。
 *
 * 把渲染进程持久化的序列化消息（含富文本、工具调用、附件等）转成
 * 模型接口接受的消息序列，并在过程中做：
 *  - 重复文本块折叠，应对模型“重发同段落”问题；
 *  - 工具调用按标识去重；
 *  - 回放给模型的历史工具输入仅压缩超大字段值。
 *
 * 转换结果会作为模型历史直接喂给大模型，因此需要严格保留用户、助手、工具
 * 三种角色的交替顺序和工具调用标识对应关系，否则会触发模型侧报错。
 */
class ChatMessages {
  /**
   * 把 SerializedMessage 序列展开为 ModelMessage 序列。
   *
   * 注意：assistant 消息中的 toolCalls 会被拆出为独立的 tool messages，
   * 调用方不需要再处理 toolResult 关联。
   */
  public toModelMessages(messages: SerializedMessage[]): ModelMessage[] {
    const modelMessages: ModelMessage[] = []

    for (const message of messages) {
      if (message.role === 'user') {
        const userContent = this.buildUserContent(message)
        if (userContent) {
          modelMessages.push({ role: 'user', content: userContent })
        }
        continue
      }

      const assistantContent = this.buildAssistantContent(message)
      if (assistantContent.length) {
        modelMessages.push({ role: 'assistant', content: assistantContent })
      }

      if (!isEmpty(message.toolCalls)) {
        modelMessages.push({ role: 'tool', content: this.buildToolResults(message) })
      }
    }

    return modelMessages
  }

  private buildUserContent(message: SerializedMessage): Nullable<string | UserModelContentPart[]> {
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

  private buildAssistantContent(message: SerializedMessage): AssistantModelContentPart[] {
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
        input: compactToolInputForModel(toolCall.args),
      })
    }

    return content
  }

  private buildToolResults(message: SerializedMessage): ToolResultPart[] {
    return dedupeSerializedToolCalls(message.toolCalls).map((toolCall) => ({
      type: 'tool-result',
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      output: {
        type: 'text',
        value: this.requireSerializedResult(toolCall),
      },
    }))
  }

  private requireSerializedResult(
    toolCall: SerializedMessage['toolCalls'][number]
  ): string {
    if (isNonBlankString(toolCall.serializedResult)) return toolCall.serializedResult

    throw new AppError(
      'VALIDATION',
      `Tool call "${toolCall.toolCallId}" is missing serializedResult.`
    )
  }
}

export { ChatMessages }
export { ChatMessages as ChatMessageHelper }
