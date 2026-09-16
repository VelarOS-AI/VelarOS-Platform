import type { KernelContextEpochClaim } from '../../types/loop.js'

export class KernelContextEpochStaleError extends Error {
  public readonly code = 'KERNEL_CONTEXT_EPOCH_STALE'

  constructor(
    public readonly claim: KernelContextEpochClaim,
    public readonly currentRevision: number
  ) {
    super(
      `Stale provider request context epoch for ${claim.key}: claim revision ${claim.revision}, current revision ${currentRevision}.`
    )
    this.name = 'KernelContextEpochStaleError'
  }
}
