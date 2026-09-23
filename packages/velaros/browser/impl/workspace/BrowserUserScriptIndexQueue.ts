/**
 * 用户脚本索引的「读改写回」串行化队列。
 *
 * 为什么不放在 manager 实例里：索引是「整份读出 → 改一个字段 → 整份写回」，而界面与工具各自 new 一个 manager
 * （宿主按请求建实例），队列挂在实例上等于没有队列——两次修改交错时后写的那份会把先写的改动整份盖掉。
 * 变更都是小文件读写、跑得极快，全站点共用一条队列足够，也不会把任何长操作圈进来。
 *
 * 实例归进程：文件末尾给出进程唯一的一份，所有 manager 共用。
 */
export interface BrowserUserScriptIndexQueueApi {
  /** 把一次「读索引 → 改 → 写回」排进队列：前一次结算之后才开始，前一次失败不连累这一次。 */
  run<T>(mutate: () => Promise<T>): Promise<T>
}

export class BrowserUserScriptIndexQueue implements BrowserUserScriptIndexQueueApi {
  /** 队尾：最后排进来的那次修改结算（成败都算）时结算。 */
  private tail: Promise<unknown> = Promise.resolve()

  public run<T>(mutate: () => Promise<T>): Promise<T> {
    const next = this.tail.then(mutate, mutate)
    this.tail = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }
}

/** 进程唯一的一份：界面与工具的 manager 各是各的实例，排的是同一条队。 */
export const browserUserScriptIndexQueue: BrowserUserScriptIndexQueueApi =
  new BrowserUserScriptIndexQueue()
