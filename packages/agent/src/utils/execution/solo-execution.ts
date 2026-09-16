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
