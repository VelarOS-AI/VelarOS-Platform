// 域：模型请求重试的**叶子判定**——错误码 / 状态码 / 文案属于哪一类，以及 retry-after 头怎么读。
//
// 编排（要不要重试、等多久、怎么记日志）在 `impl/loop/RetryPolicy.ts`；这里的函数只看给进来的值下结论，
// 不持状态、不递归上层结构、不发事件。判据分成两边，谁也不许含糊：
//  - **非连接类**（鉴权、计费、配额、请求非法、上下文超限）：重发同样的请求必然再失败，不重试；
//  - **瞬态**（限流、网关 5xx、408 / 425 / 429、连接被切）：值得原样重发一次。
import { isArray, isFunction, isNumber, isObject, isPlainObject, isPresent, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { ConnectionRetryBlockReason, ConnectionRetryOptions, NonConnectionApiErrorMatcher } from '../../types/loop.js'

/** 明确属于「换个时间重发也一样会失败」的错误码：鉴权、计费、配额、请求非法、上下文超限等。 */
const NonConnectionApiErrorCodes = new Set([
  'authentication_error',
  'authentication_required',
  'bad_request',
  'billing_error',
  'billing_hard_limit_reached',
  'content_policy_violation',
  'context_length_exceeded',
  'dependency_unavailable',
  'desktop_offline_seat_occupied',
  'forbidden',
  'insufficient_quota',
  'internal_error',
  'invalid_api_key',
  'invalid_prompt',
  'invalid_request_error',
  'model_not_available',
  'model_not_found',
  'not_configured',
  'not_found',
  'not_found_error',
  'permission_denied',
  'permission_error',
  'rate_limited',
  'unauthorized',
  'unsupported_parameter',
  'validation_failed',
])

/** 限流类错误码：本身是「现在不行、等等再来」，属于值得重发的瞬态。 */
const TransientApiErrorCodes = new Set(['rate_limit_error', 'rate_limit_exceeded'])

/**
 * 命中以下匹配器即视为“鉴权/配额/上下文超限”类错误，不应重试。
 *
 * 使用 RegExp 而不是单纯字符串，是为了让分类对未来扩展（例如携带版本号
 * 的鉴权错误描述）保持稳定；reason 用于日志归因。
 */
const NonConnectionApiErrorMessageMatchers: NonConnectionApiErrorMatcher[] = [
  { pattern: /check your plan and billing/i, reason: 'billing' },
  { pattern: /context length/i, reason: 'context-length' },
  { pattern: /context window/i, reason: 'context-length' },
  { pattern: /maximum context/i, reason: 'context-length' },
  { pattern: /exceeded your current quota/i, reason: 'quota' },
  { pattern: /401\s+unauthorized/i, reason: 'unauthorized' },
  { pattern: /403\s+forbidden/i, reason: 'forbidden' },
  { pattern: /auth credentials/i, reason: 'authentication' },
  { pattern: /authentication/i, reason: 'authentication' },
  { pattern: /authorization/i, reason: 'authorization' },
  { pattern: /expired token/i, reason: 'expired-token' },
  { pattern: /forbidden/i, reason: 'forbidden' },
  { pattern: /incorrect api key/i, reason: 'invalid-api-key' },
  { pattern: /insufficient_quota/i, reason: 'quota' },
  { pattern: /invalid api key/i, reason: 'invalid-api-key' },
  { pattern: /invalid_api_key/i, reason: 'invalid-api-key' },
  { pattern: /jwt expired/i, reason: 'expired-token' },
  { pattern: /missing authentication header/i, reason: 'authentication' },
  { pattern: /not authorized/i, reason: 'unauthorized' },
  { pattern: /permission denied/i, reason: 'permission-denied' },
  { pattern: /permission_denied/i, reason: 'permission-denied' },
  { pattern: /too many tokens/i, reason: 'context-length' },
  { pattern: /unauthorized/i, reason: 'unauthorized' },
]

/** 这个 code / type 是不是明确的非连接类错误（大小写与首尾空白不计）。 */
export function isNonConnectionApiCode(code: unknown): boolean {
  return isString(code) && NonConnectionApiErrorCodes.has(code.trim().toLowerCase())
}

/** 这个 code / type 是不是限流类（瞬态）错误。 */
export function isTransientApiCode(code: unknown): boolean {
  return isString(code) && TransientApiErrorCodes.has(code.trim().toLowerCase())
}

/** 这个 HTTP 状态码是不是瞬态：408 / 425 / 429 与 5xx 都是网关、限流或超时，值得重发。 */
export function isTransientApiStatus(status: unknown): boolean {
  if (!isNumber(status)) return false
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)
}

/** 错误文案里是不是在说限流（rate limit / too many requests）。 */
export function isTransientApiMessage(message: unknown): boolean {
  if (!isString(message)) return false
  return /rate limit/i.test(message) || /too many requests/i.test(message)
}

/**
 * 这个 HTTP 状态码是不是「重发也白搭」：4xx 里除 408 / 425 / 429 之外全算，
 * 5xx 一律不算（那些交给连接层重试）。判据是不要对鉴权或配额错误硬撞。
 */
export function isNonConnectionApiStatus(status: unknown): boolean {
  if (!isNumber(status)) return false
  if (status >= 500 && status <= 599) return false
  if (status === 408 || status === 425 || status === 429) return false
  return status >= 400 && status <= 499
}

/** 错误文案是否命中非连接类匹配表（鉴权 / 计费 / 配额 / 上下文超限那一族）。 */
export function isNonConnectionApiMessage(message: unknown): boolean {
  if (!isString(message)) return false

  return NonConnectionApiErrorMessageMatchers.some(({ pattern }) => pattern.test(message))
}

