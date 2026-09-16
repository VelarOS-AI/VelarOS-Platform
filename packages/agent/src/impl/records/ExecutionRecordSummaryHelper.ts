import type { ModelMessage } from 'ai'

import { isArray, isBlank, isObject, isPresent, isString, truncate } from '@velaros-ai/core'

/**
 * 执行记录摘要：从一轮的模型消息里挑出最后一条用户消息，截成一行短文本，当这条执行记录在列表里的标题。
 *
 * 无状态，`ExecutionRecords` 建执行记录时调一次；找不到可用文本时统一回落成「执行任务」，不抛错。
 */
export interface ExecutionRecordSummaryHelperApi {
  /** 从后往前找第一条 user 消息，取它的纯文本（多段 text 用换行拼），去空白后截到 80 字符当摘要；全程没有可用文本时返回「执行任务」。 */
  buildExecutionSummary(messages: ModelMessage[]): string
}

/** 从模型消息序列提取最近一条用户消息作为 execution summary。 */
class ExecutionRecordSummaryHelper implements ExecutionRecordSummaryHelperApi {
  public buildExecutionSummary(messages: ModelMessage[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role !== 'user') {
        continue
      }

      if (isString(message.content)) return truncate(message.content.trim(), 80) || '执行任务'

      if (!isArray(message.content)) {
        continue
      }

      const text = message.content
        .filter((part): part is { type: 'text'; text: string } => {
          if (!isObject(part) || !isPresent(part)) return false
          const record = part as { type?: unknown; text?: unknown }
          return record.type === 'text' && isString(record.text)
        })
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join('\n')
        .trim()

      if (!isBlank(text)) return truncate(text, 80)
    }

    return '执行任务'
  }
}

export { ExecutionRecordSummaryHelper as ExecRecordSummary,ExecutionRecordSummaryHelper }
