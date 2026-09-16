import type { KernelInputDelivery, KernelRuntimeStatus, KernelSessionInputKind, ResolveKernelRuntimeStatusInput } from '../../types/execution.js'

/** 一条会话输入按种类决定投递方式：引导插队、其余排队。 */
export function resolveKernelInputDelivery(input: { kind: KernelSessionInputKind }): KernelInputDelivery {
  return input.kind === 'guidance' ? 'steer' : 'queue'
}

/** 把会话的在途状态归约成一份对外的运行态快照（含"能不能取消"的结论）。 */
export function resolveKernelRuntimeStatus(input: ResolveKernelRuntimeStatusInput): KernelRuntimeStatus {
  const hasPendingConfirmation = !!input.hasPendingConfirmation
  const hasPendingInput = !!input.hasPendingInput
  const running = !!input.running
  const cancelRequested = !!input.cancelRequested
  const queuedInputs = Math.max(0, Math.floor(input.queuedInputs ?? 0))
  const backgroundJobs = Math.max(0, Math.floor(input.backgroundJobs ?? 0))
  const pendingPrompt = hasPendingConfirmation || hasPendingInput

  return {
    hasPendingConfirmation,
    hasPendingInput,
    running,
    pendingPrompt,
    cancelRequested,
    cancellable: running || pendingPrompt || queuedInputs > 0 || backgroundJobs > 0,
    queuedInputs,
    backgroundJobs,
  }
}
