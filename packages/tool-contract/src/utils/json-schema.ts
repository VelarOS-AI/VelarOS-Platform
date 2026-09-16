/**
 * JSON Schema 的搬运工：剥元字段、稳定键序、共享定义的引用归一、内联与改名、补引用描述。
 * 只认 JSON Schema 的结构，不解释业务含义；对外的转换入口在 `impl/ToolSchemas.ts`。
 */

import type { z } from 'zod'

import { isArray, isEmpty, isPlainObject, isRecord, isString } from '@velaros-ai/core'

import type { ToolSchemaBundle } from '../types/tool-contract.js'
import type { ToolSchemaBundleContext } from '../types/toolkit.js'

/** 包内共享定义的引用前缀；一份 bundle 自包含时全部引用都长这样。 */
export const BundleSharedSchemaRefPrefix = '#/$defs/'

/**
 * 把一份来路不明的 schema 归一成能直接塞进工具目录的对象：不是普通对象（缺失、null、数组）就给一个空对象。
 * 目录条目的 `inputSchema` 不许缺席，否则 provider 侧会把整个工具当成没有参数。
 */
export function normalizeSchema(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
}

/**
 * Zod 的元组只输出 prefixItems，没有长度界限：provider 看到的 [行号] 与 [首行,末行] 都能多塞元素。
 * 固定元组补上 minItems（到最后一个必填元素）与 maxItems，让 schema 与运行时一样拒绝多余元素。
 */
export function boundTupleLength({ zodSchema, jsonSchema }: { zodSchema: z.core.$ZodTypes; jsonSchema: z.core.JSONSchema.BaseSchema }): void {
  const def = zodSchema._zod.def
  if (def.type !== 'tuple' || def.rest) return
  jsonSchema.minItems = def.items.findLastIndex((item) => item._zod.optin !== 'optional') + 1
  jsonSchema.maxItems = def.items.length
}

/**
 * schema 包的瘦身流水线，三步固定顺序：内联只用一次的共享定义 → 把留下的定义改成 `d0`/`d1` 短名
 * → 给引用点补回 description。顺序不能换：先内联才知道最终留哪些定义、才轮得到重命名，
 * 而补描述必须在改名之后（要照着最终的 `$defs` 查）。产出仍是等价 schema，只是给模型看的字符更少。
 */
export function slimToolSchemaBundle(bundle: ToolSchemaBundle, context: ToolSchemaBundleContext): ToolSchemaBundle {
  return attachSharedReferenceDescriptions(
    shortenSharedDefinitionNames(inlineSingleUseSharedDefinitions(bundle, context), context),
    context
  )
}

/**
 * 在深拷贝上反复扫 `$defs`，直到没有可处理项为止：**零引用**的定义直接删；**恰好一次引用**
 * 且序列化后不超过内联阈值、且自身不引用自己的定义，
 * 就把那处 `$ref` 就地换成定义本体再删掉条目。只内联小定义，是因为抽成 `$defs` 本来就是为了省字符，
 * 单处引用的大结构内联回去反而更占；排除自引用则是为了不把递归定义展开成无限嵌套。
 * 替换时 `$ref` 兄弟键（如 description）保留并**覆盖**定义里的同名键，因为那是调用点的特化。
 * 每处理一项就重新统计引用数并从头再来——内联本身会让别的定义变成零引用。
 */
