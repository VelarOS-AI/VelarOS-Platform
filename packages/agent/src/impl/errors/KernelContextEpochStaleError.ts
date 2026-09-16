import { AgentErrorCodes } from '../../contract/constants.js'
import type { KernelContextEpochClaim } from '../../types/loop.js'

export class KernelContextEpochStaleError extends Error {
  public readonly code = AgentErrorCodes.contextEpochStale

  constructor(
    public readonly claim: KernelContextEpochClaim,
    public readonly currentRevision: number
  ) {
    super(
      `provider 请求携带的上下文纪元已过期：${claim.key} 声称的修订号是 ${claim.revision}，但当前修订号已经推进到 ${currentRevision}。说明上下文在本次请求组装期间被改写，请用最新上下文重新组装后再发。`
    )
    this.name = 'KernelContextEpochStaleError'
  }
}
