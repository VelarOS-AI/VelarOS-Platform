import { isArray, isString } from '@velaros-ai/core'

import { AgentToolLimits } from '../../contract/constants.js'
import type { ToolCatalogEntry } from '../../types/agent.js'
import { ToolCatalogDiscoveryToolName, ToolSchemaDiscoveryToolName } from '../wire/lease'

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
    description:
      '按目录中的精确工具名读取当前参数结构；参数结构缺失或目录版本变化时使用。当前请求已提供完整结构时直接调用目标工具。',
    category: 'agent-control',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          maxItems: AgentToolLimits.payload.schemaDiscoveryNames,
        },
      },
      required: ['names'],
      additionalProperties: false,
    },
  },
])

/**
 * 从模型调用 schema 自恢复工具时给的参数里读出要查的工具名单：只收字符串项、逐个 trim、丢掉空串、
 * 去重后**截到前 12 个**（与 inputSchema 的 maxItems 一致）。`names` 不是数组时返回空数组而不是抛错——
 * 这条工具是模型 schema 漂移后的恢复路径，宁可让它查个空也不能把它自己变成一次报错。
 */
export function readToolSchemaDiscoveryNames(input: Record<string, unknown>): string[] {
  if (!isArray(input.names)) return []
  return [
    ...new Set(
      input.names
        .filter((value): value is string => isString(value))
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ].slice(0, AgentToolLimits.payload.schemaDiscoveryNames)
}
