import { isNumber } from '@velaros-ai/core'

import { ContextRetrievalBoundedRecentMap } from './ContextRetrievalBoundedRecentMap'

class ContextRetrievalBoundedCounter {
  private readonly counts: ContextRetrievalBoundedRecentMap<number>

  constructor(maxEntries: number) {
    this.counts = new ContextRetrievalBoundedRecentMap(maxEntries)
  }

  get size(): number {
    return this.counts.size
  }

  public increment(key: string): number {
    const current = this.counts.get(key)
    const next = isNumber(current) ? current + 1 : 1
    this.counts.set(key, next)
    return next
  }
}

export { ContextRetrievalBoundedCounter }
