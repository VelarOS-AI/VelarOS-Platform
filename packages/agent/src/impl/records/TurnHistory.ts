import type { ModelMessage } from 'ai'

import type { AgentTurnToolExecutor, AgentTurnToolResult, AssistantContentPart, AssistantRawContentPart } from '../../types/history.js'
import {
  appendAssistantMessage,
  appendToolResultsToHistory,
  toAssistantRawContent,
} from '../../utils/history/turn'

/**
 * 轮次历史：把单轮产物落到模型消息历史。
 *
 * 分两类写回：
 * - 助手消息：保留文本与工具调用，剔除推理内容（推理内容仅给界面展示，
 *   重放给模型会引发某些供应方的结构冲突），且 `replayable === false` 的文本
 *   （如自动注入的提示）不会进入历史。
 * - 工具消息：从工具执行器收齐所有结果后批量写入；遇到终止错误立即抛出，
 *   终止当前查询或流式循环，由上层决定是否清洗后重试。
 *
 * 注意：当前轮工具执行使用原始输入；写入可回放历史时只压缩超大字段值，
 * 不能破坏模型传入对象的结构。
 *
 * 写回规则本身是纯函数（`utils/history/turn.ts`），这里只把它们收成一个可注入的件，
 * `TurnRunner` 建一份、`QueryTurn` 与 `StreamTurn` 从构造参数收；类自己不存状态，历史由调用方持有。
 */
export interface TurnHistoryApi {
  /**
   * 从工具执行器收齐本轮全部结果，批量写成一条 `role:'tool'` 消息追加进 `history`（原地改），
   * 返回收到的结果数组供上层继续用。执行器报了终止错误时，写回之后立刻抛出，本轮循环就此终止。
   */
  appendToolResultsToHistory(
    history: ModelMessage[],
    executor: AgentTurnToolExecutor
  ): Promise<AgentTurnToolResult[]>
  /**
   * 把本轮助手产物写回 `history`（原地改）：文本与工具调用留下，推理内容与 `replayable === false`
   * 的文本剔除。清完什么都不剩时不写空消息，历史保持原样。
   */
  appendAssistantMessage(
    history: ModelMessage[],
    assistantContent: AssistantContentPart[]
  ): void
  /** 把本轮助手产物摊成给界面回放的原始片段：文本、推理、工具调用都留着，工具入参不压缩。 */
  toAssistantRawContent(
    assistantContent: AssistantContentPart[]
  ): AssistantRawContentPart[]
}

class TurnHistory implements TurnHistoryApi {
  public async appendToolResultsToHistory(
    history: ModelMessage[],
    executor: AgentTurnToolExecutor
  ): Promise<AgentTurnToolResult[]> {
    return appendToolResultsToHistory(history, executor)
  }

  public appendAssistantMessage(
    history: ModelMessage[],
    assistantContent: AssistantContentPart[]
  ): void {
    appendAssistantMessage(history, assistantContent)
  }

  public toAssistantRawContent(
    assistantContent: AssistantContentPart[]
  ): AssistantRawContentPart[] {
    return toAssistantRawContent(assistantContent)
  }
}

export { TurnHistory as AgentTurnHistoryHelper,TurnHistory }
