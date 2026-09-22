import type { TurnContextAppendListener } from '../contract/requires.js'
import type { TurnContextSourceId } from '../types/activity.js'

/** 会话活动记录的唯一访问接口。 */
export interface TurnContextAppendHubApi {
  /** 订阅任意 source 的 delta 写入通知；订阅时不补发历史，返回的函数用来退订。 */
  subscribe(listener: TurnContextAppendListener): () => void
  /** 广播一次「某会话的某个 source 刚写入」的通知；逐个监听器隔离异常，监听器抛错不影响其余监听器，也不回传给账本。 */
  emit(sessionId: string, sourceId: string): void
}

/**
 * 环境 delta 写入的通知面：账本每写进一条可见 source 的 delta 就广播一次，订阅方（IPC 推送层）据此去重新 peek。
 * 只发「有变化」这个信号，不带内容；形状与公开端口 `TurnContextAppendBus` 一致，注入时按那个类型传。
 *
 * 实现是 `TurnContextAppendHub`，每宿主一个实例，状态只在实例里。
 */

/**
 * 环境 delta 写入通知总线（每宿主一个实例，经 composition 注入给账本与订阅方）。
 *
 * 可见 source 的 append 广播给订阅方（IPC 推送层自行防抖后通知 renderer 重新 peek）。
 * 状态收进实例后，多宿主同进程装配各持一份、互不串会话/串宿主——不再靠模块级全局 Set。
 * 监听器异常逐个隔离，绝不冒泡进账本写入。
 */
export class TurnContextAppendHub implements TurnContextAppendHubApi {
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

/** 建一个回合上下文写入总线：各来源往同一条总线投递环境变化。 */
export function createTurnContextAppendHub(): TurnContextAppendHubApi {
  return new TurnContextAppendHub()
}
