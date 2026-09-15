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

  /**
   * 本闸的并发上限——**全系统唯一的那个数**。
   *
   * 对外可读是刻意的：`agent:run_workflow` 的 lane 调度器按它开 runner，而不是自带一个常量。
   * 曾经存在第二本账（workflow 自己的 `MaxWorkflowConcurrency`），净效果是模型拿到的
   * `effective_limits.max_concurrency` 与实际排队行为漂移：声明 4，实际只有信号量剩余槽位
   * 那么多能跑，而模型从任何返回值里都看不出自己被卡住。加第二个并发上限前先回答
   * 「两个数漂移时以谁为准」——答不上就是不该加。
   */
  public get maxConcurrency(): number {
    return this.limit
  }

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

/**
 * 一次执行此刻的真实派发配额快照（`SubAgentDispatcher.describeExecutionLimits` 的返回形状）。
 *
 * 三个数**全是运行态真值**，不是任何一方的声明值。消费方（目前只有 `agent:run_workflow`）
 * 拿它当自己的上限，并原样回显给模型——回显的必须是"你实际能拿到多少"，不是"你申请了多少"。
 */
interface SubAgentDispatchLimitsSnapshot {
  /** 该执行的并发信号量上限（同时能有几个子 Agent 在跑）。 */
  maxConcurrentSubAgents: number
  /** 该执行的子 Agent 派发总量帽。 */
  maxSubAgentsPerExecution: number
  /** 总量帽还剩多少次可派发（已扣除本执行此前的派发）。 */
  remainingDispatchBudget: number
}

export { Semaphore }
export type { SubAgentDispatchLimitsSnapshot }
