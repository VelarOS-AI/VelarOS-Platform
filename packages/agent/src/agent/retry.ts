import { isArray, isBoolean, isFunction,isNumber, isObject, isPlainObject,isPresent, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

/** 第一次重试的基础延迟。 */
const ConnectionRetryBaseDelayMs = 3_000
/** 退避封顶。超过这条线后不再翻倍，给瞬态故障留足缓冲又不让用户傻等。 */
const ConnectionRetryMaxDelayMs = 30_000
/** Jitter 上限（±）。多 worker 同时撞到 endpoint 时分散唤醒，避免羊群效应。 */
const ConnectionRetryJitterMs = 750
const ConnectionRetryHeaderMaxDelayMs = 2_147_483_647
const MaxConnectionRetryAttempts = 5
const AiSdkMaxRetries = 0

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

const TransientApiErrorCodes = new Set(['rate_limit_error', 'rate_limit_exceeded'])

interface NonConnectionApiErrorMatcher {
  pattern: RegExp
  reason: string
}

/** 上下文超限专用错误码：与 NonConnectionApiErrorCodes 的“context”子集对应。 */
const ContextOverflowErrorCodes = new Set(['context_length_exceeded'])

/** 上下文超限专用消息匹配器：仅命中“窗口/上下文/token 过多”这一类语义。 */
const ContextOverflowMessageMatchers: RegExp[] = [
  /context length/i,
  /context window/i,
  /maximum context/i,
  /too many tokens/i,
  /reduce the length/i,
  /prompt is too long/i,
  /input is too long/i,
  /string too long/i,
]

interface ContextOverflowReplayUnsafeDetails {
  hasVisibleOutput: boolean
  hasToolUse: boolean
}

const ContextOverflowReplayUnsafeSymbol = Symbol.for('velaros.contextOverflowReplayUnsafe')

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

interface ConnectionRetryOptions {
  phase: 'stream' | 'query'
  turn: Nullable<number>
  abortSignal: AbortSignal
  hasVisibleOutput?: () => boolean
  hasToolUse?: () => boolean
  onRetry?: (error: AppError, attempt: number) => void
}

type ConnectionRetryBlockReason =
  | 'abort_error'
  | 'abort_signal'
  | 'max_attempts'
  | 'non_connection_api_error'
  | 'not_transient_connection_error'
  | 'stalled_retry_exhausted'
  | 'tool_use_emitted'
  | 'visible_output_emitted'

/**
 * 重试策略：模型调用层的“瞬态网络错误”重试器。
 *
 * 与内置重试的关系：把最大重试次数设为 0，重试由本辅助器接管，
 * 以便：1) 在轮次已经产生可见输出或工具调用时禁止重试，避免重复发送事件；
 *       2) 用指纹精确区分“连接错误”（值得重试）与“鉴权、配额、上下文超限”（应直接抛）。
 *
 * 重试条件全部满足才重试：
 *  - 中断信号未触发；
 *  - 错误不是中断或取消；
 *  - 重试次数 ≤ MaxConnectionRetryAttempts（5 次）；
 *  - 当前轮次还没有可见输出或工具调用；
 *  - 错误指纹不命中显式的非连接错误，例如鉴权、计费、配额和上下文长度；
 *  - 错误命中网络相关的错误码、瞬时 API 状态码或关键词。
 *
 * 中断处理：等待重试时监听中断信号，触发时立即抛出执行中断错误，
 * 避免在用户已取消的情况下还在等下一次重试。
 */
class RetryPolicy {
  private readonly log = logRuntime.tag('RetryPolicy')

  public async runWithConnectionRetry<T>(
    operation: () => Promise<T>,
    options: ConnectionRetryOptions
  ): Promise<T> {
    let attempt = 1

    while (true) {
      try {
        return await operation()
      } catch (error) {
        const blockReason = this.getConnectionRetryBlockReason(error, attempt, options)
        if (blockReason) {
          const appError = AppError.from(error)
          if (this.isTransientConnectionError(appError)) {
            this.log.warn('transient model connection issue not retried', {
              phase: options.phase,
              turn: options.turn || undefined,
              attempt,
              reason: blockReason,
              code: appError.code,
              message: appError.message,
            })
          }
          throw error
        }

        const appError = AppError.from(error)
        const delayMs = this.getRetryDelayMs(attempt, error)
        options.onRetry?.(appError, attempt)
        this.log.warn('transient model connection issue, retrying', {
          phase: options.phase,
          turn: options.turn || undefined,
          attempt,
          delayMs,
          code: appError.code,
          message: appError.message,
        })
        await this.waitForRetry(delayMs, options.abortSignal)
        attempt += 1
      }
    }
  }

  public shouldRetryConnectionError(
    error: unknown,
    attempt: number,
    options: {
      abortSignal: AbortSignal
      hasVisibleOutput?: () => boolean
      hasToolUse?: () => boolean
    }
  ): boolean {
    return !this.getConnectionRetryBlockReason(error, attempt, options)
  }

  private getConnectionRetryBlockReason(
    error: unknown,
    attempt: number,
    options: {
      abortSignal: AbortSignal
      hasVisibleOutput?: () => boolean
      hasToolUse?: () => boolean
    }
  ): Nullable<ConnectionRetryBlockReason> {
    if (options.abortSignal.aborted) return 'abort_signal'

    const appError = AppError.from(error)
    if (this.isAbortError(appError)) return 'abort_error'

    // 一次 idle stall 已经消耗完整判死窗口；只允许一次安全重发，避免同一半开上游连续空等。
    if (appError.code === 'MODEL_STREAM_STALLED' && attempt > 1)
      return 'stalled_retry_exhausted'
    if (attempt > MaxConnectionRetryAttempts) return 'max_attempts'

    // 可见输出或工具调用已经发给 UI/历史后，重放流会复制 delta 或工具调用条目。
    // 因此连接重试只允许发生在本轮尚未产生任何可见副作用之前。
    if (options.hasToolUse?.()) return 'tool_use_emitted'
    if (options.hasVisibleOutput?.()) return 'visible_output_emitted'

    if (
      this.hasExplicitNonConnectionApiFailure(error) ||
      this.hasExplicitNonConnectionApiFailure(appError)
    )
      return 'non_connection_api_error'

    return this.isTransientConnectionError(appError) ? null : 'not_transient_connection_error'
  }

  /**
   * 判定是否为“上下文超限”类错误（缺页中断信号）。
   *
   * 与连接错误重试相互独立：连接错误重发同样请求即可；上下文超限重发同样历史只会再次失败，
   * 必须先做应急压缩腾出空间再重试。调用方据此决定是否进入缺页兜底闭环。
   */
  public isContextOverflowError(error: unknown, depth = 0): boolean {
    if (depth > 5 || !isPresent(error)) return false

    const fingerprint = this.buildErrorFingerprint(error).toLowerCase()
    if (ContextOverflowMessageMatchers.some((pattern) => pattern.test(fingerprint))) return true

    const appError = AppError.from(error)
    if (isString(appError.code) && ContextOverflowErrorCodes.has(appError.code.toLowerCase()))
      return true

    if (isPlainObject(error)) {
      const record = error
      const code = isString(record.code) ? record.code.toLowerCase() : null
      const type = isString(record.type) ? record.type.toLowerCase() : null
      if (
        (code && ContextOverflowErrorCodes.has(code)) ||
        (type && ContextOverflowErrorCodes.has(type))
      )
        return true
    }

    return false
  }

  public isTransientConnectionError(error: AppError): boolean {
    if (this.hasExplicitNonConnectionApiFailure(error)) return false

    // idle reader 主动切断半开模型流时，错误已经证明该请求不再前进。它与 socket timeout
    // 具有相同的恢复语义：仅由上层在尚无可见输出/工具副作用时重发，或保留部分输出后续写。
    if (error.code === 'MODEL_STREAM_STALLED') return true
    if (error.code === 'NETWORK' || error.code === 'TIMEOUT') return true
    if (this.hasTransientApiFailure(error)) return true
    if (this.isRetryableEmptyPreOutputStream(error)) return true

    const fingerprint = this.buildErrorFingerprint(error).toLowerCase()
    if (!fingerprint) return false

    return [
      'network error',
      'connection error',
      'connection reset',
      'connection closed',
      'connection lost',
      'cannot connect to api',
      'disconnected',
      'other side closed',
      'socket hang up',
      'socket closed',
      'secure tls connection',
      'tls connection',
      'fetch failed',
      'stream closed',
      'stream disconnected',
      'server disconnected',
      'broken pipe',
      'unexpected eof',
      'econnreset',
      'ehostunreach',
      'enotfound',
      'eai_again',
      'etimedout',
      'timed out',
      'timeout',
      'terminated',
      'und_err_socket',
    ].some((keyword) => fingerprint.includes(keyword))
  }

  public buildErrorFingerprint(error: unknown, depth = 0): string {
    if (depth > 4 || !isPresent(error)) return ''

    if (isString(error)) return error

    if (isNumber(error) || isBoolean(error)) return String(error)

    if (error instanceof Error) {
      const withCause = error as Error & {
        code?: unknown
        cause?: unknown
        lastError?: unknown
        errors?: unknown
      }
      return [
        error.name,
        error.message,
        isString(withCause.code) ? withCause.code : null,
        this.buildErrorFingerprint(withCause.cause, depth + 1),
        this.buildErrorFingerprint(withCause.lastError, depth + 1),
        isArray(withCause.errors)
          ? withCause.errors
              .map((nestedError) => this.buildErrorFingerprint(nestedError, depth + 1))
              .filter(Boolean)
              .join(' ')
          : null,
      ]
        .filter(Boolean)
        .join(' ')
    }

    if (isPlainObject(error)) {
      const record = error
      return [
        isString(record.name) ? record.name : null,
        isString(record.type) ? record.type : null,
        isString(record.code) ? record.code : null,
        isString(record.message) ? record.message : null,
        isNumber(record.status) ? String(record.status) : null,
        isNumber(record.statusCode) ? String(record.statusCode) : null,
        this.buildErrorFingerprint(record.cause, depth + 1),
        this.buildErrorFingerprint(record.error, depth + 1),
        this.buildErrorFingerprint(record.lastError, depth + 1),
        isArray(record.errors)
          ? record.errors
              .map((nestedError) => this.buildErrorFingerprint(nestedError, depth + 1))
              .filter(Boolean)
              .join(' ')
          : null,
      ]
        .filter(Boolean)
        .join(' ')
    }

    return String(error)
  }

  /**
   * 重试间隔：base × 2^(attempt-1) 指数退避，封顶 max；外加 ±jitter 分散并发请求时序。
   * 例：base=3s / max=30s / jitter=±750ms 时第 1/2/3/4/5 次约为 3s / 6s / 12s / 24s / 30s。
   */
  public getRetryDelayMs(attempt: number, error?: unknown): number {
    const headerDelayMs = this.readRetryAfterDelayMs(error)
    if (isPresent(headerDelayMs)) return headerDelayMs

    const exponent = Math.max(0, attempt - 1)
    const exponential = ConnectionRetryBaseDelayMs * 2 ** exponent
    const capped = Math.min(exponential, ConnectionRetryMaxDelayMs)
    const jitter = Math.floor((Math.random() * 2 - 1) * ConnectionRetryJitterMs)
    return Math.max(0, capped + jitter)
  }

  private readRetryAfterDelayMs(error: unknown, depth = 0): Nullable<number> {
    if (depth > 5 || !isPresent(error)) return null

    if (error instanceof Error) {
      const record = error as Error & Record<string, unknown>
      return (
        this.readRetryAfterDelayMsFromRecord(record) ??
        this.readRetryAfterDelayMs(record.cause, depth + 1) ??
        this.readRetryAfterDelayMs(record.error, depth + 1) ??
        this.readRetryAfterDelayMs(record.lastError, depth + 1) ??
        this.readRetryAfterDelayMs(record.errors, depth + 1)
      )
    }

    if (isArray(error)) {
      for (const item of error) {
        const delay = this.readRetryAfterDelayMs(item, depth + 1)
        if (isPresent(delay)) return delay
      }
      return null
    }

    if (!isPlainObject(error)) return null

    const record = error
    return (
      this.readRetryAfterDelayMsFromRecord(record) ??
      this.readRetryAfterDelayMs(record.cause, depth + 1) ??
      this.readRetryAfterDelayMs(record.error, depth + 1) ??
      this.readRetryAfterDelayMs(record.lastError, depth + 1) ??
      this.readRetryAfterDelayMs(record.errors, depth + 1)
    )
  }

  private readRetryAfterDelayMsFromRecord(record: Record<string, unknown>): Nullable<number> {
    const headers =
      record.responseHeaders ??
      record.headers ??
      (isPlainObject(record.response) ? (record.response).headers : null) ??
      (isPlainObject(record.data) ? (record.data).responseHeaders : null)
    const retryAfterMs = this.parseRetryAfterMsHeader(this.readHeader(headers, 'retry-after-ms'))
    if (isPresent(retryAfterMs)) return retryAfterMs

    return this.parseRetryAfterHeader(this.readHeader(headers, 'retry-after'))
  }

  private readHeader(headers: unknown, name: string): Nullable<string> {
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

  private parseRetryAfterMsHeader(value: Nullable<string>): Nullable<number> {
    if (!value) return null

    const parsed = Number.parseFloat(value)
    if (!Number.isFinite(parsed) || parsed < 0) return null
    return Math.min(Math.ceil(parsed), ConnectionRetryHeaderMaxDelayMs)
  }

  private parseRetryAfterHeader(value: Nullable<string>): Nullable<number> {
    if (!value) return null

    const seconds = Number.parseFloat(value)
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(Math.ceil(seconds * 1_000), ConnectionRetryHeaderMaxDelayMs)

    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp)) return null

    const delay = timestamp - Date.now()
    if (delay <= 0) return null
    return Math.min(Math.ceil(delay), ConnectionRetryHeaderMaxDelayMs)
  }

  private hasExplicitNonConnectionApiFailure(error: unknown, depth = 0): boolean {
    if (depth > 5 || !isPresent(error)) return false

    if (isString(error)) return this.isNonConnectionApiMessage(error)

    if (!isPlainObject(error)) return false

    if (isArray(error))
      return error.some((item) => this.hasExplicitNonConnectionApiFailure(item, depth + 1))

    if (error instanceof Error) {
      const withDetails = error as Error & {
        code?: unknown
        type?: unknown
        status?: unknown
        statusCode?: unknown
        cause?: unknown
        error?: unknown
        data?: unknown
        lastError?: unknown
        errors?: unknown
      }

      return (
        this.isNonConnectionApiCode(withDetails.code) ||
        this.isNonConnectionApiCode(withDetails.type) ||
        this.isNonConnectionApiStatus(withDetails.status) ||
        this.isNonConnectionApiStatus(withDetails.statusCode) ||
        this.isNonConnectionApiMessage(error.message) ||
        this.hasExplicitNonConnectionApiFailure(withDetails.data, depth + 1) ||
        this.hasExplicitNonConnectionApiFailure(withDetails.cause, depth + 1) ||
        this.hasExplicitNonConnectionApiFailure(withDetails.error, depth + 1) ||
        this.hasExplicitNonConnectionApiFailure(withDetails.lastError, depth + 1) ||
        this.hasExplicitNonConnectionApiFailure(withDetails.errors, depth + 1)
      )
    }

    const record = error
    return (
      this.isNonConnectionApiCode(record.code) ||
      this.isNonConnectionApiCode(record.type) ||
      this.isNonConnectionApiStatus(record.status) ||
      this.isNonConnectionApiStatus(record.statusCode) ||
      this.isNonConnectionApiMessage(record.message) ||
      this.hasExplicitNonConnectionApiFailure(record.data, depth + 1) ||
      this.hasExplicitNonConnectionApiFailure(record.error, depth + 1) ||
      this.hasExplicitNonConnectionApiFailure(record.cause, depth + 1) ||
      this.hasExplicitNonConnectionApiFailure(record.lastError, depth + 1) ||
      this.hasExplicitNonConnectionApiFailure(record.errors, depth + 1)
    )
  }

  private isNonConnectionApiCode(code: unknown): boolean {
    return isString(code) && NonConnectionApiErrorCodes.has(code.trim().toLowerCase())
  }

  private isTransientApiCode(code: unknown): boolean {
    return isString(code) && TransientApiErrorCodes.has(code.trim().toLowerCase())
  }

  private hasTransientApiFailure(error: unknown, depth = 0): boolean {
    if (depth > 5 || !isPresent(error)) return false

    if (isString(error)) return this.isTransientApiMessage(error)

    if (!isPlainObject(error)) return false

    if (isArray(error)) return error.some((item) => this.hasTransientApiFailure(item, depth + 1))

    if (error instanceof Error) {
      const withDetails = error as Error & {
        code?: unknown
        type?: unknown
        status?: unknown
        statusCode?: unknown
        cause?: unknown
        error?: unknown
        lastError?: unknown
        errors?: unknown
      }

      return (
        this.isTransientApiCode(withDetails.code) ||
        this.isTransientApiCode(withDetails.type) ||
        this.isTransientApiStatus(withDetails.status) ||
        this.isTransientApiStatus(withDetails.statusCode) ||
        this.isTransientApiMessage(error.message) ||
        this.hasTransientApiFailure(withDetails.cause, depth + 1) ||
        this.hasTransientApiFailure(withDetails.error, depth + 1) ||
        this.hasTransientApiFailure(withDetails.lastError, depth + 1) ||
        this.hasTransientApiFailure(withDetails.errors, depth + 1)
      )
    }

    const record = error
    return (
      this.isTransientApiCode(record.code) ||
      this.isTransientApiCode(record.type) ||
      this.isTransientApiStatus(record.status) ||
      this.isTransientApiStatus(record.statusCode) ||
      this.isTransientApiMessage(record.message) ||
      this.hasTransientApiFailure(record.error, depth + 1) ||
      this.hasTransientApiFailure(record.cause, depth + 1) ||
      this.hasTransientApiFailure(record.lastError, depth + 1) ||
      this.hasTransientApiFailure(record.errors, depth + 1)
    )
  }

  private isTransientApiStatus(status: unknown): boolean {
    if (!isNumber(status)) return false
    return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)
  }

  private isTransientApiMessage(message: unknown): boolean {
    if (!isString(message)) return false
    return /rate limit/i.test(message) || /too many requests/i.test(message)
  }

  // 5xx / 408 / 425 / 429 是网关、限流或瞬时超时，应交给连接层重试；4xx 其它视为终止以避免对鉴权或配额错误硬撞。
  private isNonConnectionApiStatus(status: unknown): boolean {
    if (!isNumber(status)) return false
    if (status >= 500 && status <= 599) return false
    if (status === 408 || status === 425 || status === 429) return false
    return status >= 400 && status <= 499
  }

  private isNonConnectionApiMessage(message: unknown): boolean {
    if (!isString(message)) return false

    return NonConnectionApiErrorMessageMatchers.some(({ pattern }) => pattern.test(message))
  }

  private isAbortError(error: AppError): boolean {
    if (error.code === 'EXECUTION_ABORTED') return true

    const normalized = error.message.toLowerCase()
    return normalized.includes('abort') || normalized.includes('cancelled')
  }

  private isRetryableEmptyPreOutputStream(error: AppError): boolean {
    if (error.code !== 'MODEL_EMPTY_RESPONSE') return false

    const source = error.context?.source
    return (
      source === 'stream-empty-before-first-chunk' || source === 'query-empty-before-first-chunk'
    )
  }

  private async waitForRetry(delayMs: number, abortSignal: AbortSignal): Promise<void> {
    if (abortSignal.aborted) {
      throw new AppError('EXECUTION_ABORTED', '运行被终止')
    }

    try {
      await TimerScope.sleep(delayMs, { signal: abortSignal })
    } catch {
      throw new AppError('EXECUTION_ABORTED', '运行被终止')
    }
  }
}

