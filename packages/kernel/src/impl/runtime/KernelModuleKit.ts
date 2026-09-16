import { isBlank, isUndefined } from '@velaros-ai/core'

import type { CapabilityRequirement, CapabilityToken } from '../../types/abi-capability'

/** Creates a typed token while keeping the runtime representation minimal. */
export function createCapabilityToken<TService extends object = object>(
  id: string,
  version = '1.0.0',
): CapabilityToken<TService> {
  if (isBlank(id.trim())) {
    throw new Error('能力令牌的 id 不能为空')
  }
  if (isBlank(version.trim())) {
    throw new Error('能力令牌的 version 不能为空')
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
