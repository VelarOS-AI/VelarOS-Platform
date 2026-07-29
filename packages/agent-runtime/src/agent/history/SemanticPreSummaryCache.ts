import { createHash } from 'node:crypto'

import type { ModelMessage } from 'ai'

export interface SemanticPreSummaryCacheEntry {
  historyHash: string
  compactedHistory: ModelMessage[]
  createdAt: number
}

export class SemanticPreSummaryCache {
  private entry: Nullable<SemanticPreSummaryCacheEntry> = null

  public buildHistoryHash(history: readonly ModelMessage[]): string {
    return createHash('sha256').update(JSON.stringify(history)).digest('hex')
  }

  public get(historyHash: string): Nullable<ModelMessage[]> {
    if (!this.entry || this.entry.historyHash !== historyHash) return null
    return this.entry.compactedHistory
  }

  public set(historyHash: string, compactedHistory: ModelMessage[]): void {
    this.entry = {
      historyHash,
      compactedHistory,
      createdAt: Date.now(),
    }
  }

  public clear(): void {
    this.entry = null
  }
}