function inlineSingleUseSharedDefinitions(
  bundle: ToolSchemaBundle,
  context: ToolSchemaBundleContext
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

/**
 * 把留在 `$defs` 里的定义按出现顺序重命名成 `d0`、`d1`、…（下标取 36 进制，所以 10 之后是 `da`），
 * 并同步改写 `$defs` 内部与全部工具 inputSchema 里指向它们的 `$ref`。纯省 token：定义名每被引用一次
 * 就要重复一次，短名直接摊掉这份开销；语义等价，且改名只在包内生效、不影响 zod 侧的原名。
 */
function shortenSharedDefinitionNames(
  bundle: ToolSchemaBundle,
  context: ToolSchemaBundleContext
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

/**
 * 遍历包内每个工具的 inputSchema，把顶层参数上「只有 `$ref` 没有 description」的引用补上被引定义的
 * description。抽共享定义省了字符，但也让模型在参数列表里看到一个光秃秃的 `$ref`——补一句回去，
 * 模型不必跳到 `$defs` 才知道这个参数是干什么的。`$defs` 本身不动。
 */
function attachSharedReferenceDescriptions(
  bundle: ToolSchemaBundle,
  context: ToolSchemaBundleContext
): ToolSchemaBundle {
  return {
    ...bundle,
    tools: bundle.tools.map((tool) => ({
      ...tool,
      inputSchema: attachInputPropertyReferenceDescriptions(tool.inputSchema, bundle.$defs, context),
    })),
  }
}

/**
 * 对一份 inputSchema 的 `properties` 逐个参数补引用描述，返回新对象。
 * **只走顶层这一层**，不递归进嵌套对象或数组项——参数列表是模型第一眼看到的地方，
 * 深层补描述收益小、字符代价大。`properties` 不是对象时原样返回。
 */
function attachInputPropertyReferenceDescriptions(
  inputSchema: Record<string, unknown>,
  definitions: Record<string, unknown>,
  context: ToolSchemaBundleContext
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

/**
 * 给单个引用节点补 description：仅当它是对象、`$ref` 指向包内 `$defs`、**且自己没有 description**，
 * 而被引定义有 description 时，才返回带 description 的副本；其余一切情况原样返回原值。
 * 调用点已写的 description 优先级更高，绝不覆盖。
 */
function attachReferenceDescription(
  value: unknown,
  definitions: Record<string, unknown>,
  context: ToolSchemaBundleContext
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

/**
 * 深度遍历任意 schema 片段，统计每个共享定义被 `$ref` 引用了多少次，返回「定义名 → 次数」的 Map
 * （没出现过的定义不在 Map 里，调用方按 0 处理）。只认前缀是包内 `$defs` 的引用；
 * 命中 `$ref` 就计数并**不再下钻**这个字符串值。计数是内联判定的依据：0 次可删、1 次可内联。
 */
function collectSharedDefinitionRefCounts(
  value: unknown,
  context: ToolSchemaBundleContext,
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

/**
 * 深度遍历并把指向某个共享定义的 `$ref` 就地换成定义本体（每处一份独立深拷贝，互不共享引用）。
 * 关键取舍在合并顺序：`$ref` 节点上的**兄弟键排在展开的定义之后**，所以调用点写的
 * description/default 之类会覆盖定义里的同名键——引用点的特化优先。
 * 其余节点原样递归，不匹配的引用不动。
 */
function replaceSharedDefinitionRefs(
  value: unknown,
  definitionName: string,
  replacement: unknown,
  context: ToolSchemaBundleContext
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

/**
 * 深度遍历并按 `renamed`（旧名 → 新名）改写指向包内 `$defs` 的 `$ref` 字符串，返回新结构。
 * 映射里没有的定义名保持原样、不报错——调用方保证映射覆盖全部留存定义。
 */
function rewriteSharedDefinitionRefs(
  value: unknown,
  renamed: Map<string, string>,
  context: ToolSchemaBundleContext
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

/**
 * 深拷贝一段 JSON schema 数据：数组与对象逐层重建，标量原样返回。
 * 内联与瘦身都在拷贝上改，避免把同一份定义对象塞到多处后互相串改。不处理循环引用。
 */
function cloneSchemaValue(value: unknown): unknown {
  if (isArray(value)) return value.map(cloneSchemaValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneSchemaValue(nested)]))
}

/**
 * 规范化任意 schema 节点的入口：数组保持原顺序逐项递归（数组次序在 JSON Schema 里有语义，
 * 不排序），对象交给 `canonicalizeSchemaObject`，标量原样返回。
 */
function canonicalizeSchemaValue(value: unknown): unknown {
  if (isArray(value)) return value.map(canonicalizeSchemaValue)
  if (!isRecord(value)) return value
  return canonicalizeSchemaObject(value)
}

/**
 * 把一个 schema 对象重建成稳定形态：键名按字典序重排（同一份 schema 无论怎么拼出来，
 * 序列化结果都一致，provider 侧的前缀缓存才不会因键序抖动失效），并对几类键特殊处理——
 * `properties` / `patternProperties` / `$defs` / `definitions` / `dependentSchemas` 的子键也排序；
 * `required` 去非字符串项并排序，**空数组整个键丢掉**；`dependentRequired` 同理，清空后丢键。
 * 丢空键是收紧：留着 `required: []` 只是噪声，语义上等于没有。
 */
export function canonicalizeSchemaObject(value: Record<string, unknown>): Record<string, unknown> {
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

/**
 * 规范化「名字 → 子 schema」这类映射（properties、$defs 等）：键按字典序重排，值各自递归规范化。
 * 这些键是属性名而非 schema 关键字，排序对语义无影响。入参不是对象时退回通用规范化。
 */
function canonicalizeNamedSchemaMap(value: unknown): unknown {
  if (!isRecord(value)) return canonicalizeSchemaValue(value)
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeSchemaValue(value[key])])
  )
}

/**
 * 规范化 `dependentRequired`：外层键排序，每个值当字符串数组去杂项后排序，
 * **依赖列表为空的条目整条丢掉**；一条都不剩（或入参不是对象）时返回 null，
 * 调用方据此连 `dependentRequired` 这个键一起不写。
 */
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

/**
 * 把值收成稳定的字符串数组：非数组返回空数组，是数组则丢掉非字符串项后按字典序排序。
 * 只用于 `required` / `dependentRequired` 这类**次序无语义**的名字列表。
 */
function canonicalizeStringArray(value: unknown): string[] {
  if (!isArray(value)) return []
  return value.filter(isString).sort()
}

/**
 * 深度剥掉三个对端用不上的元字段：`$schema`、`$id`（zod 生成的 schema 标识，模型与 provider 都不需要）
 * 和 `~standard`（Standard Schema 的运行时私有字段，序列化出去只是噪声）。
 * 其余键与结构原样保留，返回新结构。
 */
export function stripSchemaMetadata(value: unknown): unknown {
  if (isArray(value)) return value.map(stripSchemaMetadata)
  if (!isRecord(value)) return value

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '$schema' && key !== '$id' && key !== '~standard')
      .map(([key, nested]) => [key, stripSchemaMetadata(nested)])
  )
}

/**
 * 深度遍历，把所有 `$ref` 交给 `normalizeSharedSchemaRef` 改写成包内相对引用，其余键递归处理。
 * zod 按注册表出 schema 时共享定义会带上外部 URI 前缀，那样的引用在单份 bundle 里解析不了，
 * 必须先归一成 `#/$defs/…` 才能自包含。
 */
export function normalizeSharedSchemaRefs(value: unknown, context: ToolSchemaBundleContext): unknown {
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

/**
 * 单条引用改写：前缀是共享 schema 的外部 URI（如 `tool-contract-shared#/$defs/`）时换成包内的
 * `#/$defs/`，定义名部分不变；其他引用原样返回，不做任何猜测。
 */
function normalizeSharedSchemaRef(ref: string, context: ToolSchemaBundleContext): string {
  return ref.startsWith(context.sharedSchemaRefPrefix)
    ? `${context.bundleSharedSchemaRefPrefix}${ref.slice(context.sharedSchemaRefPrefix.length)}`
    : ref
}
