import { z } from 'zod'

import { isArray, isNumber, isPlainObject, isString } from '../typeGuards'

import {
  isStructuredParameterDescription,
  renderParameterDescription as parameterDescription,
} from './ToolDescription'

/**
 * 工具输入边界校验文案。
 *
 * 这些提示会返回给模型/前端，目的是强制读文件、递归遍历、全文搜索都带上上限，
 * 避免一次工具调用吞掉过多上下文或扫完整个仓库。
 */
const ToolInputBoundMessages = {
  readUpperBoundRequired: '必须提供 endLine 或 maxChars，用于限制读取范围',
  lineRangeOrder: 'endLine 必须大于或等于 startLine',
} as const

/** 带上界的文件读取输入。 */
interface BoundedReadInput {
  /** 可选起始行。 */
  startLine?: number
  /** 读取结束行。 */
  endLine?: number
  /** 读取字符上限。 */
  maxChars?: number
}

/** 递归目录遍历输入。 */
interface RecursiveTraversalInput {
  /** 是否递归进入子目录。 */
  recursive?: boolean
  /** 递归最大深度。 */
  maxDepth?: number
}

type JsonSchemaObject = Record<string, unknown>

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

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return isPlainObject(value)
}

function cloneJsonSchemaValue(value: unknown): unknown {
  if (isArray(value)) return value.map(cloneJsonSchemaValue)
  if (!isJsonSchemaObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, cloneJsonSchemaValue(nested)])
  )
}

function schemaHasProperty(schema: JsonSchemaObject, propertyName: string): boolean {
  return isJsonSchemaObject(schema.properties) && Object.hasOwn(schema.properties, propertyName)
}

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
 * 通用数量钳制:取整,收进 [min,max]。
 * 铁律:数量/大小类参数超限一律钳制而非拒绝——模型给大值是"尽量多"的合理意图,
 * 结果仍有界;硬拒只会烧一轮重试。上下界写进参数描述保住模型可见性
 * (transform 后 JSON Schema 不再带 minimum/maximum)。
 */
function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function requiredResultLimit(max: number, description: string) {
  // 可选 + 以 max 为默认上限:省略按 max 兜底,超限钳到 max(结果仍有界),
  // 消除"首漏 limit 报 schema 错"与"limit 给大即整调用报废"两个门槛。
  // 名字保留 required 仅为兼容既有引用,语义是"有界结果上限"。
  return z
    .number()
    .transform((value) => clampInt(value, 1, max))
    .default(max)
    .describe(normalizeParameterDescription(description))
}

/** 正整数递归深度,超限钳制(≥1;适合要求至少进入一层子目录的工具)。 */
function requiredPositiveMaxDepth(max: number, description: string) {
  return z
    .number()
    .transform((value) => clampInt(value, 1, max))
    .describe(normalizeParameterDescription(description))
}

/** 非负递归深度,超限钳制(maxDepth=0 表示只处理当前层)。 */
function requiredNonNegativeMaxDepth(max: number, description: string) {
  return z
    .number()
    .transform((value) => clampInt(value, 0, max))
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
    .transform((value) => Math.min(max, Math.max(1, Math.round(value))))
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

/** recursive=true 但没给 maxDepth 时默认的安全上限:既保留有界遍历、又不因忘传而硬报错。 */
const DEFAULT_RECURSIVE_MAX_DEPTH = 8

/**
 * recursive=true 但没给 maxDepth 时,自动补一个安全默认深度(而非报错)。
 * 模型常写 { recursive: true } 忘带 maxDepth——这是「合理意图撞硬约束」的高频摩擦,
 * 用默认值兜底比让它报错重试友好得多;深度仍有界(DEFAULT_RECURSIVE_MAX_DEPTH),不会无限遍历。
 */
function applyDefaultRecursiveMaxDepth<T extends RecursiveTraversalInput>(value: T): T {
  if (value.recursive && !isNumber(value.maxDepth))
    return { ...value, maxDepth: DEFAULT_RECURSIVE_MAX_DEPTH }
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
