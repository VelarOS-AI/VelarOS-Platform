declare const capabilityServiceType: unique symbol

/**
 * A stable, runtime-visible service identity with a compile-time service type.
 *
 * Tokens carry no implementation and can safely live in a contracts package.
 */
export interface CapabilityToken<TService extends object = object> {
  readonly id: string
  readonly version: string
  readonly [capabilityServiceType]?: TService
}

/** Declares a capability dependency without importing its implementation. */
export interface CapabilityRequirement {
  readonly id: string
  readonly versionRange?: string
}
