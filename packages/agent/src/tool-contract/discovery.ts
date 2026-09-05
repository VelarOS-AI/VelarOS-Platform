import { isArray, isString } from '@velaros-ai/core'

import { ToolCatalogDiscoveryToolName, type ToolCatalogEntry,ToolSchemaDiscoveryToolName } from '../protocol'

/** 两条自恢复工具随每份目录常驻，避免模型在 schema 漂移后失去恢复路径。 */
export const ToolContractDiscoveryDescriptors: readonly ToolCatalogEntry[] = Object.freeze([
  {
    name: ToolCatalogDiscoveryToolName,
    description: '重新读取当前 VelarOS 工具目录及其目录版本。',
    category: 'agent-control',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: ToolSchemaDiscoveryToolName,
    description: '按工具名读取当前版本的真实参数结构；调用不熟悉的工具前先使用它。',
    category: 'agent-control',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          maxItems: 12,
        },
      },
      required: ['names'],
      additionalProperties: false,
    },
  },
])

export function readToolSchemaDiscoveryNames(input: Record<string, unknown>): string[] {
  if (!isArray(input.names)) return []
  return [
    ...new Set(
      input.names
        .filter((value): value is string => isString(value))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].slice(0, 12)
}
