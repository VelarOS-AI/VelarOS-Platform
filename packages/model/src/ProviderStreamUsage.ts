import { isFiniteNumber,isObject, isPresent } from '@velaros-ai/core'
const ProviderCacheWriteInputTokenPaths = [
  ['providerMetadata', 'anthropic', 'cacheCreationInputTokens'],
  ['providerMetadata', 'vertex', 'cacheCreationInputTokens'],
  ['providerMetadata', 'bedrock', 'usage', 'cacheWriteInputTokens'],
  ['providerMetadata', 'venice', 'usage', 'cacheCreationInputTokens'],
] as const

function readProviderCacheWriteInputTokens(part: unknown): Nullable<number> {
  for (const path of ProviderCacheWriteInputTokenPaths) {
    const value = readNestedNumber(part, path)
    if (isPresent(value)) return value
  }

  return null
}

function readNestedNumber(value: unknown, path: readonly string[]): Nullable<number> {
  let current = value
  for (const key of path) {
    if (!current || !isObject(current)) return null

    current = (current as Record<string, unknown>)[key]
  }

  return isFiniteNumber(current) ? current : null
}

export { readProviderCacheWriteInputTokens }
