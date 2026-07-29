import type { KernelInputDelivery } from './session-lane'

export type KernelSessionInputKind = 'chat-send' | 'guidance'

export interface KernelRuntimeStatus {
  hasPendingConfirmation: boolean
  hasPendingInput: boolean
  running: boolean
  pendingPrompt: boolean
  cancelRequested: boolean
  cancellable: boolean
  queuedInputs: number
  backgroundJobs: number
}

export interface ResolveKernelRuntimeStatusInput {
  hasPendingConfirmation?: boolean
  hasPendingInput?: boolean
  running?: boolean
  cancelRequested?: boolean
  queuedInputs?: number
  backgroundJobs?: number
}

export class KernelSessionPolicy {
  public resolveDelivery(input: { kind: KernelSessionInputKind }): KernelInputDelivery {
    return input.kind === 'guidance' ? 'steer' : 'queue'
  }

  public resolveRuntimeStatus(input: ResolveKernelRuntimeStatusInput): KernelRuntimeStatus {
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
}
