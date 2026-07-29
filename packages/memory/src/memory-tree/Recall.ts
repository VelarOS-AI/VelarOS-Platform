import { isBlank } from '@velaros-ai/core'

import { type MemoryTreeRepository } from './Repository'
import type { MemoryRecallItem, MemoryRecallOptions } from './Types'

export class MemoryTreeRecall {
  constructor(private readonly repository: MemoryTreeRepository) {}

  public recall(query: string, options: MemoryRecallOptions = {}): MemoryRecallItem[] {
    const normalizedQuery = query.trim()
    const rows = this.repository.recall(normalizedQuery, options)
    const reason: MemoryRecallItem['retrievalReason'] = options.deep
      ? 'deep'
      : isBlank(normalizedQuery)
        ? options.workspaceRoot || options.scopeId
          ? 'scope'
          : 'recent'
        : 'text'
    return this.repository.toRecallItems(rows, reason)
  }
}
