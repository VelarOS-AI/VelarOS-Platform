import { createHash } from 'node:crypto'

import type {
  RemoteNodeCapabilityDescriptor,
  RemoteNodeManifest,
  RemoteNodeToolDescriptor,
} from '../../contracts/protocol'

/**
 * 清单摘要 = 新鲜度门的单一真值。
 *
 * 只要 Node 侧可见能力面变了(开关翻转、模块启停),revision 就换,携旧 revision 的在途
 * 调用一律被拒。摘要覆盖 **能力与工具的完整形状**,不只是名字——描述或 schema 变了也算变,
 * 否则 Client 会拿着过期的入参形状继续调。
 */
export function computeManifestRevision(
  capabilities: readonly RemoteNodeCapabilityDescriptor[],
  tools: readonly RemoteNodeToolDescriptor[],
): string {
  const canonical = JSON.stringify({
    capabilities: [...capabilities]
      .map((capability) => ({
        ...capability,
        operations: [...capability.operations]
          .sort((left, right) => left.name.localeCompare(right.name)),
      }))
      .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId)),
    tools: [...tools].sort((left, right) => left.name.localeCompare(right.name)),
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

export function createManifest(
  capabilities: readonly RemoteNodeCapabilityDescriptor[],
  tools: readonly RemoteNodeToolDescriptor[],
): RemoteNodeManifest {
  return {
    revision: computeManifestRevision(capabilities, tools),
    capabilities: [...capabilities],
    tools: [...tools],
  }
}
