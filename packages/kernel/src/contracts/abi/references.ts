/** Opaque isolation boundary used to partition module state and authorization. */
export interface ScopeRef {
  readonly id: string
  readonly ownerModuleId: string
  readonly kind?: string
}

/**
 * Opaque reference to a resource owned by a module.
 *
 * Consumers must resolve it through the capability that issued the reference;
 * the kernel does not interpret the referenced payload.
 */
export interface ResourceRef {
  readonly id: string
  readonly ownerModuleId: string
  readonly scope?: ScopeRef
  readonly mediaType?: string
}
