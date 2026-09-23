import type { KernelClientAccessBroker } from '../../contract/requires'
import type {
  KernelClientAccessDecision,
  KernelClientCapabilityBindRequest,
} from '../../types/serve'

/** 安全缺省：没注入策略时，任何外部 Client 都绑不上任何能力。 */
export class DenyAllKernelClientAccessBroker implements KernelClientAccessBroker {
  public async requestBind(
    request: KernelClientCapabilityBindRequest
  ): Promise<KernelClientAccessDecision> {
    return {
      status: 'denied',
      reason: `能力 "${request.capabilityId}" 的绑定被宿主的缺省策略拒绝`,
    }
  }
}
