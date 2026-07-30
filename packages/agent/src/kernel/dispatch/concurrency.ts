// 域：子 Agent 派发的**并发闸**（按执行隔离的并发信号量）。
//
// 每个顶层执行独立持有一个 Semaphore，未达并发上限立即占用、否则进入先进先出等待队列。
// 上限由派发器按配置（advancedRuntime.maxConcurrentSubAgents，缺省 DefaultMaxConcurrentSubAgents=4）
// 惰性创建；本文件只承载闸门原语，配额解析与生命周期回收留在派发器。
//
// ## 关键不变量（改这些会破什么）
//  - **acquire 与 release 必须一一配对，且 release 在调用方的 `finally` 里**（见
//    `SubAgentDispatcher.runWorker`）。漏一次 release = 永久少一个槽位，攒满就是该执行的子 Agent
//    再也派不出去；而它不抛错、不打日志，只表现为「卡住」。
//  - **FIFO 不能换成后进先出或优先级队列**：派发顺序即用户可观察的完成顺序，乱序会让并行任务的
//    结果回灌次序与用户预期不符。
//  - **本闸不认识取消**。等待中的 acquire 不会因中断而提前返回——取消由派发器侧的 relay handle 负责
//    （worker 拿到槽位后立刻自查取消标记）。刻意如此：让信号量兼管取消会把两套生命周期缠在一起，
//    而信号量是唯一保证「槽位一定还回来」的地方，不该有第二条退出路径。

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
