import type { ChatMessage, TextBlock, ToolCallBlock } from '@velaros-ai/core/types'

import { chatSearchText } from './Text'

/**
 * 单条 {@link ChatMessage} 的扁平搜索索引。
 * `searchableText` 是 {@link chatSearchRanking.rankContextText} 的实际输入。
 */
interface MessageSearchIndex {
  /** 仅 text block 合并后的可见正文（不含 tool 结果）。 */
  text: string
  /** 本条消息内出现过的工具名（去重）。 */
  toolNames: string[]
  /**
   * 打分用拼接串：`text` + role + id + toolNames + 各 tool args 序列化。
   * 换行分隔，全部 lowerCase 匹配在 Ranking 内完成。
   */
  searchableText: string
}

/**
 * 带会话内序号的消息索引行。
 * {@link SessionSearchService} 用 messageIndex 参与 recency；
 * messageIndex=-1 表示「仅标题命中」的合成行。
 */
interface IndexedSessionMessage {
  /** 消息 id；标题占位行为 `{sessionId}:title`。 */
  messageId: string
  /** 在 session.messages 中的下标；标题占位为 -1。 */
  messageIndex: number
  role: ChatMessage['role']
  timestamp: number
  /** 可见正文，snippet 优先取此字段。 */
  text: string
  /** 完整搜索面，见 {@link MessageSearchIndex.searchableText}。 */
  searchableText: string
}

/**
 * 从 {@link ChatMessage} 提取可搜索文本并构建索引字段。
 *
 * ## 与 `IndexBuilder` 的关系
 * 会话内检索索引 {@link ContextRetrievalIndexBuilder.build} 对每条 `message` 调用
 * {@link buildMessageSearchIndex}，结果写入 `snapshot.messages[].searchableText`。
 *
 * ## 与 `SessionSearchService` 的关系
 * 跨会话搜索对磁盘上的 `StoredChatSession.messages` 调用 {@link buildIndexedSessionMessages}，
 * 不依赖预建索引文件。
 *
 * 导出单例 {@link chatSearchMessages}。
 */
class ChatSearchMessages {
  /** 索引中单条 tool-call 的 args 序列化字符上限（仅影响 searchableText，不影响 retrieve 全文）。 */
  private readonly indexedMessageToolArgsChars = 1_000

  /**
   * 合并消息内所有 type=text 的 block，trim 后以换行连接。
   * 无 text block 时返回空字符串。
   */
  public getMessageText(message: ChatMessage): string {
    return message.blocks
      .filter((block): block is TextBlock => block.type === 'text')
      .map((block) => block.text.trim())
      .filter((text) => text.length)
      .join('\n')
  }

  /**
   * 取出消息内全部 tool-call block，供 retrieve 时展开 args/error。
   */
  public getMessageToolBlocks(message: ChatMessage): ToolCallBlock[] {
    return message.blocks.filter((block): block is ToolCallBlock => block.type === 'tool-call')
  }

  /**
   * 构建单条消息的搜索索引。
   *
   * @param message 源消息
   * @param toolArgsMaxChars 每个 tool args 经 stringifyPayload 的上限，默认 indexedMessageToolArgsChars
   */
  public buildMessageSearchIndex(
    message: ChatMessage,
    toolArgsMaxChars = this.indexedMessageToolArgsChars
  ): MessageSearchIndex {
    const text = this.getMessageText(message)
    const toolBlocks = this.getMessageToolBlocks(message)
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
  public buildIndexedSessionMessages(messages: ChatMessage[]): IndexedSessionMessage[] {
    return messages.map((message, index) => {
      const { text, searchableText } = this.buildMessageSearchIndex(message)

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
}

/** 全进程唯一的消息索引实例。 */
const chatSearchMessages = new ChatSearchMessages()

export { chatSearchMessages, type IndexedSessionMessage, type MessageSearchIndex }
