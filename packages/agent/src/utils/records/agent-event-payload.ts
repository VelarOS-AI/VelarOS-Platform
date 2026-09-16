import { isArray, isBlank, isObject, isString, truncate } from '@velaros-ai/core'

import type { ExecutionEventSeverity, StreamStatePayload } from '../../types/agent.js'

/** 把运行状态词翻成账本事件的严重度：done=success，aborted=warning，error=error，其余（进行中、重连等）一律 info。 */
export function resolveRuntimeEventSeverity(kind: StreamStatePayload['kind']): ExecutionEventSeverity {
  switch (kind) {
    case 'done':
      return 'success'
    case 'aborted':
      return 'warning'
    case 'error':
      return 'error'
    default:
      return 'info'
  }
}

/** 描述模型原始输出的形状而不存正文：不是数组就只报 typeof；是数组就报元素个数和前 20 个元素各自的 type。调试面板靠它判断这一轮模型吐了什么结构。 */
export function describeAssistantRawContent(content: unknown): Record<string, unknown> {
  if (!isArray(content))
    return {
      type: typeof content,
    }

  return {
    type: 'array',
    count: content.length,
    itemTypes: content
      .map((item) =>
        item && isObject(item) ? String((item as { type?: unknown }).type) : typeof item
      )
      .slice(0, 20),
  }
}

/** 把一段文本收成账本里的摘要：连续空白压成一个空格、去掉首尾，空白串返回 null，超过 `maxChars` 就截断。 */
export function normalizeAssistantOutputSummary(value: string, maxChars: number): Nullable<string> {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (isBlank(normalized)) return null
  return truncate(normalized, maxChars)
}

/** 从模型原始输出里抽出可读的文本摘要：字符串直接收；数组则把其中 `type === 'text'` 的片段用换行拼起来。全程没有文本时返回 null。`maxChars` 是摘要的字符上限。 */
export function extractAssistantRawTextSummary(content: unknown, maxChars: number): Nullable<string> {
  if (isString(content)) return normalizeAssistantOutputSummary(content, maxChars)
  if (!isArray(content)) return null

  const text = content
    .map((item) => {
      if (!item || !isObject(item)) return ''
      const record = item as { type?: unknown; text?: unknown }
      return record.type === 'text' && isString(record.text) ? record.text : ''
    })
    .filter((item) => item.trim())
    .join('\n')

  return normalizeAssistantOutputSummary(text, maxChars)
}
