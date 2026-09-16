/**
 * 请求的 zod schema 与校验说明。schema 不出包：外面只经 JSON 命令协议进来，拿不到也不需要它。
 *
 * 每个 schema 都 `satisfies z.ZodType<T>` 对齐 `types/rendering.ts` 里手写的请求类型；schema 与类型走形，这里编译就红。
 * 上限一律引 `contract/constants.ts` 的常量表，改一处校验与文档一起变。
 */
import { z } from 'zod'

import { isEmpty, isObject, isString, truncate } from '@velaros-ai/core'

import {
  DocumentRendererFormats,
  DocumentRendererLimits,
  DocumentRendererProtocol,
} from '../contract/constants.js'
import type {
  DescribeRendererRequest,
  DocumentRendererRequest,
  DocumentRendererRequestCheck,
  RenderOfficeRequest,
  RenderPdfPageRequest,
} from '../types/rendering.js'

import { DocumentRendererTuning } from './tuning.js'

const requestHeaderSchema = z.object({
  protocolVersion: z.literal(DocumentRendererProtocol.version),
  requestId: z.string().min(1).max(DocumentRendererLimits.requestIdChars),
})

const pathRequestSchema = requestHeaderSchema.extend({
  projectRoot: z.string().min(1).max(DocumentRendererLimits.pathChars),
  inputPath: z.string().min(1).max(DocumentRendererLimits.pathChars),
  outputPath: z.string().min(1).max(DocumentRendererLimits.pathChars),
})

const describeRequestSchema = requestHeaderSchema.extend({
  operation: z.literal('describe'),
}) satisfies z.ZodType<DescribeRendererRequest>

const renderOfficeRequestSchema = pathRequestSchema.extend({
  operation: z.literal(DocumentRendererFormats.renderOffice.name),
  maxItems: z.number().int()
    .min(DocumentRendererLimits.minimumOfficeItems)
    .max(DocumentRendererLimits.maximumOfficeItems)
    .optional(),
}) satisfies z.ZodType<RenderOfficeRequest>

const renderPdfPageRequestSchema = pathRequestSchema.extend({
  operation: z.literal(DocumentRendererFormats.renderPdfPage.name),
  page: z.number().int().positive().optional(),
  scale: z.number()
    .min(DocumentRendererLimits.minimumPdfScale)
    .max(DocumentRendererLimits.maximumPdfScale)
    .optional(),
}) satisfies z.ZodType<RenderPdfPageRequest>

const documentRendererRequestSchema = z.discriminatedUnion('operation', [
  describeRequestSchema,
  renderOfficeRequestSchema,
  renderPdfPageRequestSchema,
]) satisfies z.ZodType<DocumentRendererRequest>

/** 按协议校验一次请求：合法给出定型后的请求，不合法给出一句中文说明。 */
export function checkDocumentRendererRequest(value: unknown): DocumentRendererRequestCheck {
  const parsed = documentRendererRequestSchema.safeParse(value)
  if (parsed.success) return { ok: true, request: parsed.data }
  return { ok: false, message: describeRequestIssues(parsed.error) }
}

/** 从还没通过校验的入参里捞 requestId；捞不到就用调用方给的占位，回执一定带一个身份。 */
export function readRequestId(value: unknown, fallback: string): string {
  return isObject(value) && 'requestId' in value && isString(value.requestId)
    ? value.requestId
    : fallback
}

/**
 * 把 zod 的校验结果收成一句可读的中文说明。
 *
 * 直接把 `error.message`（zod 的 issue 数组 JSON 文本，英文、多行、几百字符）塞进回执的话，
 * 调用方与模型都读不出「哪个字段不对」。字段路径与期望值原样夹在中文说明里。
 */
function describeRequestIssues(error: z.ZodError): string {
  const issues = error.issues
    .slice(0, DocumentRendererTuning.invalidRequest.reportedIssues)
    .map(describeIssue)
  const remaining = error.issues.length - issues.length
  const tail = remaining > 0 ? `；另有 ${remaining} 处问题` : ''
  return `请求不合法：${issues.join('；')}${tail}`
}

/** 把一处校验问题写成一句话：哪个字段、期望什么。 */
function describeIssue(issue: z.core.$ZodIssue): string {
  const field = isEmpty(issue.path) ? '请求体' : issue.path.join('.')
  switch (issue.code) {
    case 'invalid_union': {
      // 判别联合没对上时，zod 只在「一个分支都没匹配」这一支上带候选值。
      const options = 'options' in issue ? issue.options ?? [] : []
      return isEmpty(options) ? `${field} 不合法` : `${field} 应为 ${formatValues(options)}`
    }
    case 'invalid_value':
      return `${field} 只能是 ${formatValues(issue.values)}`
    case 'invalid_type':
      return `${field} 应为${describeTypeName(issue.expected)}`
    case 'too_small':
      return `${field} ${issue.origin === 'string' ? `至少 ${issue.minimum} 个字符` : `不能小于 ${issue.minimum}`}`
    case 'too_big':
      return `${field} ${issue.origin === 'string' ? `最多 ${issue.maximum} 个字符` : `不能大于 ${issue.maximum}`}`
    case 'unrecognized_keys':
      return `不认识的字段：${issue.keys.join('、')}`
    default:
      return `${field} 不合法（${truncate(issue.message, DocumentRendererTuning.invalidRequest.messageChars)}）`
  }
}

/** 把一组候选值写成「甲、乙 或 丙」。 */
function formatValues(values: readonly unknown[]): string {
  const texts = values.map((value) => String(value))
  if (texts.length <= 1) return texts.join('')
  return `${texts.slice(0, -1).join('、')} 或 ${texts.at(-1)}`
}

/** 把 zod 的类型名翻成中文；认不出的原样写回去。 */
function describeTypeName(expected: string): string {
  switch (expected) {
    case 'string': return '字符串'
    case 'number': return '数字'
    case 'boolean': return '布尔值'
    case 'object': return '对象'
    case 'array': return '数组'
    default: return expected
  }
}
