
import type { ChatMessage, TextBlock, ToolCallBlock } from '../../types/agent.js'
import type { IndexedSessionMessage,MessageSearchIndex } from '../../types/retrieval.js'

import { chatSearchText } from './text'

/** 索引中单条 tool-call 的 args 序列化字符上限（仅影响 searchableText，不影响 retrieve 全文）。 */
const indexedMessageToolArgsChars = 1_000

/**
 * 合并消息内所有 type=text 的 block，trim 后以换行连接。
 * 无 text block 时返回空字符串。
 */
function getMessageText(message: ChatMessage): string {
    return message.blocks
      .filter((block): block is TextBlock => block.type === 'text')
      .map((block) => block.text.trim())
      .filter((text) => text.length)
      .join('\n')
  }

/**
 * 取出消息内全部 tool-call block，供 retrieve 时展开 args/error。
 */
function getMessageToolBlocks(message: ChatMessage): ToolCallBlock[] {
    return message.blocks.filter((block): block is ToolCallBlock => block.type === 'tool-call')
  }

/**
 * 构建单条消息的搜索索引。
 *
 * @param message 源消息
 * @param toolArgsMaxChars 每个 tool args 经 stringifyPayload 的上限，默认 indexedMessageToolArgsChars
 */
function buildMessageSearchIndex(message: ChatMessage, toolArgsMaxChars = indexedMessageToolArgsChars): MessageSearchIndex {
    const text = getMessageText(message)
    const toolBlocks = getMessageToolBlocks(message)
    const toolNames = [...new Set(toolBlocks.map((block) => block.toolName))]

    return {
      text,
      toolNames,
      searchableText: [
        text,
        message.role,
        message.id,
        ...toolNames,
        ...toolBlocks.map((block) => chatSearchText.stringifyPayload(block.args, toolArgsMaxChars)),
      ].join('\n'),
    }
  }

/**
 * 批量索引会话消息数组，附加 messageIndex（与数组下标一致）。
 *
 * @param messages 通常来自 StoredChatSession.messages 或 StateStore.loadSessionMessages
 */
function buildIndexedSessionMessages(messages: ChatMessage[]): IndexedSessionMessage[] {
    return messages.map((message, index) => {
      const { text, searchableText } = buildMessageSearchIndex(message)

      return {
        messageId: message.id,
        messageIndex: index,
        role: message.role,
        timestamp: message.timestamp,
        text,
        searchableText,
      }
    })
  }

/** 全进程唯一的消息索引实例。 */
export const chatSearchMessages = Object.freeze({
  getMessageText,
  getMessageToolBlocks,
  buildMessageSearchIndex,
  buildIndexedSessionMessages,
})
