import type { BrowserSessionActionOptions, BrowserSessionQueueSlot } from '../../types/session.js'
import { executeInTurn } from '../../utils/session'
import { createQueueSlot } from '../../utils/session'
import { BrowserTuning } from '../../utils/tuning'

/**
 * 浏览器会话队列
 * - 同一 session 的所有 WebContents 操作串行执行，避免导航与快照/读取互相打断。
 * - 不同 session 仍可并发。
 * - **任何一个动作都不能永久占住队列**：见 {@link BrowserTuning.session.actionHoldCapMs} 与 {@link BrowserSessionQueueSlot}。
 */
export interface BrowserSessionActionQueueApi {
  /** 写操作：串行排队执行 */
  run<T>(sessionId: string, action: () => Promise<T>, options?: BrowserSessionActionOptions): Promise<T>
  /**
   * 只读操作仍会访问共享 WebContents，需要跟导航/点击保持顺序。
   *
   * 当前实现与 run 行为完全一致；保留独立方法是给未来扩展（如读写锁、并行读）留接口。
   * 现阶段不要把它当成“可以并发”的标志。
   */
  runReadOnly<T>(sessionId: string, action: () => Promise<T>, options?: BrowserSessionActionOptions): Promise<T>
  /**
   * 丢掉这条会话现有的排队链，**下一次 `run` 立刻开跑**。
   *
   * 拆卸路径（`closeSession`）必须走它：清理绝不能排在死结后面，否则「会话卡住 → 关不掉 →
   * 重开还是那条卡住的队列」，只剩重启应用一条路。已经在排队的旧动作不受影响，
   * 它们仍按原链等待，并各自被名额上限兜底。
   */
  clear(sessionId: string): void
  /** 清掉全部会话的状态；运行时收尾时调。 */
  clearAll(): void
}

class BrowserSessionActionQueue implements BrowserSessionActionQueueApi {
  /** 每个 session 一条 Promise 链；链上排的是**名额**，不是动作本身。 */
  private readonly writeQueues = new Map<string, Promise<unknown>>()

  /** 写操作：串行排队执行 */
  public run<T>(
    sessionId: string,
    action: () => Promise<T>,
    options: BrowserSessionActionOptions = {}
  ): Promise<T> {
    const previous = this.writeQueues.get(sessionId) ?? Promise.resolve()
    const slot = createQueueSlot()
    // 前一个 action 即使失败，也不能阻断后续排队操作。
    // @arch-guard:suspend code-style/forbid-swallowed-errors 理由：这里 catch 的是**前驱**的链，不是调用方那条——前驱的错误已由 executeInTurn 原样抛给它自己的调用方。此处不吞，一次失败就会把整条链变成 rejected，后面所有排队者被连坐，那正是本次要消灭的死结。
    const tail = previous.catch(() => undefined).then(() => slot.released)
    this.writeQueues.set(sessionId, tail)
    void tail.then(() => {
      if (this.writeQueues.get(sessionId) === tail) {
        // 只有自己仍是队尾时才清理，避免清掉后来追加的操作。
        this.writeQueues.delete(sessionId)
      }
    })

    return executeInTurn(previous, slot, action, options)
  }

  /**
   * 只读操作仍会访问共享 WebContents，需要跟导航/点击保持顺序。
   *
   * 当前实现与 run 行为完全一致；保留独立方法是给未来扩展（如读写锁、并行读）留接口。
   * 现阶段不要把它当成“可以并发”的标志。
   */
  public runReadOnly<T>(
    sessionId: string,
    action: () => Promise<T>,
    options: BrowserSessionActionOptions = {}
  ): Promise<T> {
    return this.run(sessionId, action, options)
  }

  /**
   * 丢掉这条会话现有的排队链，**下一次 `run` 立刻开跑**。
   *
   * 拆卸路径（`closeSession`）必须走它：清理绝不能排在死结后面，否则「会话卡住 → 关不掉 →
   * 重开还是那条卡住的队列」，只剩重启应用一条路。已经在排队的旧动作不受影响，
   * 它们仍按原链等待，并各自被名额上限兜底。
   */
  public clear(sessionId: string): void {
    this.writeQueues.delete(sessionId)
  }

  public clearAll(): void {
    this.writeQueues.clear()
  }
}

export { BrowserSessionActionQueue }
