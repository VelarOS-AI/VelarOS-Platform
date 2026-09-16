
import type { ChatMessage, TextBlock, ToolCallBlock } from '../../types/agent.js'
import type { IndexedSessionMessage,MessageSearchIndex } from '../../types/retrieval.js'
import { AgentTuning } from '../tuning'

import { chatSearchText } from './text'

/**
 * 合并消息内所有 type=text 的 block，trim 后以换行连接。
 * 无 text block 时返回空字符串。
 */
export function getMessageText(message: ChatMessage): string {
    return message.blocks
      .filter((block): block is TextBlock => block.type === 'text')
      .map((block) => block.text.trim())
      .filter((text) => text.length)
      .join('\n')
  }

/**
 * 取出消息内全部 tool-call block，供 retrieve 时展开 args/error。
 */
export function getMessageToolBlocks(message: ChatMessage): ToolCallBlock[] {
    return message.blocks.filter((block): block is ToolCallBlock => block.type === 'tool-call')
  }

/**
 * 构建单条消息的搜索索引。
 *
 * @param message 源消息
 * @param toolArgsMaxChars 每个 tool args 经 stringifyPayload 的上限，默认 AgentTuning.retrieval.indexedMessageToolArgsChars
 */
export function buildMessageSearchIndex(message: ChatMessage, toolArgsMaxChars = AgentTuning.retrieval.indexedMessageToolArgsChars): MessageSearchIndex {
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
export function buildIndexedSessionMessages(messages: ChatMessage[]): IndexedSessionMessage[] {
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

