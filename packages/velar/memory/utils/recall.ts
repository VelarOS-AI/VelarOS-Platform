/**
 * 回合召回的文本规则：注入摘要怎么拼、文本怎么截。
 *
 * 这些都是纯规则，不碰实例状态；协调器只负责判要不要召回、去重与排队。
 */

import type { MemoryRecallItem } from '../types/memory.js'

import { MemoryTuning } from './tuning.js'

/** 按上限截断一段文本，超出时用省略号收尾。 */
export function truncateRecallText(value: string, maxLength: number): string {
  const normalized = value.trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

/** 把一条召回结果拼成注入模型上下文的中文摘要（深层回忆额外带一句时效提醒）。 */
export function formatRecallSummary(memory: MemoryRecallItem): string {
  const body = (memory.summary || '').replace(/\s+/gu, ' ').trim()
  const path = memory.path.map((node) => node.title).filter(Boolean).join(' → ')
  return [
    memory.retrievalReason === 'deep'
      ? '这是一次模糊的深层回忆；若用于回答，必须向用户说明它可能已经过时。'
      : '',
    `相关记忆「${truncateRecallText(memory.title, MemoryTuning.recall.summaryTitleChars)}」：`
      + `${truncateRecallText(body, MemoryTuning.recall.summaryBodyChars)}`,
    path ? `树路径：${truncateRecallText(path, MemoryTuning.recall.summarySourceChars)}` : '',
    `来源：${memory.evidenceIds.length} 条证据；置信度 ${memory.confidence.toFixed(2)}`,
  ].filter(Boolean).join('\n')
}
