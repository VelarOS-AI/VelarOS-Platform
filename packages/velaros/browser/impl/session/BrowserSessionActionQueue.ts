import { AppError } from '@velaros-ai/core/error'

import type { BrowserSessionActionOptions, BrowserSessionQueueState } from '../../types/session.js'
import { createQueueSlot, executeInTurn } from '../../utils/session'

/** 每个会话串行；超时只结束调用等待，仍在运行的动作隔离该会话直到真正收束。 */
export interface BrowserSessionActionQueueApi {
  /** 同一会话的动作按顺序执行；未收束的超时动作阻止同会话继续派发。 */
  run<T>(
    sessionId: string,
    action: () => Promise<T>,
    options?: BrowserSessionActionOptions
  ): Promise<T>
  /** 只读动作也访问共享页面，因此遵循同一条串行队列。 */
  runReadOnly<T>(
    sessionId: string,
    action: () => Promise<T>,
    options?: BrowserSessionActionOptions
  ): Promise<T>
  /** 使当前世代失效、拒绝排队者；拆卸在队列外执行。正在运行的旧动作仍占有会话身份。 */
  clear(sessionId: string): void
  /** 使全部现有世代失效，独立的新会话仍可使用。 */
  clearAll(): void
  /** 页面资源重新挂接或查找前核对；旧动作未收束时禁止复用同一身份。 */
  assertAvailable(sessionId: string): void
}

class BrowserSessionActionQueue implements BrowserSessionActionQueueApi {
  private readonly states = new Map<string, BrowserSessionQueueState>()

  public async run<T>(
    sessionId: string,
    action: () => Promise<T>,
    options: BrowserSessionActionOptions = {}
  ): Promise<T> {
    this.assertAvailable(sessionId)
    let state = this.states.get(sessionId)
    if (!state) {
      state = {
        tail: Promise.resolve(),
        controller: new AbortController(),
        active: 0,
        invalidated: false,
      }
      this.states.set(sessionId, state)
    }
    const current = state
    const previous = current.tail
    const slot = createQueueSlot()
    const tail = previous.then(() => slot.released)
    current.tail = tail
    void tail.then(() => {
      if (this.states.get(sessionId) === current && current.tail === tail && current.active === 0)
        this.states.delete(sessionId)
    })
    const signal = options.signal
      ? AbortSignal.any([options.signal, current.controller.signal])
      : current.controller.signal
    try {
      return await executeInTurn(
        previous,
        slot,
        async () => {
          signal.throwIfAborted()
          current.active++
          try {
            return await action()
          } finally {
            current.active--
          }
        },
        { ...options, signal }
      )
    } catch (error) {
      // 一个已超时但尚未完成的动作不能与下一项共用页面。取消排队者，使所有调用及时得到结果。
      if (AppError.from(error).code === 'TIMEOUT' && current.active > 0) this.clear(sessionId)
      throw error
    }
  }

  public runReadOnly<T>(
    sessionId: string,
    action: () => Promise<T>,
    options: BrowserSessionActionOptions = {}
  ): Promise<T> {
    return this.run(sessionId, action, options)
  }

  public assertAvailable(sessionId: string): void {
    if (this.states.get(sessionId)?.invalidated)
      throw new AppError(
        'CLOSED',
        '浏览器会话仍有未收束的旧动作，不能复用页面；关闭页面并使用新会话，或等待旧动作完成。'
      )
  }

  public clear(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (!state) return
    state.invalidated = true
    state.controller.abort(new AppError('CLOSED', '浏览器会话已关闭或动作超时，排队动作已取消。'))
    // 没有运行中的动作时可立即换新世代；旧排队者仍持有已取消的旧 controller，永远不会执行。
    if (state.active === 0) this.states.delete(sessionId)
  }

  public clearAll(): void {
    for (const sessionId of this.states.keys()) this.clear(sessionId)
  }
}

export { BrowserSessionActionQueue }
