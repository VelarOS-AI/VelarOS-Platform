/**
 * 用户脚本索引与代码的读写串行化队列。
 *
 * 为什么不放在 manager 实例里：索引是「整份读出 → 改一个字段 → 整份写回」，而界面与工具各自 new 一个 manager
 * （宿主按请求建实例），队列挂在实例上等于没有队列——两次修改交错时后写的那份会把先写的改动整份盖掉。
 * 总览、源码读取与自动注入读取也排在同一条队里，不能观察到修改中的代码与旧索引。
 * 队列只覆盖文件读写，不包含脚本执行；全站点共用一条队即可。
 *
 * 实例归进程：文件末尾给出进程唯一的一份，所有 manager 共用。
 */
export interface BrowserUserScriptIndexQueueApi {
  /** 把一次读取或修改排进队列：前一次结算之后才开始，前一次失败不连累这一次。 */
  run<T>(operation: () => Promise<T>): Promise<T>
}

export class BrowserUserScriptIndexQueue implements BrowserUserScriptIndexQueueApi {
  /** 队尾：最后排进来的那次修改结算（成败都算）时结算。 */
  private tail: Promise<unknown> = Promise.resolve()

  public run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation)
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
