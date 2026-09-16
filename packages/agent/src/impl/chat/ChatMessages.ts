import type { ModelMessage, ToolResultPart } from 'ai'

import { isEmpty, isNonBlankString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { SerializedMessage } from '../../types/agent.js'
import type { AssistantModelContentPart, UserModelContentPart } from '../../types/chat.js'
import { buildUserModelMessage, dedupeSerializedToolCalls, normalizeTextBlocks } from '../../utils/chat/messages'
import { compactToolInputForModel } from '../../utils/tools/tool-result-serialization'









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
          modelMessages.push(buildUserModelMessage(message, userContent))
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
        input: compactToolInputForModel(toolCall.args, toolCall.toolCallId),
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
