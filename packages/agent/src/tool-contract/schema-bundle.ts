import { z } from 'zod'

import { isArray, isEmpty, isRecord, isString } from '@velaros-ai/core'

export interface ToolSchemaSource {
  name: string
  description: string
  schema: z.ZodType
}

export interface ToolSchemaBundle {
  schemaVersion: 1
  $defs: Record<string, unknown>
  tools: Array<{
    name: string
    description: string
    inputSchema: Record<string, unknown>
  }>
}

export interface CreateToolSchemaBundleOptions {
  schemaVersion?: 1
  sharedSchemaId?: string
  sharedSchemaExternalUri?: string
  maxInlineSharedDefChars?: number
}

interface SchemaBundleContext {
  sharedSchemaRefPrefix: string
  bundleSharedSchemaRefPrefix: string
  inlineSharedDefMaxChars: number
}

const BundleSharedSchemaRefPrefix = '#/$defs/'

/**
 * 将单个 Zod schema 转为自包含 JSON schema，供 MCP 等标准工具描述使用。
 *
 * io:'input'——工具入参 schema 描述的是**输入**侧:带 .transform 的宽容 schema
 * (钳制/默认值补全)在输入侧完全可表示;默认 output 视角会直接抛
 * "Transforms cannot be represented in JSON Schema",导致这些工具退化成
 * 零参数兜底 schema(模型侧看不到任何参数)。.default() 字段在输入侧也正确标记为可省略。
 */
export function schemaToInputSchema(schema: z.ZodType): Record<string, unknown> {
  return stripSchemaMetadata(
    z.toJSONSchema(schema, { io: 'input' })
  ) as Record<string, unknown>
}

/** 稳定并收紧即将发送给 provider 的工具 JSON schema。 */
export function canonicalizeProviderInputSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema) || isEmpty(Object.keys(schema))) return { type: 'object' }

  const canonical = canonicalizeSchemaObject(schema)
  return !isEmpty(Object.keys(canonical)) ? canonical : { type: 'object' }
}

/** 生成面向模型的紧凑工具 schema 包；公共结构只放在顶层 $defs 中一次。 */
export function createToolSchemaBundle(
  tools: readonly ToolSchemaSource[],
  options: CreateToolSchemaBundleOptions = {}
): ToolSchemaBundle {
  const sharedSchemaId = options.sharedSchemaId ?? '__shared'
  const sharedSchemaExternalUri = options.sharedSchemaExternalUri ?? 'tool-contract-shared'
  const inlineSharedDefMaxChars = options.maxInlineSharedDefChars ?? 120
  const context: SchemaBundleContext = {
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

function slimToolSchemaBundle(bundle: ToolSchemaBundle, context: SchemaBundleContext): ToolSchemaBundle {
  return attachSharedReferenceDescriptions(
    shortenSharedDefinitionNames(inlineSingleUseSharedDefinitions(bundle, context), context),
    context
  )
}

function inlineSingleUseSharedDefinitions(
  bundle: ToolSchemaBundle,
  context: SchemaBundleContext
): ToolSchemaBundle {
  const next = cloneSchemaValue(bundle) as ToolSchemaBundle
  let changed = true
  while (changed) {
    changed = false
    const refCounts = collectSharedDefinitionRefCounts(next, context)
    for (const [definitionName, definition] of Object.entries(next.$defs)) {
      const refCount = refCounts.get(definitionName) ?? 0
      if (refCount === 0) {
        delete next.$defs[definitionName]
        changed = true
        break
      }
      if (
        refCount === 1 &&
        JSON.stringify(definition).length <= context.inlineSharedDefMaxChars &&
        !JSON.stringify(definition).includes(`${context.bundleSharedSchemaRefPrefix}${definitionName}`)
      ) {
        const replacement = cloneSchemaValue(definition)
        next.tools = replaceSharedDefinitionRefs(next.tools, definitionName, replacement, context) as ToolSchemaBundle['tools']
        next.$defs = replaceSharedDefinitionRefs(next.$defs, definitionName, replacement, context) as ToolSchemaBundle['$defs']
        delete next.$defs[definitionName]
        changed = true
        break
      }
    }
  }
  return next
}

function shortenSharedDefinitionNames(
  bundle: ToolSchemaBundle,
  context: SchemaBundleContext
): ToolSchemaBundle {
  const names = Object.keys(bundle.$defs)
  const renamed = new Map(names.map((name, index) => [name, `d${index.toString(36)}`]))
  return {
    ...bundle,
    $defs: Object.fromEntries(
      names.map((name) => [
        renamed.get(name)!,
        rewriteSharedDefinitionRefs(bundle.$defs[name], renamed, context),
      ])
    ),
    tools: rewriteSharedDefinitionRefs(bundle.tools, renamed, context) as ToolSchemaBundle['tools'],
  }
}

function attachSharedReferenceDescriptions(
  bundle: ToolSchemaBundle,
  context: SchemaBundleContext
): ToolSchemaBundle {
  return {
    ...bundle,
    tools: bundle.tools.map((tool) => ({
      ...tool,
      inputSchema: attachInputPropertyReferenceDescriptions(tool.inputSchema, bundle.$defs, context),
    })),
  }
}

function attachInputPropertyReferenceDescriptions(
  inputSchema: Record<string, unknown>,
  definitions: Record<string, unknown>,
  context: SchemaBundleContext
): Record<string, unknown> {
  if (!isRecord(inputSchema.properties)) return inputSchema
  return {
    ...inputSchema,
    properties: Object.fromEntries(
      Object.entries(inputSchema.properties).map(([propertyName, propertySchema]) => [
        propertyName,
        attachReferenceDescription(propertySchema, definitions, context),
      ])
    ),
  }
}

function attachReferenceDescription(
  value: unknown,
  definitions: Record<string, unknown>,
  context: SchemaBundleContext
): unknown {
  if (
    isRecord(value) &&
    isString(value.$ref) &&
    value.$ref.startsWith(context.bundleSharedSchemaRefPrefix) &&
    !isString(value.description)
  ) {
    const definitionName = value.$ref.slice(context.bundleSharedSchemaRefPrefix.length)
    const definition = definitions[definitionName]
    if (isRecord(definition) && isString(definition.description)) return { ...value, description: definition.description }
  }
  return value
}

function collectSharedDefinitionRefCounts(
  value: unknown,
  context: SchemaBundleContext,
  counts = new Map<string, number>()
): Map<string, number> {
  if (isArray(value)) {
    for (const item of value) collectSharedDefinitionRefCounts(item, context, counts)
    return counts
  }
  if (!isRecord(value)) return counts

  for (const [key, nested] of Object.entries(value)) {
    if (key === '$ref' && isString(nested) && nested.startsWith(context.bundleSharedSchemaRefPrefix)) {
      const definitionName = nested.slice(context.bundleSharedSchemaRefPrefix.length)
      counts.set(definitionName, (counts.get(definitionName) ?? 0) + 1)
    } else {
      collectSharedDefinitionRefCounts(nested, context, counts)
    }
  }
  return counts
}

function replaceSharedDefinitionRefs(
  value: unknown,
  definitionName: string,
  replacement: unknown,
  context: SchemaBundleContext
): unknown {
  if (isArray(value)) return value.map((item) => replaceSharedDefinitionRefs(item, definitionName, replacement, context))
  if (!isRecord(value)) return value

  if (value.$ref === `${context.bundleSharedSchemaRefPrefix}${definitionName}`) {
    const { $ref: _ref, ...siblings } = value
    return {
      ...(cloneSchemaValue(replacement) as Record<string, unknown>),
      ...(replaceSharedDefinitionRefs(siblings, definitionName, replacement, context) as Record<string, unknown>),
    }
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      replaceSharedDefinitionRefs(nested, definitionName, replacement, context),
    ])
  )
}

