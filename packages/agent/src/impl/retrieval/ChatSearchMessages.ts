// 会话消息索引：把历史消息折成可搜索的正文与工具块。
import type { ChatMessage, ToolCallBlock } from '../../types/agent'
import type { IndexedSessionMessage, MessageSearchIndex } from '../../types/retrieval'
import { buildIndexedSessionMessages, buildMessageSearchIndex, getMessageText, getMessageToolBlocks } from '../../utils/retrieval/messages'

/**
 * 会话消息的索引面：把历史消息折成可搜索的正文、工具块与带序号的条目。
 * 召回服务与产品的本地搜索共用同一份切分，无状态，进程内共用一份。
 */
export interface ChatSearchMessagesApi {
  /** 取一条消息里可搜索的正文。 */
  getMessageText(message: ChatMessage): string
  /** 取一条消息里的工具调用与结果块。 */
  getMessageToolBlocks(message: ChatMessage): ToolCallBlock[]
  /** 给一条消息建搜索索引项。 */
  buildMessageSearchIndex(message: ChatMessage, toolArgsMaxChars?: 1000): MessageSearchIndex
  /** 把整条会话的消息折成带序号的索引条目。 */
  buildIndexedSessionMessages(messages: ChatMessage[]): IndexedSessionMessage[]
}

/** 方法逐个转调 utils/retrieval/messages 里的纯函数；这里只负责把它们收成一件对外能力。 */
class ChatSearchMessages implements ChatSearchMessagesApi {
  public getMessageText(message: ChatMessage): string {
    return getMessageText(message)
  }

  public getMessageToolBlocks(message: ChatMessage): ToolCallBlock[] {
    return getMessageToolBlocks(message)
  }

  public buildMessageSearchIndex(message: ChatMessage, toolArgsMaxChars?: 1000): MessageSearchIndex {
    return buildMessageSearchIndex(message, toolArgsMaxChars)
  }

  public buildIndexedSessionMessages(messages: ChatMessage[]): IndexedSessionMessage[] {
    return buildIndexedSessionMessages(messages)
  }
}

/** 会话消息索引面（无状态，进程内共用一份）。 */
export const chatSearchMessages: ChatSearchMessagesApi = new ChatSearchMessages()
