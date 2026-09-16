import { isNumber } from '@velaros-ai/core'

import { ContextRetrievalBoundedRecentMap } from './ContextRetrievalBoundedRecentMap'

/**
 * 有界计数器：按字符串键累加次数，键太多时按最近使用淘汰最旧的那批。
 *
 * 实现是 `ContextRetrievalBoundedCounter`，检索层拿它数「同一个查询这轮被搜了几次」；只在内存里、进程重启清零。
 * 被淘汰的键再来会从 1 重新数，所以它只适合做重复搜索提醒这类可以丢的判断，不能当精确账。
 */
export interface ContextRetrievalBoundedCounterApi {
  /** 当前记着几个键；上限是构造时给的 maxEntries。 */
  readonly size: number
  /** 给这个键加一并返回加完之后的次数：第一次见到返回 1，返回值 > 1 就说明这轮重复搜了。 */
  increment(key: string): number
}

class ContextRetrievalBoundedCounter implements ContextRetrievalBoundedCounterApi {
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
