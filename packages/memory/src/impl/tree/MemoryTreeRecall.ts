import { isBlank } from '@velaros-ai/core'

import type { MemoryRecallItem, MemoryRecallOptions } from '../../types/memory'

import { type MemoryTreeRepository } from './MemoryTreeRepository'

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
