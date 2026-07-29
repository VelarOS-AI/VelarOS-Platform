import type { KernelModuleHost } from '../host'
import type { ScopeRef } from '../protocol'

export interface KernelClientCapabilityBindRequest {
  readonly capabilityId: string
  readonly operations: readonly string[] | null
  readonly scope: ScopeRef | null
}

export type KernelClientAccessDecision =
  | { readonly status: 'granted' }
  | { readonly status: 'denied'; readonly reason: string }

/**
 * Product / composition-root policy for external capability session binds.
 *
 * Distinct from the Host module permission broker: this gates whether a
 * connected Client may bind a loaded capability into a session.
 */
export interface KernelClientAccessBroker {
  requestBind(
    request: KernelClientCapabilityBindRequest,
  ): Promise<KernelClientAccessDecision>
}

/** Secure default: no external Client may bind without an injected policy. */
export class DenyAllKernelClientAccessBroker
  implements KernelClientAccessBroker
{
  public async requestBind(
    request: KernelClientCapabilityBindRequest,
  ): Promise<KernelClientAccessDecision> {
    return {
      status: 'denied',
      reason:
        `Capability "${request.capabilityId}" bind is denied by the host default`,
    }
  }
}

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
