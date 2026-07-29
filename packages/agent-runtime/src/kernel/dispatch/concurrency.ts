// 域：子 Agent 派发的**并发闸**（按执行隔离的并发信号量）。
//
// 每个顶层执行独立持有一个 Semaphore，未达并发上限立即占用、否则进入先进先出等待队列。
// 上限由派发器按配置（advancedRuntime.maxConcurrentSubAgents，缺省 DefaultMaxConcurrentSubAgents=4）
// 惰性创建；本文件只承载闸门原语，配额解析与生命周期回收留在派发器。

class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly limit: number) {}

  /** 未达并发上限则立即占用；否则进入先进先出等待队列。 */
  public async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return
    }

    await new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active += 1
        resolve()
      })
    })
  }

  /** 释放一个槽位并唤醒队首等待者（若有）。 */
  public release(): void {
    this.active = Math.max(this.active - 1, 0)
    const next = this.queue.shift()
    next?.()
  }
}

export { Semaphore }
