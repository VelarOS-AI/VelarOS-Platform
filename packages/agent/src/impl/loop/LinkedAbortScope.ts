import type { LinkedAbortScope as LinkedAbortScopeContract } from '../../types/loop.js'

/**
 * 一次尝试的取消作用域：向下派生、向上只监听。
 *
 * 谁建：`StreamTurn` 每轮开一个（父信号 = 执行中止 + 运行时插话中断），每次连接重试再从它派生一个
 * 请求级的；`QueryTurn` 每次请求开一个。谁用：作用域的 `signal` 就是交给模型请求的 `abortSignal`。
 * 父信号触发 → 本作用域随之取消 → provider 流抛中断；反向永不成立。
 * 生命周期：用完必须在 `finally` 里 `dispose()`，否则父信号上的监听器会随重试越积越多。
 */
export interface LinkedAbortScopeApi extends LinkedAbortScopeContract {
  /** 交给本次模型请求的取消信号；父信号断或自己 `abort` 都会让它进入 aborted。 */
  signal: AbortSignal
  /** 主动取消本次尝试（通常是本轮抛错时带上错误当 reason）；已取消时什么都不做。 */
  abort(reason?: unknown): void
  /** 摘掉挂在父信号上的监听器。只解绑，不取消自己，更不会回头取消父信号。 */
  dispose(): void
}

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

export { LinkedAbortScope }