function rewriteSharedDefinitionRefs(
  value: unknown,
  renamed: Map<string, string>,
  context: SchemaBundleContext
): unknown {
  if (isArray(value)) return value.map((item) => rewriteSharedDefinitionRefs(item, renamed, context))
  if (!isRecord(value)) return value

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => {
      if (key === '$ref' && isString(nested) && nested.startsWith(context.bundleSharedSchemaRefPrefix)) {
        const currentName = nested.slice(context.bundleSharedSchemaRefPrefix.length)
        const nextName = renamed.get(currentName)
        return [key, nextName ? `${context.bundleSharedSchemaRefPrefix}${nextName}` : nested]
      }
      return [key, rewriteSharedDefinitionRefs(nested, renamed, context)]
    })
  )
}

function cloneSchemaValue(value: unknown): unknown {
  if (isArray(value)) return value.map(cloneSchemaValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneSchemaValue(nested)]))
}

function canonicalizeSchemaValue(value: unknown): unknown {
  if (isArray(value)) return value.map(canonicalizeSchemaValue)
  if (!isRecord(value)) return value
  return canonicalizeSchemaObject(value)
}

function canonicalizeSchemaObject(value: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const nested = value[key]
    switch (key) {
      case 'properties':
      case 'patternProperties':
      case '$defs':
      case 'definitions':
      case 'dependentSchemas':
        next[key] = canonicalizeNamedSchemaMap(nested)
        break
      case 'required': {
        const required = canonicalizeStringArray(nested)
        if (!isEmpty(required)) next[key] = required
        break
      }
      case 'dependentRequired': {
        const dependentRequired = canonicalizeDependentRequired(nested)
        if (dependentRequired) next[key] = dependentRequired
        break
      }
      default:
        next[key] = canonicalizeSchemaValue(nested)
        break
    }
  }
  return next
}

function canonicalizeNamedSchemaMap(value: unknown): unknown {
  if (!isRecord(value)) return canonicalizeSchemaValue(value)
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeSchemaValue(value[key])])
  )
}

function canonicalizeDependentRequired(value: unknown): Nullable<Record<string, string[]>> {
  if (!isRecord(value)) return null

  const entries = Object.keys(value)
    .sort()
    .flatMap((key): Array<[string, string[]]> => {
      const required = canonicalizeStringArray(value[key])
      return isEmpty(required) ? [] : [[key, required]]
    })
  return isEmpty(entries) ? null : Object.fromEntries(entries)
}

function canonicalizeStringArray(value: unknown): string[] {
  if (!isArray(value)) return []
  return value.filter(isString).sort()
}

function stripSchemaMetadata(value: unknown): unknown {
  if (isArray(value)) return value.map(stripSchemaMetadata)
  if (!isRecord(value)) return value

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '$schema' && key !== '$id' && key !== '~standard')
      .map(([key, nested]) => [key, stripSchemaMetadata(nested)])
  )
}

function normalizeSharedSchemaRefs(value: unknown, context: SchemaBundleContext): unknown {
  if (isArray(value)) return value.map((item) => normalizeSharedSchemaRefs(item, context))
  if (!isRecord(value)) return value

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      key === '$ref' && isString(nested)
        ? normalizeSharedSchemaRef(nested, context)
        : normalizeSharedSchemaRefs(nested, context),
    ])
  )
}

function normalizeSharedSchemaRef(ref: string, context: SchemaBundleContext): string {
  return ref.startsWith(context.sharedSchemaRefPrefix)
    ? `${context.bundleSharedSchemaRefPrefix}${ref.slice(context.sharedSchemaRefPrefix.length)}`
    : ref
}
