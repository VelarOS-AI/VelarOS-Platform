/**
 * 浏览器会话队列
 * - 同一 session 的所有 WebContents 操作串行执行，避免导航与快照/读取互相打断。
 * - 不同 session 仍可并发。
 */
class BrowserSessionActionQueue {
  /** 每个 session 一条 Promise 链。 */
  private readonly writeQueues = new Map<string, Promise<unknown>>()

  /** 写操作：串行排队执行 */
  public run<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(sessionId) ?? Promise.resolve()
    // 前一个 action 即使失败，也不能阻断后续排队操作。
    const current = previous.catch(() => undefined).then(action)
    const tracked = current
      .catch(() => undefined)
      .finally(() => {
        if (this.writeQueues.get(sessionId) === tracked) {
          // 只有自己仍是队尾时才清理，避免清掉后来追加的操作。
          this.writeQueues.delete(sessionId)
        }
      })

    this.writeQueues.set(sessionId, tracked)
    return current
  }

  /**
   * 只读操作仍会访问共享 WebContents，需要跟导航/点击保持顺序。
   *
   * 当前实现与 run 行为完全一致；保留独立方法是给未来扩展（如读写锁、并行读）留接口。
   * 现阶段不要把它当成“可以并发”的标志。
   */
  public runReadOnly<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    return this.run(sessionId, action)
  }

  public clear(sessionId: string): void {
    this.writeQueues.delete(sessionId)
  }

  public clearAll(): void {
    this.writeQueues.clear()
  }
}

export { BrowserSessionActionQueue }
