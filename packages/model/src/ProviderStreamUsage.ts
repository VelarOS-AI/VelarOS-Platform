import { isFiniteNumber,isPlainObject, isPresent } from '@velaros-ai/core'

/**
 * 从 AI SDK 的 usage 分片里读「缓存写入 token」。
 *
 * 判据（§5.3b ⑥非显然妥协）——各家把同一语义塞在**不同深度**的 providerMetadata 路径下且互不重叠，
 * 所以这里是一张按序试探的路径表而不是 provider 分支：命中第一条即返回。新增服务商 = 往表里加一行。
 */
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
    if (!isPlainObject(current)) return null

    current = current[key]
  }

  return isFiniteNumber(current) ? current : null
}

export { readProviderCacheWriteInputTokens }
