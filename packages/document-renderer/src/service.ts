import type { z } from 'zod'

import { isEmpty, isObject, isString, truncate } from '@velaros-ai/core'

import { RendererPathDeniedError } from './path-policy'
import {
  type DocumentRendererErrorCode,
  DocumentRendererProtocolVersion,
  DocumentRendererRequestSchema,
  type DocumentRendererResponse,
} from './protocol'
import {
  describeRenderer,
  renderOfficeDocument,
  renderPdfPage,
  UnsupportedRendererFormatError,
} from './renderer'

/** 一条回执里最多列几处校验问题：再多调用方也读不过来，剩下的只报个数。 */
const MaxReportedIssues = 5
/** 单处说明的字符上限：避免把超长的输入值原样贴进回执。 */
const MaxIssueValueChars = 80

function errorResponse(
  requestId: string,
  code: DocumentRendererErrorCode,
  message: string,
): DocumentRendererResponse {
  return {
    protocolVersion: DocumentRendererProtocolVersion,
    requestId,
    status: 'error',
    error: { code, message },
  }
}

/** 请求还没解析出来（非法 JSON、命令行参数不对）时的回执：命令行与服务共用一条出口。 */
export function invalidRequestResponse(
  message: string,
  requestId = 'invalid-request',
): DocumentRendererResponse {
  return errorResponse(requestId, 'INVALID_REQUEST', message)
}

export async function executeRendererRequest(input: unknown): Promise<DocumentRendererResponse> {
  const parsed = DocumentRendererRequestSchema.safeParse(input)
  if (!parsed.success) {
    const requestId = isObject(input)
      && 'requestId' in input && isString(input.requestId)
      ? input.requestId
      : 'invalid-request'
    return invalidRequestResponse(describeRequestIssues(parsed.error), requestId)
  }
  const request = parsed.data
  try {
    const result = request.operation === 'describe'
      ? describeRenderer()
      : request.operation === 'render-office'
        ? await renderOfficeDocument(request)
        : await renderPdfPage(request)
    return {
      protocolVersion: DocumentRendererProtocolVersion,
      requestId: request.requestId,
      status: 'success',
      result,
    }
  } catch (error) {
    if (error instanceof RendererPathDeniedError) return errorResponse(request.requestId, 'PATH_DENIED', error.message)
    if (error instanceof UnsupportedRendererFormatError) return errorResponse(request.requestId, 'UNSUPPORTED_FORMAT', error.message)
    return errorResponse(
      request.requestId,
      'RENDER_FAILED',
      error instanceof Error ? error.message : String(error),
    )
  }
}

/**
 * 把 zod 的校验结果收成一句可读的中文说明。
 *
 * 原先直接把 `error.message`（zod 的 issue 数组 JSON 文本，英文、多行、几百字符）塞进回执，
 * 调用方与模型都读不出「哪个字段不对」。字段路径与期望值原样夹在中文说明里。
 */
function describeRequestIssues(error: z.ZodError): string {
  const issues = error.issues.slice(0, MaxReportedIssues).map(describeIssue)
  const remaining = error.issues.length - issues.length
  const tail = remaining > 0 ? `；另有 ${remaining} 处问题` : ''
  return `请求不合法：${issues.join('；')}${tail}`
}

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
      return `${field} 不合法（${truncate(issue.message, MaxIssueValueChars)}）`
  }
}

function formatValues(values: readonly unknown[]): string {
  const texts = values.map((value) => String(value))
  if (texts.length <= 1) return texts.join('')
  return `${texts.slice(0, -1).join('、')} 或 ${texts.at(-1)}`
}

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
