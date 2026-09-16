// SubAgentSessionStore 用到的纯函数（不碰实例状态）。
/** 往二级索引里登记一个线程 id。 */
export function addToIndex(index: Map<string, Set<string>>, key: string, threadId: string): void {
  const threads = index.get(key) ?? new Set<string>()
  threads.add(threadId)
  index.set(key, threads)
}

/** 从二级索引里摘掉一个线程 id；这一档空了就连键一起删。 */
export function removeFromIndex(index: Map<string, Set<string>>, key: string, threadId: string): void {
  const threads = index.get(key)
  if (!threads) return
  threads.delete(threadId)
  if (threads.size === 0) index.delete(key)
}
