import { z } from 'zod'

import { isArray, isBoolean, isEmpty, isRecord, isString,isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { AgentOutputJsonSchema } from '../../types/agent.js'
import type { CompiledSubAgentOutputSchema, StructuredOutputParseResult } from '../../types/delegation.js'


const MaxStructuredOutputSchemaBytes = 16 * 1024
const MaxStructuredOutputBytes = 64 * 1024
const MaxStructuredOutputSchemaDepth = 8
const MaxStructuredOutputSchemaProperties = 64
const MaxStructuredOutputSchemaEnumValues = 64

const AllowedSchemaKeywords = new Set([
  '$schema',
  'type',
  'title',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
])

const AllowedSchemaTypes = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
])

/**
 * 校验 schema 里的数值约束关键字：`undefined`（没写）直接放行，写了就必须是 [min, max] 闭区间内的整数，
 * 否则抛 `VALIDATION` 并在消息里点名是哪个字段。用来挡住 `maxLength: 1e9` 这类把上限写飞的 schema。
 */
function assertIntegerBound(
  value: unknown,
  label: string,
  min: number,
  max: number
): void {
  if (isUndefined(value)) return
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new AppError('VALIDATION', `${label} 必须是 ${min}-${max} 的整数。`)
  }
}

/**
 * 递归校验一个 JSON Schema 节点是否落在首版支持的子集内，不合规就抛 `VALIDATION`（消息里带 `$.a.b` 这样的路径）。
 *
 * 把关六项：节点必须是对象、深度不超过 MaxStructuredOutputSchemaDepth、关键字必须在 AllowedSchemaKeywords 内
 * （`$ref`/`oneOf`/`allOf` 等一律拒绝，不做静默忽略——忽略会让调用方以为约束生效了）、`type` 在 AllowedSchemaTypes 内、
 * `required`/`additionalProperties`/`enum` 形状正确、以及各数值边界合法。properties 总数用 `state` 跨递归累加，
 * 因此上限是**整棵树**的属性数而不是每层各自的数。
 */
function inspectSchemaNode(
  node: unknown,
  path: string,
  depth: number,
  state: { properties: number }
): void {
  if (!isRecord(node)) {
    throw new AppError('VALIDATION', `${path} 必须是 JSON Schema 对象。`)
  }
  if (depth > MaxStructuredOutputSchemaDepth) {
    throw new AppError(
      'VALIDATION',
      `output schema 深度超过 ${MaxStructuredOutputSchemaDepth}。`
    )
  }

  const unsupported = Object.keys(node).filter((key) => !AllowedSchemaKeywords.has(key))
  if (!isEmpty(unsupported)) {
    throw new AppError(
      'VALIDATION',
      `${path} 含首版不支持的 schema 关键字：${unsupported.join(', ')}。`
    )
  }

  if (!isUndefined(node.type) && !AllowedSchemaTypes.has(String(node.type))) {
    throw new AppError('VALIDATION', `${path}.type 不受支持：${String(node.type)}。`)
  }
  if (!isUndefined(node.required)) {
    if (!isArray(node.required) || node.required.some((value) => !isString(value))) {
      throw new AppError('VALIDATION', `${path}.required 必须是字符串数组。`)
    }
  }
  if (
    !isUndefined(node.additionalProperties) &&
    !isBoolean(node.additionalProperties)
  ) {
    throw new AppError('VALIDATION', `${path}.additionalProperties 首版只支持 boolean。`)
  }
  if (!isUndefined(node.enum)) {
    if (!isArray(node.enum) || node.enum.length > MaxStructuredOutputSchemaEnumValues) {
      throw new AppError(
        'VALIDATION',
        `${path}.enum 最多 ${MaxStructuredOutputSchemaEnumValues} 项。`
      )
    }
  }

  assertIntegerBound(node.minLength, `${path}.minLength`, 0, MaxStructuredOutputBytes)
  assertIntegerBound(node.maxLength, `${path}.maxLength`, 0, MaxStructuredOutputBytes)
  assertIntegerBound(node.minItems, `${path}.minItems`, 0, 256)
  assertIntegerBound(node.maxItems, `${path}.maxItems`, 0, 256)

  if (!isUndefined(node.properties)) {
    if (!isRecord(node.properties)) {
      throw new AppError('VALIDATION', `${path}.properties 必须是对象。`)
    }
    for (const [key, child] of Object.entries(node.properties)) {
      state.properties += 1
      if (state.properties > MaxStructuredOutputSchemaProperties) {
        throw new AppError(
          'VALIDATION',
          `output schema properties 总数超过 ${MaxStructuredOutputSchemaProperties}。`
        )
      }
      inspectSchemaNode(child, `${path}.properties.${key}`, depth + 1, state)
    }
  }
  if (!isUndefined(node.items)) {
    inspectSchemaNode(node.items, `${path}.items`, depth + 1, state)
  }
}

