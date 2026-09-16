import type { LinkedAbortScope as LinkedAbortScopeApi } from '../../types/loop.js'

/**
 * 每次向模型提供方发起的尝试各自持有自己的取消控制。
 *
 * 父信号只被「监听」，不被接管：dispose 只摘掉监听器，绝不反过来取消父信号——
 * 一次尝试的收尾不能把整轮执行也带走。
 */
class LinkedAbortScope implements LinkedAbortScopeApi {
  private readonly controller = new AbortController()
  /** 摘监听器的收尾动作，dispose 时逐个执行。 */
  private readonly disposers: Array<() => void> = []

  constructor(parentSignals: readonly AbortSignal[]) {
    for (const parentSignal of parentSignals) {
      const forwardParentAbort = (): void => this.abort(parentSignal.reason)
      if (parentSignal.aborted) forwardParentAbort()
      else {
        parentSignal.addEventListener('abort', forwardParentAbort, { once: true })
        this.disposers.push(() => parentSignal.removeEventListener('abort', forwardParentAbort))
      }
    }
  }

  /** 本次尝试自己的取消信号。 */
  public get signal(): AbortSignal {
    return this.controller.signal
  }

  /** 取消本次尝试；已取消时是无操作。 */
  public abort = (reason?: unknown): void => {
    if (!this.controller.signal.aborted) this.controller.abort(reason)
  }

  /** 摘掉父信号的监听；不取消自身。 */
  public dispose = (): void => {
    for (const dispose of this.disposers) dispose()
  }
}

/** 开一条只监听、不接管父信号的取消作用域。 */
function createLinkedAbortScope(...parentSignals: AbortSignal[]): LinkedAbortScopeApi {
  return new LinkedAbortScope(parentSignals)
}

export { createLinkedAbortScope }
