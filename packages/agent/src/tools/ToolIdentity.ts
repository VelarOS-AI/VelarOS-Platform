/**
 * 模型工具的双重身份。
 *
 * VelarOS 内部只认 canonical id（`namespace:tool`）；provider 只接收它允许的传输名。
 * 传输名是一次请求的编译产物，不得写回注册表、权限策略或持久历史。
 */

import {
  assertCanonicalToolId,
  CanonicalToolIdPattern,
  isCanonicalToolId,
} from '@velaros-ai/core/tool-contract'

const ProviderToolNamePattern = /^[a-zA-Z0-9_-]{1,64}$/

interface ToolTransportNamePlan {
  readonly canonicalToProvider: Readonly<Record<string, string>>
  readonly providerToCanonical: Readonly<Record<string, string>>
}

function stableToolNameHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, '0')
}

function providerToolNameCandidate(canonicalId: string): string {
  const separatorIndex = canonicalId.indexOf(':')
  const namespace = canonicalId
    .slice(0, separatorIndex)
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  const tool = canonicalId
    .slice(separatorIndex + 1)
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  const readable = `${namespace || 'tool'}__${tool || 'call'}`
  if (readable.length > 0 && readable.length <= 64) return readable

  const hash = stableToolNameHash(canonicalId)
  const prefix = readable.slice(0, Math.max(1, 64 - hash.length - 2)) || 'tool'
  return `${prefix}__${hash}`
}

/**
 * 为一个 provider 请求生成稳定、无冲突的工具名映射。
 *
 * Canonical id 编译成可读的 `namespace__tool`。任何净化碰撞都追加 canonical hash，
 * 因此外部 mod 也不能通过相似字符覆盖另一项。
 */
function createToolTransportNamePlan(canonicalIds: readonly string[]): ToolTransportNamePlan {
  const canonicalToProvider: Record<string, string> = {}
  const providerToCanonical: Record<string, string> = {}

  for (const canonicalId of [...new Set(canonicalIds)]) {
    assertCanonicalToolId(canonicalId)
    let providerName = providerToolNameCandidate(canonicalId)
    const occupiedBy = providerToCanonical[providerName]
    if (occupiedBy && occupiedBy !== canonicalId) {
      const hash = stableToolNameHash(canonicalId)
      providerName = `${providerName.slice(0, 64 - hash.length - 2)}__${hash}`
    }
    const finalOccupiedBy = providerToCanonical[providerName]
    if (finalOccupiedBy && finalOccupiedBy !== canonicalId)
      throw new Error(
        `provider tool name collision: "${canonicalId}" and "${finalOccupiedBy}" both compile to "${providerName}"`
      )

    canonicalToProvider[canonicalId] = providerName
    providerToCanonical[providerName] = canonicalId
  }

  return Object.freeze({
    canonicalToProvider: Object.freeze(canonicalToProvider),
    providerToCanonical: Object.freeze(providerToCanonical),
  })
}

const ToolIdentityTokenCharacters = 'a-zA-Z0-9._:-'

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把模型可见文本里的 canonical 工具引用编译成当前请求的 provider 别名。
 *
 * 只替换完整 identity token，避免 `project:read` 误伤 `project:read_more`；映射只活在
 * provider 请求边界，不得写回提示词定义、注册表或持久历史。
 */
function rewriteCanonicalToolReferences(
  text: string,
  aliases: Readonly<Record<string, string>>
): string {
  let rewritten = text
  const entries = Object.entries(aliases)
    .filter(([canonicalId, providerName]) => canonicalId !== providerName)
    .sort(([left], [right]) => right.length - left.length || left.localeCompare(right))

  for (const [canonicalId, providerName] of entries) {
    const pattern = new RegExp(
      `(^|[^${ToolIdentityTokenCharacters}])${escapeRegularExpression(canonicalId)}(?=$|[^${ToolIdentityTokenCharacters}])`,
      'gu'
    )
    rewritten = rewritten.replace(pattern, (_match, prefix: string) => `${prefix}${providerName}`)
  }
  return rewritten
}

export {
  assertCanonicalToolId,
  CanonicalToolIdPattern,
  createToolTransportNamePlan,
  isCanonicalToolId,
  ProviderToolNamePattern,
  rewriteCanonicalToolReferences,
}
export type { ToolTransportNamePlan }
