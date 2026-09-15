// 域：账本追加的串行写队列（宪章 §1 数据根单写者；仓内 StateStore.runSerializedSessionWrite 先例模式）。
//
// 单写者假设由 host 的数据根锁保证，账本层不再造锁；本队列只负责**同一账本内**写任务不交错：
// 每次 enqueue 挂在 mutationTail promise 链尾，前序落定后才跑。前序 rejection 不断链——由其自身
// awaiter 上报，队列续跑后续任务。

/** 串行写队列：mutationTail promise 链，保证追加/修复/关闭按提交序不交错执行。 */
export class SerialWriteQueue {
  private tail: Promise<unknown> = Promise.resolve()

  /** 入队一个写任务；返回的 promise 携带该任务的结果或 rejection。 */
  public enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.catch(
      () => undefined /* arch-guard:silent-catch-ok 串行写队列链：前序 rejection 由 result 的 awaiter 上报，此处吞掉仅为保持队列续跑 */
    )
    return result
  }

  /** 等待当前所有已入队任务落定（用于 close 前排空）。 */
  public drain(): Promise<void> {
    return this.tail.then(
      () => undefined,
      () => undefined /* arch-guard:silent-catch-ok drain 只等落定不关心结果，各任务 rejection 已由自身 awaiter 上报 */
    )
  }
}
