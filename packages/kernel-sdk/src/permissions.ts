import type { ResourceRef, ScopeRef } from './references.js'

export interface KernelPermissionRequest {
  readonly moduleId: string
  readonly generation: number
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
