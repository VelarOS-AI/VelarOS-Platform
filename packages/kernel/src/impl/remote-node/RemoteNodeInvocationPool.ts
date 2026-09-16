// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 调用侧的并发闸：只挡执行，不挡帧处理与取消。

/**
 * 有界并发闸。
 *
 * 一个 runner 一道闸。不是「队列化整条连接」:只有超过并发上限的**执行**才挂起,
 * 帧处理与取消走的是另一条路径,永远不会被这里的等待队列拖住。
 */
export interface RemoteNodeInvocationPoolApi {
  /**
   * 跑一个任务,兑现它的结果。
   *
   * 并发满时先排队;任务自己抛错时原样上抛,名额仍会归还。
   */
  run<T>(task: () => Promise<T>): Promise<T>
}

/**
 * 有界并发闸。
 *
 * 不是「队列化整条连接」:只有超过并发上限的**执行**才挂起,帧处理与取消走的是另一条路径,
 * 永远不会被这里的等待队列拖住。
 */
export class RemoteNodeInvocationPool implements RemoteNodeInvocationPoolApi {
  private readonly waiting: Array<() => void> = []
  private active = 0

  public constructor(private readonly limit: number) {}

  public async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    this.active += 1
    try {
      return await task()
    } finally {
      this.active -= 1
      this.waiting.shift()?.()
    }
  }
}

/**
 * callId → 终态结果的有界 FIFO 缓存。
 *
 * 这是「重连后按同一 callId 重试是安全的」这条承诺的物质基础。满了按最早写入淘汰——被淘汰的
 * callId 再来会被当成新调用,这是有界内存换来的已知代价,容量按一个重连窗口取。
 */
