import type { ResourceRef, ScopeRef } from './references.js'

export interface KernelPermissionRequest {
  /** The module that *provides* the capability being invoked. */
  readonly moduleId: string
  readonly generation: number
  /**
   * The module the invocation is being performed *on behalf of*, when the host knows it.
   *
   * `moduleId` alone cannot answer "who is the user authorising?": it is the capability's
   * provider, so mod A invoking a capability owned by module B records the grant under B —
   * and every later mod invoking B is then silently granted. Hosts that authenticate the
   * caller pass it here so the grant ledger can key on the party actually being trusted.
   *
   * Host-owned and absent from {@link KernelModulePermissionRequest} on purpose: a module
   * must never be able to name a caller other than itself.
   */
  readonly callerModuleId?: string
  readonly permission: string
  readonly reason?: string
  readonly scope?: ScopeRef
  readonly resource?: ResourceRef
  readonly details?: Readonly<Record<string, unknown>>
}

export interface KernelModulePermissionRequest {
  readonly permission: string
  readonly reason?: string
  readonly scope?: ScopeRef
  readonly resource?: ResourceRef
  readonly details?: Readonly<Record<string, unknown>>
}

export type KernelPermissionDecision =
  | {
      readonly status: 'granted'
      readonly grantId?: string
    }
  | {
      readonly status: 'denied'
      readonly reason: string
    }

/** Host-owned authority boundary. Modules never implement or replace it. */
export interface KernelPermissionBroker {
  request(
    request: KernelPermissionRequest,
  ): Promise<KernelPermissionDecision>
}

/** Module-scoped view that cannot forge module or generation identity. */
export interface KernelModulePermissionBroker {
  request(
    request: KernelModulePermissionRequest,
  ): Promise<KernelPermissionDecision>
}