/**
 * 这个错误是不是「被取消」而不是「失败」：错误码是 EXECUTION_ABORTED，或文案里带 abort / cancelled。
 * 中断优先于一切重试判定——用户已经喊停，再发一次是纯粹的浪费。
 */
export function isRetryAbortError(error: AppError): boolean {
  if (error.code === 'EXECUTION_ABORTED') return true

  const normalized = error.message.toLowerCase()
  return normalized.includes('abort') || normalized.includes('cancelled')
}

/**
 * 这是不是「一个字都没吐就空了」的流：只认 MODEL_EMPTY_RESPONSE 且来源是首个分片之前。
 * 这种流没有任何副作用泼出去，原样重发是安全的。
 */
export function isRetryableEmptyPreOutputStream(error: AppError): boolean {
  if (error.code !== 'MODEL_EMPTY_RESPONSE') return false

  const source = error.context?.source
  return source === 'stream-empty-before-first-chunk' || source === 'query-empty-before-first-chunk'
}

/**
 * 从各种形态的响应头容器里取一个头的值（大小写不敏感）：Headers 实例（有 get 方法）、
 * `[name, value]` 数组、或普通对象都认。取不到返回 null。
 */
export function readHeaderValue(headers: unknown, name: string): Nullable<string> {
  if (!isPresent(headers)) return null
  const key = name.toLowerCase()

  if (isObject(headers)) {
    const get = (headers as { get?: unknown }).get
    if (isFunction(get)) {
      const value = get.call(headers, name) ?? get.call(headers, key)
      if (isPresent(value)) return String(value)
    }
  }

  if (isArray(headers)) {
    for (const entry of headers) {
      if (!isArray(entry) || entry.length < 2) continue
      if (String(entry[0]).toLowerCase() === key) return String(entry[1])
    }
    return null
  }

  if (!isPlainObject(headers)) return null

  for (const [candidate, value] of Object.entries(headers)) {
    if (candidate.toLowerCase() === key && isPresent(value)) return String(value)
  }
  return null
}

/**
 * 解析 `retry-after-ms` 头（毫秒数）并钳到 maxDelayMs 以内；空、非数字或为负都返回 null。
 * 钳制是为了挡住上游给出的荒唐值（比如按毫秒算的一整年）把一次重试变成永久挂起。
 */
export function parseRetryAfterMsHeaderValue(
  value: Nullable<string>,
  maxDelayMs: number
): Nullable<number> {
  if (!value) return null

  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.min(Math.ceil(parsed), maxDelayMs)
}

/**
 * 解析 `retry-after` 头并折算成毫秒：先按「秒数」读，读不出再按 HTTP 日期读（取与此刻的差）。
 * 都读不出、或那个时间点已经过去，返回 null（表示这个头没给出可用的等待时长）。结果同样钳到 maxDelayMs。
 */
export function parseRetryAfterHeaderValue(
  value: Nullable<string>,
  maxDelayMs: number
): Nullable<number> {
  if (!value) return null

  const seconds = Number.parseFloat(value)
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(Math.ceil(seconds * 1_000), maxDelayMs)

  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null

  const delay = timestamp - Date.now()
  if (delay <= 0) return null
  return Math.min(Math.ceil(delay), maxDelayMs)
}

/**
 * 宿主自带重试策略时的**安全前置判定**：只问「这一次还允许重放吗」，不问错误值不值得重试
 * （那归宿主策略）。中断、已泼出的可见输出、已派发的工具调用各自给出一个拦截原因，能重放返回 null。
 */
export function resolveReplaySafetyBlockReason(
  error: unknown,
  options: Pick<ConnectionRetryOptions, 'abortSignal' | 'hasVisibleOutput' | 'hasToolUse'>
): Nullable<ConnectionRetryBlockReason> {
  if (options.abortSignal.aborted) return 'abort_signal'
  if (isRetryAbortError(AppError.from(error))) return 'abort_error'
  if (options.hasToolUse?.()) return 'tool_use_emitted'
  if (options.hasVisibleOutput?.()) return 'visible_output_emitted'
  return null
}

/**
 * 从一个错误对象上找响应头并读出重试等待时长：依次看 `responseHeaders` / `headers` /
 * `response.headers` / `data.responseHeaders`（各家 SDK 摆放位置不同），先认毫秒头再认秒/日期头。
 * 两个头都没给出可用值时返回 null，由调用方退回指数退避。
 */
export function readRetryAfterDelayMsFromRecord(
  record: Record<string, unknown>,
  maxDelayMs: number
): Nullable<number> {
  const headers =
    record.responseHeaders ??
    record.headers ??
    (isPlainObject(record.response) ? record.response.headers : null) ??
    (isPlainObject(record.data) ? record.data.responseHeaders : null)
  const retryAfterMs = parseRetryAfterMsHeaderValue(
    readHeaderValue(headers, 'retry-after-ms'),
    maxDelayMs
  )
  if (isPresent(retryAfterMs)) return retryAfterMs

  return parseRetryAfterHeaderValue(readHeaderValue(headers, 'retry-after'), maxDelayMs)
}

/**
 * 等下一次重试。等待期间盯着中断信号：进来时已中断、或等待中被中断，都立刻抛
 * `EXECUTION_ABORTED`，绝不在用户已取消之后还发下一次请求。
 */
export async function waitForRetryDelay(
  delayMs: number,
  abortSignal: AbortSignal
): Promise<void> {
  if (abortSignal.aborted) {
    throw new AppError('EXECUTION_ABORTED', '运行被终止')
  }

  try {
    await TimerScope.sleep(delayMs, { signal: abortSignal })
  } catch {
    throw new AppError('EXECUTION_ABORTED', '运行被终止')
  }
}
