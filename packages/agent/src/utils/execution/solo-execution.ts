/**
 * 把调用方传进来的外部 `AbortSignal` 转接到本次执行自己的 `AbortController` 上，并返回解绑函数：
 * 外部信号已经 aborted 时立刻转发一次（连同 `reason`）再返回空解绑，外部没给信号时直接返回空解绑。
 * 必须在 `finally` 里调返回值——同一个外部信号会被一次次执行共用，不解绑就会按执行次数累积监听器。
 */
export function bindAbortSignal(
  source: LooseOptional<AbortSignal>,
  target: AbortController
): () => void {
  if (!source) return () => {}
  const abort = (): void => {
    if (!target.signal.aborted) target.abort(source.reason)
  }
  if (source.aborted) {
    abort()
    return () => {}
  }
  source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}
