import type { ScopeRef } from '../../utils/wire/capability'

export interface KernelClientCapabilityBindRequest {
  readonly capabilityId: string
  readonly operations: Nullable<readonly string[]>
  readonly scope: Nullable<ScopeRef>
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
