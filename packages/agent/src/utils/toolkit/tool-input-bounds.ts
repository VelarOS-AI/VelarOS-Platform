import { z } from 'zod'

import { isArray, isNumber, isPlainObject, isString } from '@velaros-ai/core'
import { clampRounded } from '@velaros-ai/core/utils/number'

import { AgentToolLimits } from '../../contract/constants.js'
import type { BoundedReadInput, JsonSchemaObject,RecursiveTraversalInput } from '../../types/toolkit.js'

import {
  isStructuredParameterDescription,
  renderParameterDescription as parameterDescription,
} from './tool-description'

/**
 * 工具输入边界校验文案。
 *
 * 数量类参数一律走 {@link clampRounded} 钳制而非拒绝——模型给大值是「尽量多」的合理意图，
 * 结果仍有界；硬拒只会烧一轮重试。上下界写进参数描述保住模型可见性
 * （transform 后 JSON Schema 不再带 minimum/maximum）。
 *
 * 这些提示会返回给模型/前端，目的是强制读文件、递归遍历、全文搜索都带上上限，
 * 避免一次工具调用吞掉过多上下文或扫完整个仓库。
 */
const ToolInputBoundMessages = {
  readUpperBoundRequired: '必须提供 endLine 或 maxChars，用于限制读取范围',
  lineRangeOrder: 'endLine 必须大于或等于 startLine',
} as const

const ReadBoundJsonSchemaAnyOf = [
  {
    required: ['range'],
    properties: {
      range: {
        required: ['endLine'],
      },
    },
  },
  {
    required: ['maxBytes'],
  },
  {
    required: ['maxChars'],
  },
  {
    required: ['allowUnbounded'],
    properties: {
      allowUnbounded: {
        const: true,
      },
    },
  },
] as const

/** 把值收窄成 JSON Schema 节点：判据就是「是个普通对象」，数组与标量为假（不校验 schema 关键字本身）。 */
function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return isPlainObject(value)
}

/**
 * 深拷贝一段 JSON Schema：数组与普通对象逐层重建，其余标量原样返回。
 * 用来把 `as const` 冻结的常量模板拷成可写副本再拼进目标 schema，免得注入后被下游改坏共享常量。
 * 只认数组和普通对象，不处理循环引用（schema 常量里没有）。
 */
function cloneJsonSchemaValue(value: unknown): unknown {
  if (isArray(value)) return value.map(cloneJsonSchemaValue)
  if (!isJsonSchemaObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, cloneJsonSchemaValue(nested)])
  )
}

/** 判断某 schema 的 `properties` 下是否自有这个属性名（`properties` 不是对象时为假，不查原型链）。 */
function schemaHasProperty(schema: JsonSchemaObject, propertyName: string): boolean {
  return isJsonSchemaObject(schema.properties) && Object.hasOwn(schema.properties, propertyName)
}

/**
 * 按**字段形态**认出「这是一份有界读取的入参 schema」：`path`、`range`、`maxBytes`、`maxChars`、
 * `allowUnbounded` 五个属性必须齐备，缺一即为假。不看工具名也不看任何标记，所以任何工具只要长成
 * 这个样子都会被补上有界分支；反过来说，少写一个字段就整个不认，宁可漏注入也不错注入。
 */
function isReadInputJsonSchema(schema: JsonSchemaObject): boolean {
  if (!isJsonSchemaObject(schema.properties)) return false
  return (
    schemaHasProperty(schema, 'path') &&
    schemaHasProperty(schema, 'range') &&
    schemaHasProperty(schema, 'maxBytes') &&
    schemaHasProperty(schema, 'maxChars') &&
    schemaHasProperty(schema, 'allowUnbounded')
  )
}

/**
 * 判断有界读取的 `anyOf` 分支是否已经注入过：把现有 anyOf 各分支的 `required` 并成一个集合，
 * `range`、`maxBytes`、`maxChars`、`allowUnbounded` 四个都出现才算有。只看字段名不看分支结构，
 * 所以调用方自己手写过等价约束时也能识别出来、不会被重复注入一遍。
 */
function hasReadBoundJsonSchemaAnyOf(schema: JsonSchemaObject): boolean {
  if (!isArray(schema.anyOf)) return false
  const requiredFields = new Set(
    schema.anyOf.flatMap((branch) => (
      isJsonSchemaObject(branch) && isArray(branch.required)
        ? branch.required.filter(isString)
        : []
    ))
  )
  return (
    requiredFields.has('range') &&
    requiredFields.has('maxBytes') &&
    requiredFields.has('maxChars') &&
    requiredFields.has('allowUnbounded')
  )
}

/**
 * 把「读取必须有上界」的四选一分支（给 range.endLine / 给 maxBytes / 给 maxChars /
 * 显式 `allowUnbounded: true`）追加进 schema 的 `anyOf`，返回新对象，原字段平铺形态不变。
 * 已注入过就原样返回同一引用；原有 anyOf 分支保留在前，追加的是常量模板的深拷贝。
 */
function addReadBoundJsonSchemaAnyOf(schema: JsonSchemaObject): JsonSchemaObject {
  if (hasReadBoundJsonSchemaAnyOf(schema)) return schema
  return {
    ...schema,
    anyOf: [
      ...(isArray(schema.anyOf) ? schema.anyOf : []),
      ...(cloneJsonSchemaValue(ReadBoundJsonSchemaAnyOf) as unknown[]),
    ],
  }
}

