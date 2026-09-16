/** 工具 schema 的转换与打包：实现在 `@velaros-ai/tool-contract`，这里按原名转发。 */

import type { z } from 'zod'

import { toolSchemas } from '@velaros-ai/tool-contract'

import type { CreateToolSchemaBundleOptions, ToolSchemaBundle, ToolSchemaSource } from '../../types/toolkit.js'

/** 把一份来路不明的 schema 归一成能直接塞进工具目录的对象：不是普通对象（缺失、null、数组）就给一个空对象。 */
export function normalizeSchema(value: unknown): Record<string, unknown> {
  return toolSchemas.normalizeCatalogSchema(value)
}

/** 把单个 Zod schema 转成自包含的 JSON Schema 对象，并剥掉 `$schema` / `$id` / `~standard` 这些对端用不上的元字段。 */
export function schemaToInputSchema(schema: z.ZodType): Record<string, unknown> {
  return toolSchemas.toInputSchema(schema)
}

/** 稳定并收紧即将发送给 provider 的工具 JSON schema。 */
export function canonicalizeProviderInputSchema(schema: unknown): Record<string, unknown> {
  return toolSchemas.canonicalizeProviderInput(schema)
}

/** 生成面向模型的紧凑工具 schema 包；公共结构只放在顶层 $defs 中一次。 */
export function createToolSchemaBundle(
  tools: readonly ToolSchemaSource[],
  options: CreateToolSchemaBundleOptions = {}
): ToolSchemaBundle {
  return toolSchemas.bundle(tools, options)
}
