import { createHash } from 'node:crypto'

import { isArray, isRecord } from '@velaros-ai/core'

import type {
  RemoteNodeCapabilityDescriptor,
  RemoteNodeManifest,
  RemoteNodeToolDescriptor,
} from '../wire/remote-node'

/**
 * 清单摘要 = 新鲜度门的单一真值。
 *
 * 只要 Node 侧可见能力面变了(开关翻转、模块启停),revision 就换,携旧 revision 的在途
 * 调用一律被拒。摘要覆盖 **能力与工具的完整形状**,不只是名字——描述或 schema 变了也算变,
 * 否则 Client 会拿着过期的入参形状继续调。
 */
export function computeManifestRevision(
  capabilities: readonly RemoteNodeCapabilityDescriptor[],
  tools: readonly RemoteNodeToolDescriptor[]
): string {
  const canonical = JSON.stringify(
    canonicalize({
      capabilities: [...capabilities]
        .map((capability) => ({
          ...capability,
          operations: [...capability.operations].sort((left, right) =>
            left.name.localeCompare(right.name)
          ),
        }))
        .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId)),
      tools: [...tools].sort((left, right) => left.name.localeCompare(right.name)),
    })
  )
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

/**
 * 递归按键名排序,让摘要只认**内容**、不认书写顺序。
 *
 * 数组顺序保留(上面已经按名字显式排过序);对象的键序则是书写细节——工具的 `inputSchema`
 * 是任意嵌套对象,同一份清单换个键序就换一个 revision,在途调用会被当过期拒绝。
 */
function canonicalize(value: unknown): unknown {
  if (isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalize(value[key])
  }
  return sorted
}

/** 把能力表与工具表装成一份清单,`revision` 由内容算出来,调用方不自己填。 */
export function createManifest(
  capabilities: readonly RemoteNodeCapabilityDescriptor[],
  tools: readonly RemoteNodeToolDescriptor[]
): RemoteNodeManifest {
  return {
    revision: computeManifestRevision(capabilities, tools),
    capabilities: [...capabilities],
    tools: [...tools],
  }
}
