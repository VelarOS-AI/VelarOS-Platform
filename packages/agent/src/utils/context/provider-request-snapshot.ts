import type { ModelMessage } from 'ai'

import { isEmpty, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ProviderRequestSnapshot,ProviderToolDefinitionSnapshotInput } from '../../types/context.js'
import type { ProviderRequestFingerprint } from '../../types/records.js'

import { encodeProviderRequestAuditValue } from './serialization'

export function buildProviderRequestSnapshot(input: {
  model: string
  system: string
  messages: readonly ModelMessage[]
  tools?: readonly ProviderToolDefinitionSnapshotInput[]
  toolChoice?: unknown
  requestFingerprint: ProviderRequestFingerprint
}): ProviderRequestSnapshot {
  return {
    schemaVersion: 1,
    model: input.model,
    system: input.system,
    messages: encodeProviderRequestAuditValue(input.messages),
    tools: [...(input.tools ?? [])]
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
      .map((tool) => ({
        ...tool,
        inputSchema: encodeProviderRequestAuditValue(tool.inputSchema),
      })),
    toolChoice: encodeProviderRequestAuditValue(input.toolChoice),
    requestFingerprint: { ...input.requestFingerprint },
  }
}

/** 真正发请求前的最后一条门：工具面也必须能从快照完整重建。 */
export function assertProviderRequestSnapshotReconstructable(
  snapshot: ProviderRequestSnapshot
): void {
  const expectedNames = snapshot.requestFingerprint.availableToolNames
  const actualNames = snapshot.tools.map((tool) => tool.name)
  const issues: string[] = []
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    issues.push(`tool definitions do not match visible tools: expected=${expectedNames.join(',')}; actual=${actualNames.join(',')}`)
  }
  const missingSchemas = snapshot.tools
    .filter((tool) => !isPresent(tool.inputSchema))
    .map((tool) => tool.name)
  if (!isEmpty(missingSchemas)) issues.push(`tool schemas are missing: ${missingSchemas.join(',')}`)
  if (isEmpty(snapshot.requestFingerprint.messageHash)) issues.push('message hash is missing')
  if (isEmpty(issues)) return

  throw new AppError(
    'INVARIANT',
    `模型请求无法从审计快照完整重建，已取消发送：${issues.join('；')}`,
    undefined,
    {
      source: 'provider-request-reconstructability',
      requestFingerprint: snapshot.requestFingerprint,
      issues,
    }
  )
}
