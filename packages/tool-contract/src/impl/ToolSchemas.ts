/**
 * 工具入参 schema 的对外转换：单条 zod schema 转 JSON Schema、发给 provider 前的稳定化、
 * 一整批工具的紧凑 schema 包。接口 `ToolSchemasApi` 在本文件的类上方；整个进程一份 `toolSchemas`。
 */

import { z } from 'zod'

import { isEmpty, isRecord } from '@velaros-ai/core'

import type { CreateToolSchemaBundleOptions, ToolSchemaBundle } from '../types/tool-contract.js'
import type { ToolSchemaBundleContext, ToolSchemaSource } from '../types/toolkit.js'
import {
  boundTupleLength,
  BundleSharedSchemaRefPrefix,
  canonicalizeSchemaObject,
  normalizeSchema,
  normalizeSharedSchemaRefs,
  slimToolSchemaBundle,
  stripSchemaMetadata,
} from '../utils/json-schema.js'
import { ToolContractTuning } from '../utils/tuning.js'

/**
 * 工具 schema 的唯一转换处，实例是 `toolSchemas`。
 *
 * 一律按 `io:'input'` 出 JSON Schema：带 `.transform` 的宽容 schema 只有输入侧可表示，
 * 用默认的 output 视角会抛「Transforms cannot be represented in JSON Schema」，
 * 结果是这些工具退化成零参数兜底 schema、模型侧一个参数都看不见（真实事故）。
 */
export interface ToolSchemasApi {
  /** 把一份来路不明的 schema 归一成能直接塞进工具目录的对象；不是普通对象就给一个空对象。 */
  normalizeCatalogSchema(value: unknown): Record<string, unknown>
  /** 把单条 zod schema 转成自包含的 JSON Schema，并剥掉对端用不上的元字段。 */
  toInputSchema(schema: z.ZodType): Record<string, unknown>
  /** 稳定并收紧即将发给 provider 的工具 JSON Schema：键序固定，空的 required 整个丢掉。 */
  canonicalizeProviderInput(schema: unknown): Record<string, unknown>
  /** 生成面向模型的紧凑工具 schema 包：公共结构只在顶层 `$defs` 里放一次。 */
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

  public normalizeCatalogSchema(value: unknown): Record<string, unknown> {
    return normalizeSchema(value)
  }

  public toInputSchema(schema: z.ZodType): Record<string, unknown> {
    return stripSchemaMetadata(
      z.toJSONSchema(schema, { io: 'input', override: boundTupleLength })
    ) as Record<string, unknown>
  }

  public canonicalizeProviderInput(schema: unknown): Record<string, unknown> {
    if (!isRecord(schema) || isEmpty(Object.keys(schema))) return { type: 'object' }

    const canonical = canonicalizeSchemaObject(schema)
    return !isEmpty(Object.keys(canonical)) ? canonical : { type: 'object' }
  }

  public bundle(
    tools: readonly ToolSchemaSource[],
    options: CreateToolSchemaBundleOptions = {}
  ): ToolSchemaBundle {
    const sharedSchemaId = options.sharedSchemaId ?? ToolSchemas.SharedSchemaId
    const sharedSchemaExternalUri = options.sharedSchemaExternalUri ?? ToolSchemas.SharedSchemaExternalUri
    const inlineSharedDefMaxChars =
      options.maxInlineSharedDefChars ?? ToolContractTuning.schemaBundle.inlineSharedDefChars
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

/** 整个进程只有一份的工具 schema 转换处。 */
export const toolSchemas: ToolSchemasApi = new ToolSchemas()
