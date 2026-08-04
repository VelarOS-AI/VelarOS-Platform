import { isBlank, isUndefined } from '@velaros-ai/core'

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

/** Creates a typed token while keeping the runtime representation minimal. */
export function createCapabilityToken<TService extends object = object>(
  id: string,
  version = '1.0.0',
): CapabilityToken<TService> {
  if (isBlank(id.trim())) {
    throw new Error('Capability token id must not be empty')
  }
  if (isBlank(version.trim())) {
    throw new Error('Capability token version must not be empty')
  }

  return Object.freeze({ id, version })
}

/** Convenience helper for manifests that require a typed capability token. */
export function requireCapability(
  token: CapabilityToken,
  versionRange?: string,
): CapabilityRequirement {
  return isUndefined(versionRange)
    ? Object.freeze({ id: token.id })
    : Object.freeze({ id: token.id, versionRange })
}
