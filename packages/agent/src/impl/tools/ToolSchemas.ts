/**
 * 一整批工具的紧凑 schema 包：共享定义只在顶层 `$defs` 放一次，单处引用的小定义内联回去，留下的定义改成短名。
 * 单条 zod schema 转 JSON Schema 与瘦身流水线在 `utils/toolkit/json-schema.ts`。
 * 接口 `ToolSchemasApi` 在本文件的类上方；整个进程一份 `toolSchemas`。
 */

import { z } from 'zod'

import { isRecord } from '@velaros-ai/core'

import type {
  CreateToolSchemaBundleOptions,
  ToolSchemaBundle,
  ToolSchemaBundleContext,
  ToolSchemaSource,
} from '../../types/toolkit.js'
import {
  boundTupleLength,
  BundleSharedSchemaRefPrefix,
  normalizeSharedSchemaRefs,
  slimToolSchemaBundle,
  stripSchemaMetadata,
} from '../../utils/toolkit/json-schema'
import { AgentTuning } from '../../utils/tuning'

/**
 * 工具 schema 包的唯一构造处，实例是 `toolSchemas`。
 *
 * 一律按 `io:'input'` 出 JSON Schema：带 `.transform` 的宽容 schema 只有输入侧可表示，
 * 用默认的 output 视角会抛「Transforms cannot be represented in JSON Schema」，
 * 结果是这些工具退化成零参数兜底 schema、模型侧一个参数都看不见（真实事故）。
 */
export interface ToolSchemasApi {
  /** 生成面向模型的紧凑工具 schema 包：公共结构只在顶层 `$defs` 里放一次，单处引用的小定义内联回去。 */
  bundle(
    tools: readonly ToolSchemaSource[],
    options?: CreateToolSchemaBundleOptions
  ): ToolSchemaBundle
}

class ToolSchemas implements ToolSchemasApi {
  /** 共享定义在 zod 注册表里的 id；出包时换成外部 URI，再归一回包内引用。 */
  private static readonly SharedSchemaId = '__shared'

  /** 共享定义出包时的外部 URI，只是个占位名，最终会被改写成包内 `#/$defs/`。 */
  private static readonly SharedSchemaExternalUri = 'tool-contract-shared'

  public bundle(
    tools: readonly ToolSchemaSource[],
    options: CreateToolSchemaBundleOptions = {}
  ): ToolSchemaBundle {
    const sharedSchemaId = options.sharedSchemaId ?? ToolSchemas.SharedSchemaId
    const sharedSchemaExternalUri = options.sharedSchemaExternalUri ?? ToolSchemas.SharedSchemaExternalUri
    const inlineSharedDefMaxChars =
      options.maxInlineSharedDefChars ?? AgentTuning.toolkit.inlineSharedDefChars
    const context: ToolSchemaBundleContext = {
      sharedSchemaRefPrefix: `${sharedSchemaExternalUri}#/$defs/`,
      bundleSharedSchemaRefPrefix: BundleSharedSchemaRefPrefix,
      inlineSharedDefMaxChars,
    }
    const registry = z.registry<{ id?: string }>()
    for (const tool of tools) {
      registry.add(tool.schema, { id: tool.name })
    }

    const schemas = z.toJSONSchema(registry, {
      io: 'input',
      override: boundTupleLength,
      reused: 'ref',
      uri: (schemaId) => schemaId === sharedSchemaId ? sharedSchemaExternalUri : schemaId,
    }).schemas
    const sharedSchema = normalizeSharedSchemaRefs(
      stripSchemaMetadata(schemas[sharedSchemaId] ?? {}),
      context
    )
    const sharedDefs = isRecord(sharedSchema) && isRecord(sharedSchema.$defs) ? sharedSchema.$defs : {}

    return slimToolSchemaBundle({
      schemaVersion: options.schemaVersion ?? 1,
      $defs: sharedDefs,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: normalizeSharedSchemaRefs(
          stripSchemaMetadata(schemas[tool.name] ?? {}),
          context
        ) as Record<string, unknown>,
      })),
    }, context)
  }
}

/** 整个进程只有一份的工具 schema 包构造处。 */
export const toolSchemas: ToolSchemasApi = new ToolSchemas()
