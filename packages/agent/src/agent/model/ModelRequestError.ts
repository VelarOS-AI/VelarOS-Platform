import {
  isNull,
  isPlainObject,
  isString,
  numberOrNull,
  toOptional,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

const MaxProviderErrorBodyChars = 64 * 1024

interface ProviderResponseFailure {
  readonly code: Nullable<string>
  readonly message: Nullable<string>
  readonly statusCode: Nullable<number>
}

function nonBlankString(value: unknown): Nullable<string> {
  if (!isString(value)) return null
  const normalized = value.trim()
  return normalized ? normalized : null
}

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
    ...(isNull(providerFailure.statusCode)
      ? {}
      : { statusCode: providerFailure.statusCode }),
  })
}
