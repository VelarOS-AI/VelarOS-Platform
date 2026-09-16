import type { LinkedAbortScope } from '../../types/loop.js'

/** 每次向模型提供方发起的尝试各自持有自己的取消控制；dispose 只摘掉父信号的监听，不取消自身。 */
function createLinkedAbortScope(...parentSignals: AbortSignal[]): LinkedAbortScope {
  const controller = new AbortController()
  const abort = (reason?: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason)
  }
  const disposers: Array<() => void> = []

  for (const parentSignal of parentSignals) {
    const forwardParentAbort = (): void => abort(parentSignal.reason)
    if (parentSignal.aborted) forwardParentAbort()
    else {
      parentSignal.addEventListener('abort', forwardParentAbort, { once: true })
      disposers.push(() => parentSignal.removeEventListener('abort', forwardParentAbort))
    }
  }

  return {
    signal: controller.signal,
    abort,
    dispose: () => {
      for (const dispose of disposers) dispose()
    },
  }
}

export { createLinkedAbortScope }
