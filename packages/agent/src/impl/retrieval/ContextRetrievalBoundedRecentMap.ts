/**
 * 小型最近使用 Map：命中和写入都会把 key 移到队尾，超过容量时淘汰最旧 key。
 * 仅用于进程内诊断/重复提醒状态，不承担持久化语义。
 */
import { isString } from '@velaros-ai/core'

/**
 * 有界的最近使用表：读和写都把 key 顶到队尾，装满之后从队头（最久没碰过的）开始淘汰。
 *
 * 实现是 `ContextRetrievalBoundedRecentMap`，检索层的计数器和重复提醒状态各持一份；只在内存里、进程重启即清零，
 * 被淘汰的 key 下次读回 null（等同于「没见过」），所以只能拿它存可以随时丢的诊断状态，不能当账本。
 */
export interface ContextRetrievalBoundedRecentMapApi<Value> {
  /** 当前还留着几条；上限是构造时给的 maxEntries（至少 1），用来判断有没有被淘汰压力。 */
  readonly size: number
  /** 取一个 key 的值，顺带把它顶成最新使用的；没有（或已被淘汰）时返回 null。 */
  get(key: string): Nullable<Value>
  /** 显式丢掉一个 key：会话被删除或重置时的清场通道；key 不在表里就是无操作。 */
  delete(key: string): void
  /** 写入一个 key 并把它顶成最新使用的；写完超过容量就把最久没碰过的那些丢掉。 */
  set(key: string, value: Value): void
}

class ContextRetrievalBoundedRecentMap<Value> implements ContextRetrievalBoundedRecentMapApi<Value> {
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

export { ContextRetrievalBoundedRecentMap }