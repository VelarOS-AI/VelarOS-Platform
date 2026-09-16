import type { KernelModuleHost } from '../runtime/KernelModuleHost'

import type {
  KernelClientAccessBroker,
  KernelClientAccessDecision,
  KernelClientCapabilityBindRequest,
} from './DenyAllKernelClientAccessBroker'

/**
 * Allows bind for any capability currently provided by a loaded module.
 *
 * Suitable for a Kernel process whose module set is already composition-rooted.
 */
export class AllowLoadedKernelClientAccessBroker
  implements KernelClientAccessBroker
{
  public constructor(private readonly host: KernelModuleHost) {}

  public async requestBind(
    request: KernelClientCapabilityBindRequest,
  ): Promise<KernelClientAccessDecision> {
    for (const snapshot of this.host.listModules()) {
      if (
        snapshot.manifest.provides.some(
          (token) => token.id === request.capabilityId,
        )
      ) return { status: 'granted' }
    }
    return {
      status: 'denied',
      reason:
        `Capability "${request.capabilityId}" is not provided by any loaded module`,
    }
  }
}