const sharedRetryPolicy = new RetryPolicy()

/**
 * 独立的“上下文超限”判定函数：供 agent loop 在不持有 RetryPolicy 实例时直接复用同一套分类规则，
 * 决定是否进入缺页兜底（应急压缩 + 重试一次）。
 */
function isContextOverflowError(error: unknown): boolean {
  return sharedRetryPolicy.isContextOverflowError(error)
}

function markContextOverflowReplayUnsafe(
  error: unknown,
  details: ContextOverflowReplayUnsafeDetails
): unknown {
  if (!isObject(error) && !isFunction(error)) return error

  Reflect.set(error as Record<PropertyKey, unknown>, ContextOverflowReplayUnsafeSymbol, details)
  return error
}

function isContextOverflowReplayUnsafe(error: unknown, depth = 0): boolean {
  if (depth > 5 || !isPresent(error)) return false
  if (!isObject(error) && !isFunction(error)) return false

  const record = error as Record<PropertyKey, unknown>
  const details = record[ContextOverflowReplayUnsafeSymbol]
  if (isContextOverflowReplayUnsafeDetails(details)) return true

  if (isContextOverflowReplayUnsafe(record.cause, depth + 1)) return true
  const nestedErrors = record.errors
  if (isArray(nestedErrors))
    return nestedErrors.some((nestedError) => isContextOverflowReplayUnsafe(nestedError, depth + 1))
  return false
}

function isContextOverflowReplayUnsafeDetails(
  value: unknown
): value is ContextOverflowReplayUnsafeDetails {
  if (!isPlainObject(value)) return false

  const record = value
  return isBoolean(record.hasVisibleOutput) && isBoolean(record.hasToolUse)
}

export {
  AiSdkMaxRetries,
  type ConnectionRetryOptions,
  isContextOverflowError,
  isContextOverflowReplayUnsafe,
  markContextOverflowReplayUnsafe,
  MaxConnectionRetryAttempts,
  RetryPolicy,
}
export { RetryPolicy as AgentConnectionRetryHelper }