/**
 * 把“读取必须有上界”的运行时约束补进模型可见的参数结构。
 *
 * 额外校验不会自动出现在工具参数结构里；模型入口和宿主只看结构时，
 * 会误以为 `{ path:"..." }` 合法。这里按字段形态识别读取输入，
 * 追加等价的分支要求，并保持原有字段平铺形态。
 */
function withReadBoundJsonSchemaConstraints(value: unknown): unknown {
  if (isArray(value)) return value.map(withReadBoundJsonSchemaConstraints)
  if (!isJsonSchemaObject(value)) return value

  const next = Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      withReadBoundJsonSchemaConstraints(nested),
    ])
  )
  return isReadInputJsonSchema(next) ? addReadBoundJsonSchemaAnyOf(next) : next
}

/** 往 zod refinement 上追加自定义问题，统一 path/message 写法。 */
function addCustomIssue(refinementContext: z.RefinementCtx, path: string[], message: string): void {
  refinementContext.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message,
  })
}

/** 必填正整数结果上限，常用于 maxResults。 */
function normalizeParameterDescription(description: string): string {
  return isStructuredParameterDescription(description)
    ? description
    : parameterDescription({ description })
}

/**
 * 造一条「有界结果上限」参数 schema（典型用途 maxResults）：**可选**，省略时默认取 `max`；
 * 传了就取整并钳进 [1, max]，超限不报错只夹回上限。这样既没有「首次漏传 limit 直接 schema 报错」，
 * 也没有「limit 给大一点整个调用作废」两道摩擦，结果始终有界。
 * 描述文案会先过 `normalizeParameterDescription` 归成结构化形式再 `describe`——
 * transform 之后 JSON Schema 里不再保留 minimum/maximum，上下界只能靠描述让模型看到。
 * 名字里的 `required` 只为兼容既有引用，语义上它是可选参数。
 */
function requiredResultLimit(max: number, description: string) {
  // 可选 + 以 max 为默认上限:省略按 max 兜底,超限钳到 max(结果仍有界),
  // 消除"首漏 limit 报 schema 错"与"limit 给大即整调用报废"两个门槛。
  // 名字保留 required 仅为兼容既有引用,语义是"有界结果上限"。
  return z
    .number()
    .transform((value) => clampRounded(value,1, max))
    .default(max)
    .describe(normalizeParameterDescription(description))
}

/** 正整数递归深度,超限钳制(≥1;适合要求至少进入一层子目录的工具)。 */
function requiredPositiveMaxDepth(max: number, description: string) {
  return z
    .number()
    .transform((value) => clampRounded(value,1, max))
    .describe(normalizeParameterDescription(description))
}

/** 非负递归深度,超限钳制(maxDepth=0 表示只处理当前层)。 */
function requiredNonNegativeMaxDepth(max: number, description: string) {
  return z
    .number()
    .transform((value) => clampRounded(value,0, max))
    .describe(normalizeParameterDescription(description))
}

/** 可选起始行 schema，统一要求正整数。 */
function optionalReadStartLine(description: string) {
  return z.number().int().positive().optional().describe(normalizeParameterDescription(description))
}

/** 可选结束行 schema，统一要求正整数。 */
function optionalReadEndLine(description: string) {
  return z.number().int().positive().optional().describe(normalizeParameterDescription(description))
}

/**
 * 可选字符上限 schema，工具可传入各自的最大值。
 * 宽容:超上限钳制到 max 而非拒绝(模型读大文件时常直接给巨大 maxChars,结果仍有界);
 * 非整数取整、非正数提到 1。
 */
function optionalReadMaxChars(max: number, description: string) {
  return z
    .number()
    .transform((value) => clampRounded(value, 1, max))
    .optional()
    .describe(normalizeParameterDescription(description))
}

/** 校验读文件行号顺序；模型可见的上界要求由 JSON schema 注入，执行层负责兜底默认上界。 */
function refineBoundedReadInput(value: BoundedReadInput, refinementContext: z.RefinementCtx): void {
  // 行号范围倒置时直接指出 endLine，方便模型修正参数。
  if (
    isNumber(value.startLine) &&
    isNumber(value.endLine) &&
    value.startLine > value.endLine
  ) {
    addCustomIssue(refinementContext, ['endLine'], ToolInputBoundMessages.lineRangeOrder)
  }
}

/**
 * recursive=true 但没给 maxDepth 时,自动补一个安全默认深度(而非报错)。
 * 模型常写 { recursive: true } 忘带 maxDepth——这是「合理意图撞硬约束」的高频摩擦,
 * 用默认值兜底比让它报错重试友好得多;深度仍有界(AgentToolLimits.payload.defaultRecursiveMaxDepth),不会无限遍历。
 */
function applyDefaultRecursiveMaxDepth<T extends RecursiveTraversalInput>(value: T): T {
  if (value.recursive && !isNumber(value.maxDepth))
    return { ...value, maxDepth: AgentToolLimits.payload.defaultRecursiveMaxDepth }
  return value
}


export {
  applyDefaultRecursiveMaxDepth,
  optionalReadEndLine,
  optionalReadMaxChars,
  optionalReadStartLine,
  refineBoundedReadInput,
  requiredNonNegativeMaxDepth,
  requiredPositiveMaxDepth,
  requiredResultLimit,
  ToolInputBoundMessages,
  withReadBoundJsonSchemaConstraints,
}
