/**
 * 小型最近使用 Map：命中和写入都会把 key 移到队尾，超过容量时淘汰最旧 key。
 * 仅用于进程内诊断/重复提醒状态，不承担持久化语义。
 */
import { isNumber,isString } from '@velaros-ai/core'
class ContextRetrievalBoundedRecentMap<Value> {
  private readonly maxEntries: number
  private readonly values = new Map<string, Value>()

  constructor(maxEntries: number) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries))
  }

  get size(): number {
    return this.values.size
  }

  public get(key: string): Nullable<Value> {
    if (!this.values.has(key)) return null

    const value = this.values.get(key) as Value
    this.values.delete(key)
    this.values.set(key, value)
    return value
  }

  /** 显式失效一个键（会话删除/重置的清场通道）；不存在时是无操作。 */
  public delete(key: string): void {
    this.values.delete(key)
  }

  public set(key: string, value: Value): void {
    if (this.values.has(key)) {
      this.values.delete(key)
    }

    this.values.set(key, value)
    this.trim()
  }

  private trim(): void {
    while (this.values.size > this.maxEntries) {
      const oldestKey = this.values.keys().next().value
      if (!isString(oldestKey)) return

      this.values.delete(oldestKey)
    }
  }
}

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

export { ContextRetrievalBoundedCounter, ContextRetrievalBoundedRecentMap }
