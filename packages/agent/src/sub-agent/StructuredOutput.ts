import { z } from 'zod'

import type { AgentOutputJsonSchema } from '@velaros-ai/agent/protocol'
import { isEmpty, isRecord } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

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

interface CompiledSubAgentOutputSchema {
  schema: z.ZodType
  serialized: string
}

type StructuredOutputParseResult =
  | { success: true; data: unknown }
  | { success: false; issues: string[] }

function assertIntegerBound(
  value: unknown,
  label: string,
  min: number,
  max: number
): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new AppError('VALIDATION', `${label} 必须是 ${min}-${max} 的整数。`)
  }
}

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

  if (node.type !== undefined && !AllowedSchemaTypes.has(String(node.type))) {
    throw new AppError('VALIDATION', `${path}.type 不受支持：${String(node.type)}。`)
  }
  if (node.required !== undefined) {
    if (!Array.isArray(node.required) || node.required.some((value) => typeof value !== 'string')) {
      throw new AppError('VALIDATION', `${path}.required 必须是字符串数组。`)
    }
  }
  if (
    node.additionalProperties !== undefined &&
    typeof node.additionalProperties !== 'boolean'
  ) {
    throw new AppError('VALIDATION', `${path}.additionalProperties 首版只支持 boolean。`)
  }
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || node.enum.length > MaxStructuredOutputSchemaEnumValues) {
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

  if (node.properties !== undefined) {
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
  if (node.items !== undefined) {
    inspectSchemaNode(node.items, `${path}.items`, depth + 1, state)
  }
}

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

function extractJsonCandidate(text: string): string {
  const trimmed = text.trim()
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)]
  if (fenced.length === 1 && fenced[0]?.[1]) return fenced[0][1].trim()
  return trimmed
}

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
      const path = issue.path.length > 0 ? issue.path.join('.') : '$'
      return `${path}: ${issue.message}`
    }),
  }
}

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
export type { CompiledSubAgentOutputSchema, StructuredOutputParseResult }