/**
 * 把调用方给的 JSON Schema 编译成可反复校验的 zod schema，同时留下序列化原文（修复提示词要把它原样贴给模型）。
 *
 * 顺序是先序列化并卡 MaxStructuredOutputSchemaBytes 字节上限，再逐节点做子集校验，最后交给 `z.fromJSONSchema`。
 * 任一步不过都抛 `VALIDATION`，绝不返回一个"半能用"的 schema——契约在派发前就失败，好过子 Agent 跑完才发现校验不了。
 */
function compileSubAgentOutputSchema(
  schema: AgentOutputJsonSchema
): CompiledSubAgentOutputSchema {
  let serialized: string
  try {
    serialized = JSON.stringify(schema)
  } catch {
    throw new AppError('VALIDATION', 'output schema 必须可以序列化为 JSON。')
  }
  if (Buffer.byteLength(serialized, 'utf8') > MaxStructuredOutputSchemaBytes) {
    throw new AppError(
      'VALIDATION',
      `output schema 超过 ${MaxStructuredOutputSchemaBytes} bytes。`
    )
  }

  inspectSchemaNode(schema, '$', 0, { properties: 0 })
  try {
    return {
      schema: z.fromJSONSchema(schema as never),
      serialized,
    }
  } catch (error) {
    throw new AppError(
      'VALIDATION',
      `output schema 无法编译：${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * 从子 Agent 的最终回复里挑出待解析的 JSON 文本：全文恰好只有**一个** ``` 代码块时取块内内容（并剥掉语言标注），
 * 其余情况（没有代码块、或有多个）原样返回去空白后的全文。
 * 只认"唯一一个"是刻意的——有多个块时无从判断哪个才是交付物，交给 JSON.parse 去失败、走修复轮，比猜错一个块更安全。
 */
function extractJsonCandidate(text: string): string {
  const trimmed = text.trim()
  const fenced: string[] = []
  let cursor = 0
  while (cursor < trimmed.length) {
    const open = trimmed.indexOf('```', cursor)
    if (open < 0) break
    const close = trimmed.indexOf('```', open + 3)
    if (close < 0) break
    const body = stripStructuredOutputFenceLanguage(trimmed.slice(open + 3, close))
    fenced.push(body)
    cursor = close + 3
  }
  if (fenced.length === 1 && fenced[0]) return fenced[0]
  return trimmed
}

/**
 * 剥掉代码块正文开头的语言标注（`markdown` / `json` / `md`，大小写不敏感），返回去空白后的正文。
 * 不在这三种之内的标注保持原样——那更可能是内容本身而不是标注，剥错会直接破坏 JSON。
 */
function stripStructuredOutputFenceLanguage(value: string): string {
  const trimmed = value.trim()
  const lower = trimmed.toLowerCase()
  for (const language of ['markdown', 'json', 'md']) {
    if (!lower.startsWith(language)) continue
    return trimmed.slice(language.length).trim()
  }

  return trimmed
}

/**
 * 把子 Agent 的最终回复解析并校验成结构化输出。
 *
 * 三道关：超过 MaxStructuredOutputBytes 直接判失败（不截断——半个 JSON 没有意义）、JSON 解析失败、schema 校验失败。
 * 失败时不抛异常，而是回 `{ success: false, issues }`，**最多带三条** issue（够模型定位问题，又不会让修复提示词喧宾夺主），
 * 由调用方拿去拼修复轮提示词。
 */
function parseSubAgentStructuredOutput(
  text: string,
  compiled: CompiledSubAgentOutputSchema
): StructuredOutputParseResult {
  const candidate = extractJsonCandidate(text)
  if (Buffer.byteLength(candidate, 'utf8') > MaxStructuredOutputBytes) return {
      success: false,
      issues: [`结构化输出超过 ${MaxStructuredOutputBytes} bytes。`],
    }

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch (error) {
    return {
      success: false,
      issues: [`不是合法 JSON：${error instanceof Error ? error.message : String(error)}`],
    }
  }

  const result = compiled.schema.safeParse(parsed)
  if (result.success) return { success: true, data: result.data }

  return {
    success: false,
    issues: result.error.issues.slice(0, 3).map((issue) => {
      const path = !isEmpty(issue.path) ? issue.path.join('.') : '$'
      return `${path}: ${issue.message}`
    }),
  }
}

/**
 * 结构化输出没通过校验时，拼一条追加给子 Agent 的修复提示：列出编号后的问题、附上必须满足的 schema 原文，
 * 并明确要求这一轮只返回 JSON、不调用工具、不加解释——修复轮再去调工具只会把上下文越滚越大。
 */
function buildStructuredOutputRepairPrompt(
  serializedSchema: string,
  issues: readonly string[]
): string {
  return [
    '[系统] 你刚才的最终结构化输出未通过调用方 schema 校验。',
    `问题：\n${issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}`,
    `必须满足的 JSON Schema：\n${serializedSchema}`,
    '请现在只返回一个满足 schema 的 JSON 值；不要调用工具，不要加解释。',
  ].join('\n\n')
}

export {
  buildStructuredOutputRepairPrompt,
  compileSubAgentOutputSchema,
  MaxStructuredOutputBytes,
  MaxStructuredOutputSchemaBytes,
  parseSubAgentStructuredOutput,
}
