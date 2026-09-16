import {
  isPlainObject,
  isString,
  numberOrNull,
  toOptional,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ProviderResponseFailure } from '../../types/loop.js'
import { AgentTuning } from '../tuning'

/** 供应方错误正文进诊断的字符上限，值在 `AgentTuning.retry.providerErrorBodyBytes`。 */
const MaxProviderErrorBodyChars = AgentTuning.retry.providerErrorBodyBytes

/**
 * 取一个「非空白字符串」：不是 string 返回 null，是 string 则 trim 后仍为空也返回 null。
 * 供应商错误正文里常见空串/全空格字段，用它统一折成 null 好让后面的 `??` 链继续往下找。
 */
function nonBlankString(value: unknown): Nullable<string> {
  if (!isString(value)) return null
  const normalized = value.trim()
  return normalized ? normalized : null
}

/**
 * 把供应商响应正文归一成对象：已经是普通对象就直接返回；是字符串且长度不超过
 * `MaxProviderErrorBodyChars`（64 KiB）才尝试 `JSON.parse`。超长、非字符串、解析失败或解析出非对象
 * 一律返回 null。超长直接不解析是为了不在错误路径上被超大正文拖住；解析失败静默吞掉，
 * 因为错误正文本来就允许不是 JSON，且原文可能带凭据、绝不能落日志。
 */
function parseResponseBody(value: unknown): Nullable<Record<string, unknown>> {
  if (isPlainObject(value)) return value
  if (!isString(value) || value.length > MaxProviderErrorBodyChars) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    // arch-guard:silent-catch-ok provider 错误正文允许不是 JSON；安全归一化必须回退，且不能记录可能含凭据的原文。
    return null
  }
}

/**
 * 从已解析的错误正文里挑出 code 与 message，兼容两种常见形状：平铺的 `{code, message}` 与嵌套的
 * `{error: {code, message}}`。message 的优先级是 `error`（供应商把错误直接写成字符串的情况）
 * → `message` → `error.message`，取到第一个非空白的就停。两个字段都可能为 null。
 * 只取这两个标准字段，正文其余部分（可能含请求回显、凭据）一概不带出去。
 */
function readPayloadFailure(
  payload: Record<string, unknown>
): Pick<ProviderResponseFailure, 'code' | 'message'> {
  const nestedError = isPlainObject(payload.error) ? payload.error : null
  return {
    code: nonBlankString(payload.code) ?? nonBlankString(nestedError?.code),
    message:
      nonBlankString(payload.error) ??
      nonBlankString(payload.message) ??
      nonBlankString(nestedError?.message),
  }
}

/**
 * 在错误对象里逐层找出供应商那一层的失败信息：本层有可解析的 `responseBody` 就取它的 code/message
 * 加本层 `statusCode` 收工，否则先钻 `cause` 再钻 `error` 继续找。**最多下钻 5 层**（`depth > 5` 即放弃），
 * 防止 cause 自引用造成的无限递归。一路没找到返回 null，调用方就退回原错误。
 */
function readProviderResponseFailure(
  error: unknown,
  depth = 0
): Nullable<ProviderResponseFailure> {
  if (depth > 5 || !isPlainObject(error)) return null
  const payload = parseResponseBody(error.responseBody)
  if (payload)
    return {
      ...readPayloadFailure(payload),
      statusCode: numberOrNull(error.statusCode),
    }
  return (
    readProviderResponseFailure(error.cause, depth + 1) ??
    readProviderResponseFailure(error.error, depth + 1)
  )
}

/**
 * 把供应商失败翻成给用户看的一句话。目前只特判 `QUOTA_EXCEEDED`（大小写不敏感），换成中文的
 * 「补额度或换服务商」提示；其余 code 一律原样透传供应商自己的 message，没有 message 就返回 null
 * 让调用方退回原错误文案。
 */
function userFacingProviderMessage(failure: ProviderResponseFailure): Nullable<string> {
  if (failure.code?.toUpperCase() === 'QUOTA_EXCEEDED') return '模型服务额度已用尽，请补充额度或切换服务商后重试。'
  return failure.message
}

/**
 * 将模型传输层的 HTTP 错误收敛为可安全跨运行时传递的错误。
 * 只读取标准 code/error/message 与状态码，不转发响应正文、请求体、请求头或凭据。
 */
export function normalizeModelRequestError(error: unknown): AppError {
  const fallback = AppError.from(error)
  const providerFailure = readProviderResponseFailure(error)
  if (!providerFailure) return fallback

  const providerCode = providerFailure.code
  const message = userFacingProviderMessage(providerFailure) ?? fallback.message
  return new AppError(providerCode ?? fallback.code, message, error, {
    ...fallback.context,
    providerCode: toOptional(providerCode),
    // 供应商没给状态码时沿用原错误里的状态码。
    statusCode: providerFailure.statusCode ?? fallback.context.statusCode,
  })
}
