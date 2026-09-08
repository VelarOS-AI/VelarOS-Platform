interface LinkedAbortScope {
  signal: AbortSignal
  abort(reason?: unknown): void
  dispose(): void
}

/** Each provider attempt owns its cancellation; disposing only detaches parent listeners. */
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
export type { LinkedAbortScope }
