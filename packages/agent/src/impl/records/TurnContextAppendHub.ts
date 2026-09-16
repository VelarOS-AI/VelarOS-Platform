import type { TurnContextSourceId } from '../../types/agent.js'
import type { TurnContextAppendBus, TurnContextAppendListener } from '../../types/records.js'

/**
 * 环境 delta 写入通知总线（每宿主一个实例，经 composition 注入给账本与订阅方）。
 *
 * 可见 source 的 append 广播给订阅方（IPC 推送层自行防抖后通知 renderer 重新 peek）。
 * 状态收进实例后，多宿主同进程装配各持一份、互不串会话/串宿主——不再靠模块级全局 Set。
 * 监听器异常逐个隔离，绝不冒泡进账本写入。
 */
export class TurnContextAppendHub implements TurnContextAppendBus {
  private readonly listeners = new Set<TurnContextAppendListener>()

  /** 订阅任意 source 的 delta 写入；返回退订函数。 */
  public subscribe(listener: TurnContextAppendListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 广播一次写入通知；逐监听器隔离异常。 */
  public emit(sessionId: string, sourceId: TurnContextSourceId): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId, sourceId)
      } catch {
        // arch-guard:silent-catch-ok 通知失败不影响账本写入。
      }
    }
  }
}
