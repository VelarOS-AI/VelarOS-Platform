/**
 * 聊天历史消息转换器：`ChatMessages`。接口 `ChatMessagesApi` 在本文件的类上方。
 * 纯转换、无状态，具体的分块折叠与工具调用去重在 `src/utils/chat/messages.ts` 里。
 */

import type { ModelMessage } from 'ai'

import { isEmpty } from '@velaros-ai/core'

import type { SerializedMessage } from '../../types/agent.js'
import { buildAssistantModelContent, buildToolResultParts, buildUserModelContent, buildUserModelMessage } from '../../utils/chat/messages'

/**
 * 聊天历史消息转换器对外的唯一面：把渲染进程持久化的 `SerializedMessage`（富文本块、工具调用、
 * 图片附件）翻成模型接口吃的 `ModelMessage` 序列。无状态，发起一轮对话前临时建一个、用完即弃。
 *
 * 产物直接当模型历史投出去，所以 user / assistant / tool 三种 role 的先后顺序、以及 tool-call
 * 与 tool-result 的 toolCallId 配对必须严丝合缝，错一处模型侧就整轮报错。实现是 `ChatMessages`。
 */
export interface ChatMessagesApi {
  /**
   * 把一整段 `SerializedMessage` 按原顺序展开成 `ModelMessage` 序列。
   * assistant 消息里的 toolCalls 会被拆成紧跟其后的独立 tool 消息，调用方不必自己配对结果。
   * 空文本又无附件的消息整条跳过；历史里有工具调用却缺 serializedResult 时抛 `VALIDATION` 错，
   * 宁可不发也不投递半截历史。
   */
  toModelMessages(messages: SerializedMessage[]): ModelMessage[]
}

class ChatMessages implements ChatMessagesApi {
  public toModelMessages(messages: SerializedMessage[]): ModelMessage[] {
    const modelMessages: ModelMessage[] = []

    for (const message of messages) {
      if (message.role === 'user') {
        const userContent = buildUserModelContent(message)
        if (userContent) {
          modelMessages.push(buildUserModelMessage(message, userContent))
        }
        continue
      }

      const assistantContent = buildAssistantModelContent(message)
      if (assistantContent.length) {
        modelMessages.push({ role: 'assistant', content: assistantContent })
      }

      if (!isEmpty(message.toolCalls)) {
        modelMessages.push({ role: 'tool', content: buildToolResultParts(message) })
      }
    }

    return modelMessages
  }
}

export { ChatMessages }

/** 聊天消息的判定与投影面（无状态，进程内共用一份）。 */
export const chatMessages: ChatMessagesApi = new ChatMessages()

