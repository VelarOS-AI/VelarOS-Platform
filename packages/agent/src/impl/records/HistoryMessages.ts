import type { ModelMessage, ToolCallPart, ToolResultPart } from 'ai'

import type { HistoryToolCallReference } from '../../types/history.js'
import { extractAssistantToolCallIds, extractAssistantToolCalls, extractTextContent, extractToolResultIds, isToolCallPart, isToolResultPart, previewDynamicValue, previewText } from '../../utils/history/messages'

/**
 * 模型消息历史的读取面：从一条 `ModelMessage` 里认片段、取工具调用与结果 id、取正文、压预览。
 *
 * 判据本身是纯函数（`utils/history/messages.ts`），这里只把它们收成一个可注入的件，
 * 让「什么算一条合法的 tool-call / tool-result」在结构自愈、清洗、预览三条链路上是同一份口径。
 * 无状态，谁建一份都一样。
 */
export interface HistoryMessagesApi {
  /** 从一条助手消息里取出这一轮发出的全部工具调用（调用 id + 工具名）；不是助手消息返回空数组。 */
  extractAssistantToolCalls(message: ModelMessage): HistoryToolCallReference[]
  /** 同 `extractAssistantToolCalls`，只要调用 id 列表；结构自愈按 id 配对时用。 */
  extractAssistantToolCallIds(message: ModelMessage): string[]
  /** 从一条 tool 消息里取出它回填了哪些调用 id；不是 tool 消息返回空数组。 */
  extractToolResultIds(message: ModelMessage): string[]
  /** 把一条消息里的文本片段拼成一段纯文本（字符串正文原样返回），非文本片段一律跳过。 */
  extractTextContent(message: ModelMessage): string
  /** 判断一个片段是不是结构完整的 tool-call（类型、调用 id、工具名、入参都在）。 */
  isToolCallPart(part: unknown): part is ToolCallPart
  /** 判断一个片段是不是结构完整的 tool-result（类型、调用 id、工具名、输出都在）。 */
  isToolResultPart(part: unknown): part is ToolResultPart
  /** 把任意类型的值压成一段预览文本：字符串/数字/布尔直接转，其余走 JSON；空值、空结构与序列化失败都返回 null。 */
  previewDynamicValue(value: unknown, maxLength: number): Nullable<string>
  /** 把一段文本压成预览：折叠空白并按 maxLength 截断加省略号；压完为空时返回 null。 */
  previewText(text: string, maxLength: number): Nullable<string>
}

class HistoryMessages implements HistoryMessagesApi {
  public extractAssistantToolCalls(message: ModelMessage): HistoryToolCallReference[] {
    return extractAssistantToolCalls(message)
  }

  public extractAssistantToolCallIds(message: ModelMessage): string[] {
    return extractAssistantToolCallIds(message)
  }

  public extractToolResultIds(message: ModelMessage): string[] {
    return extractToolResultIds(message)
  }

  public extractTextContent(message: ModelMessage): string {
    return extractTextContent(message)
  }

  public isToolCallPart(part: unknown): part is ToolCallPart {
    return isToolCallPart(part)
  }

  public isToolResultPart(part: unknown): part is ToolResultPart {
    return isToolResultPart(part)
  }

  public previewDynamicValue(value: unknown, maxLength: number): Nullable<string> {
    return previewDynamicValue(value, maxLength)
  }

  public previewText(text: string, maxLength: number): Nullable<string> {
    return previewText(text, maxLength)
  }
}

export { HistoryMessages as AgentHistoryMessageHelper,HistoryMessages }
