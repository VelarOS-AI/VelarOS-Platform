import type { ModelMessage } from 'ai'

import { isArray, isBlank, isObject, isPresent, isString, truncate } from '@velaros-ai/core'

/** 从模型消息序列提取最近一条用户消息作为 execution summary。 */
class ExecutionRecordSummaryHelper {
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
