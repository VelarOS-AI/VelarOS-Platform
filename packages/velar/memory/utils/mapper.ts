/**
 * 记忆条目到模型面的边界映射：只带声明里有的字段，行身份、概念 id、显著度、快照版本这些内部字段不往外带。
 */

import { isEmpty } from '@velaros-ai/core'

import type { MemoryItem, MemoryRecallItem } from '../types/memory.js'

/** 一条记忆的模型面形状：证据 id 叫 sources；树上的位置只有树档有，文件档的空路径投影成缺席。 */
export function projectItem(record: MemoryRecallItem): MemoryItem {
  const item: MemoryItem = {
    id: record.id,
    title: record.title,
    summary: record.summary,
    value: record.value,
    conceptType: record.conceptType,
    predicate: record.predicate,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    confidence: record.confidence,
    activation: record.activation,
    updatedAt: record.updatedAt,
    retrievalReason: record.retrievalReason,
    sources: [...record.evidenceIds],
    sourceTypes: [...(record.sourceTypes ?? [])],
  }
  if (!isEmpty(record.path)) item.path = record.path.map((node) => ({ type: node.nodeType, title: node.title }))
  return item
}
