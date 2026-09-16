import { isArray, isBoolean, isFunction,isNumber, isObject, isPlainObject,isPresent, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import type { ConnectionRetryBlockReason,ConnectionRetryOptions, ContextOverflowReplayUnsafeDetails } from '../../types/loop.js'
import {
  isNonConnectionApiCode,
  isNonConnectionApiMessage,
  isNonConnectionApiStatus,
  isRetryableEmptyPreOutputStream,
  isRetryAbortError,
  isTransientApiCode,
  isTransientApiMessage,
  isTransientApiStatus,
  readRetryAfterDelayMsFromRecord,
  resolveReplaySafetyBlockReason,
  waitForRetryDelay,
} from '../../utils/loop/model-retry-classification'

/** 第一次重试的基础延迟。 */
const ConnectionRetryBaseDelayMs = 3_000
/** 退避封顶。超过这条线后不再翻倍，给瞬态故障留足缓冲又不让用户傻等。 */
const ConnectionRetryMaxDelayMs = 30_000
/** Jitter 上限（±）。多 worker 同时撞到 endpoint 时分散唤醒，避免羊群效应。 */
const ConnectionRetryJitterMs = 750
const ConnectionRetryHeaderMaxDelayMs = 2_147_483_647
const MaxConnectionRetryAttempts = 5
const AiSdkMaxRetries = 0

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

const ContextOverflowReplayUnsafeSymbol = Symbol.for('velaros.contextOverflowReplayUnsafe')

/**
 * 模型请求的重试判官：一次 provider 请求失败之后，「还能不能原样再发一遍」由它说了算。
 *
 * 谁持有：`StreamTurn` 从构造参数拿一份（`TurnRunner` 建的那个），`QueryTurn` 自己 new 一份；
 * 本身无状态，重试计数活在 `runWithConnectionRetry` 的调用栈里，不跨轮累计。
 * 什么时候调：整个「开流 + 消费完 fullStream」被 `runWithConnectionRetry` 包住，一轮一次；
 * 失败后它当场判、当场退避、当场重发，对上层就是一次调用。
 *
 * 三条不许破的线：
 *  - **有可见副作用就不重试**：本轮已经推过文本或派过工具调用，重放会让 UI 出现重复增量、
 *    让工具二次执行；此时原样抛给上层，由续写恢复接手。
 *  - **只重试连接类错误**：鉴权、计费、配额、上下文超限重发同样的请求必然再失败，直接抛。
 *  - **中断优先于重试**：等退避期间 abortSignal 一断立刻抛 `EXECUTION_ABORTED`，不再发下一次。
 */
export interface RetryPolicyApi {
  /**
   * 包住一次模型请求：成功即返回；失败则判是否可重试，可以就按退避等待后重发，不可以就把原错误抛出。
   * 退避时长优先听 provider 的 `retry-after` 响应头，否则指数退避加抖动；等待期间响应中断信号。
   * 传了 `options.policy`（宿主自带重试策略）时改由它决定要不要再来一次、等多久，本类只做安全前置判定。
   */
  runWithConnectionRetry<T>(operation: () => Promise<T>, options: ConnectionRetryOptions): Promise<T>
  /** 单独问一次「这个错现在能重试吗」：中断、已出可见输出/工具调用、次数用尽、非连接类错误都返回 false。 */
  shouldRetryConnectionError(
    error: unknown,
    attempt: number,
    options: {
      /** 本轮的中断信号；已中断一律不许重试。 */
      abortSignal: AbortSignal
      /** 本轮是否已经把文本推给了界面；推过就不能重放。 */
      hasVisibleOutput?: () => boolean
      /** 本轮是否已经接下过工具调用；接过就可能已有副作用，不能重放。 */
      hasToolUse?: () => boolean
    }
  ): boolean
  /**
   * 判是不是「上下文超限」这一类错（缺页信号）。与连接重试相互独立：这类错重发同样的历史只会再炸，
   * 得先沿降级阶梯腾出空间再重来，两个 loop 面的缺页兜底都以它为判据。
   */
  isContextOverflowError(error: unknown, depth?: number): boolean
  /** 判是不是值得重发的瞬态连接错（网络、超时、限流、半开流被判死、开流前空响应等）。 */
  isTransientConnectionError(error: AppError): boolean
  /**
   * 把错误连同 cause / errors / lastError 一层层摊平成一串可匹配的文本，用于关键词归类。
   * 只读不改，深度有限；给的不是错误对象时按字符串处理。
   */
  buildErrorFingerprint(error: unknown, depth?: number): string
  /**
   * 下一次重试等多久（毫秒）。provider 给了 `retry-after` / `retry-after-ms` 就听它（有上限钳制），
   * 否则按 base × 2^(attempt-1) 指数退避、封顶后再叠 ±jitter 打散并发。
   */
  getRetryDelayMs(attempt: number, error?: unknown): number
}

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
class RetryPolicy implements RetryPolicyApi {
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
        const blockReason = options.policy
          ? resolveReplaySafetyBlockReason(error, options)
          : this.getConnectionRetryBlockReason(error, attempt, options)
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
        const decision = options.policy
          ? await options.policy.onFailure({ error, attempt, abortSignal: options.abortSignal })
          : { delayMs: this.getRetryDelayMs(attempt, error) }
        if (!decision) throw error
        if (!Number.isFinite(decision.delayMs) || decision.delayMs < 0) {
          throw new AppError('VALIDATION', '重试策略给出的 delayMs 不合法：必须是有限且非负的毫秒数。这是注入的重试策略自己的缺陷，不是模型供应方的行为。')
        }
        const delayMs = decision.delayMs
        options.onRetry?.(appError, attempt)
        this.log.warn('transient model connection issue, retrying', {
          phase: options.phase,
          turn: options.turn || undefined,
          attempt,
          delayMs,
          code: appError.code,
          message: appError.message,
        })
        await waitForRetryDelay(delayMs, options.abortSignal)
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
    if (isRetryAbortError(appError)) return 'abort_error'

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
    if (isRetryableEmptyPreOutputStream(error)) return true

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
        readRetryAfterDelayMsFromRecord(record, ConnectionRetryHeaderMaxDelayMs) ??
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
      readRetryAfterDelayMsFromRecord(record, ConnectionRetryHeaderMaxDelayMs) ??
      this.readRetryAfterDelayMs(record.cause, depth + 1) ??
      this.readRetryAfterDelayMs(record.error, depth + 1) ??
      this.readRetryAfterDelayMs(record.lastError, depth + 1) ??
      this.readRetryAfterDelayMs(record.errors, depth + 1)
    )
  }

  private hasExplicitNonConnectionApiFailure(error: unknown, depth = 0): boolean {
    if (depth > 5 || !isPresent(error)) return false

    if (isString(error)) return isNonConnectionApiMessage(error)

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
        isNonConnectionApiCode(withDetails.code) ||
        isNonConnectionApiCode(withDetails.type) ||
        isNonConnectionApiStatus(withDetails.status) ||
        isNonConnectionApiStatus(withDetails.statusCode) ||
        isNonConnectionApiMessage(error.message) ||
        this.hasExplicitNonConnectionApiFailure(withDetails.data, depth + 1) ||
        this.hasExplicitNonConnectionApiFailure(withDetails.cause, depth + 1) ||
        this.hasExplicitNonConnectionApiFailure(withDetails.error, depth + 1) ||
        this.hasExplicitNonConnectionApiFailure(withDetails.lastError, depth + 1) ||
        this.hasExplicitNonConnectionApiFailure(withDetails.errors, depth + 1)
      )
    }

    const record = error
    return (
      isNonConnectionApiCode(record.code) ||
      isNonConnectionApiCode(record.type) ||
      isNonConnectionApiStatus(record.status) ||
      isNonConnectionApiStatus(record.statusCode) ||
      isNonConnectionApiMessage(record.message) ||
      this.hasExplicitNonConnectionApiFailure(record.data, depth + 1) ||
      this.hasExplicitNonConnectionApiFailure(record.error, depth + 1) ||
      this.hasExplicitNonConnectionApiFailure(record.cause, depth + 1) ||
      this.hasExplicitNonConnectionApiFailure(record.lastError, depth + 1) ||
      this.hasExplicitNonConnectionApiFailure(record.errors, depth + 1)
    )
  }

  private hasTransientApiFailure(error: unknown, depth = 0): boolean {
    if (depth > 5 || !isPresent(error)) return false

    if (isString(error)) return isTransientApiMessage(error)

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
        isTransientApiCode(withDetails.code) ||
        isTransientApiCode(withDetails.type) ||
        isTransientApiStatus(withDetails.status) ||
        isTransientApiStatus(withDetails.statusCode) ||
        isTransientApiMessage(error.message) ||
        this.hasTransientApiFailure(withDetails.cause, depth + 1) ||
        this.hasTransientApiFailure(withDetails.error, depth + 1) ||
        this.hasTransientApiFailure(withDetails.lastError, depth + 1) ||
        this.hasTransientApiFailure(withDetails.errors, depth + 1)
      )
    }

    const record = error
    return (
      isTransientApiCode(record.code) ||
      isTransientApiCode(record.type) ||
      isTransientApiStatus(record.status) ||
      isTransientApiStatus(record.statusCode) ||
      isTransientApiMessage(record.message) ||
      this.hasTransientApiFailure(record.error, depth + 1) ||
      this.hasTransientApiFailure(record.cause, depth + 1) ||
      this.hasTransientApiFailure(record.lastError, depth + 1) ||
      this.hasTransientApiFailure(record.errors, depth + 1)
    )
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

export { AiSdkMaxRetries, isContextOverflowError, isContextOverflowReplayUnsafe, markContextOverflowReplayUnsafe, MaxConnectionRetryAttempts, RetryPolicy }
export { RetryPolicy as AgentConnectionRetryHelper }
