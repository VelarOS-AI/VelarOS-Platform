import {
  isEmpty,
  isFiniteNumber,
  isFunction,
  isObject,
  isPresent,
  isString,
  isTrue,
} from '@velaros-ai/core'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { ModelProviderRetryDecision, ModelProviderRetryOptions } from '../types/model'
import type { ModelRetryErrorFacts } from '../types/requests'

import { ModelTuning } from './tuning'

/** 判成网络层瞬时故障的 errno 名单；这是规则数据，改名单和改规则一起审。 */
const NetworkErrorCodes = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

/** 一看就不该重试的失败：鉴权、入参、上下文超长、模型不存在。 */
const PermanentFailureMarkers = [
  'authentication',
  'context length',
  'context window',
  'invalid api key',
  'invalid request',
  'model not found',
  'permission denied',
  'unauthorized',
]

/** 只把能安全当成瞬时传输/服务端故障的失败判成可重试；判不出来就返回 null，交给调用方失败。 */
export function planProviderRetry(
  error: unknown,
  options: ModelProviderRetryOptions
): Nullable<ModelProviderRetryDecision> {
  const facts = collectErrorFacts(error)
  const lower = facts.messages.join(' ').toLowerCase()
  if (
    isPermanentFailure(lower) ||
    facts.codes.has('ABORT_ERR') ||
    [...facts.statuses].some(
      (status) => status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status)
    )
  )
    return null

  const rateLimited =
    facts.statuses.has(429) ||
    includesAny(lower, ['rate limit', 'too many requests', 'resource exhausted'])
  const network =
    [...facts.codes].some((code) => NetworkErrorCodes.has(code)) ||
    includesAny(lower, [
      'connection reset',
      'connection closed',
      'connection refused',
      'fetch failed',
      'network error',
      'socket hang up',
      'timed out',
      'timeout',
      'unexpected eof',
    ])
  const provider =
    [...facts.statuses].some(
      (status) => status === 408 || status === 409 || status === 425 || status >= 500
    ) ||
    facts.retryable ||
    includesAny(lower, ['overloaded', 'provider unavailable', 'service unavailable'])
  if (!rateLimited && !network && !provider) return null

  const initialDelayMs = positive(options.initialDelayMs, ModelTuning.retry.initialDelayMs)
  const maxDelayMs = Math.max(
    initialDelayMs,
    positive(options.maxDelayMs, ModelTuning.retry.maxDelayMs)
  )
  const retryAfterMs = retryAfter(facts.headers, options.now ?? Date.now())
  const exponential = initialDelayMs * 2 ** Math.max(0, options.retryIndex - 1)
  const delayMs = Math.min(maxDelayMs, Math.max(0, retryAfterMs ?? exponential))
  const kind = rateLimited ? 'rate-limit' : network ? 'network' : 'provider'
  return {
    kind,
    delayMs,
    message: retryMessage(kind, facts.messages[0]),
  }
}

/** SDK 的流失败可能是嵌套数据而非 Error；只取错误文案，不把请求对象串进诊断。 */
export function providerErrorMessage(error: unknown): string {
  return collectErrorFacts(error).messages[0] ?? '供应商请求失败'
}

/** 等一次退避；等待期间被取消就把取消原因抛出去。 */
export async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError(signal)
  await TimerScope.sleep(delayMs, { label: 'ModelProviderRetry.wait', signal })
}

/** 沿 cause / data / error / lastError / response 逐层收集状态码、errno、文案与响应头。 */
function collectErrorFacts(root: unknown): ModelRetryErrorFacts {
  const facts: ModelRetryErrorFacts = {
    statuses: new Set(),
    codes: new Set(),
    messages: [],
    headers: {},
    retryable: false,
  }
  const queue: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: root, depth: 0 },
  ]
  const seen = new Set<unknown>()
  while (!isEmpty(queue)) {
    const item = queue.shift()!
    // 最多追四层：再深就不是这次失败的事实了，还会把循环引用拖成长链。
    if (item.depth > 4 || !isPresent(item.value) || seen.has(item.value)) continue
    seen.add(item.value)
    if (isString(item.value)) {
      pushMessage(facts.messages, item.value)
      continue
    }
    if (!isObject(item.value)) continue
    const record = item.value
    for (const key of ['status', 'statusCode']) {
      const status = Number(Reflect.get(record, key))
      if (Number.isInteger(status) && status >= 100 && status <= 599) facts.statuses.add(status)
    }
    const code = Reflect.get(record, 'code')
    if (isString(code)) facts.codes.add(code.toUpperCase())
    if (isTrue(Reflect.get(record, 'isRetryable')) || isTrue(Reflect.get(record, 'retryable')))
      facts.retryable = true
    const message = Reflect.get(record, 'message')
    if (isString(message)) pushMessage(facts.messages, message)
    mergeHeaders(facts.headers, Reflect.get(record, 'headers'))
    mergeHeaders(facts.headers, Reflect.get(record, 'responseHeaders'))
    for (const key of ['cause', 'data', 'error', 'lastError', 'response']) {
      const value = Reflect.get(record, key)
      if (isPresent(value)) queue.push({ value, depth: item.depth + 1 })
    }
  }
  if (isEmpty(facts.messages)) pushMessage(facts.messages, '供应商请求失败')
  return facts
}

/** 把 Headers 实例或普通对象里的两个 retry-after 头收进同一张表。 */
function mergeHeaders(target: Record<string, string>, input: unknown): void {
  if (!isObject(input)) return
  const get = Reflect.get(input, 'get')
  if (isFunction(get)) {
    for (const name of ['retry-after-ms', 'retry-after']) {
      const value = Reflect.apply(get, input, [name])
      if (isString(value)) target[name] = value
    }
    return
  }
  for (const [name, value] of Object.entries(input)) {
    if (isString(value)) target[name.toLowerCase()] = value
  }
}

/** 服务端给的 retry-after：毫秒、秒、绝对时间三种写法都认。 */
function retryAfter(headers: Record<string, string>, now: number): Nullable<number> {
  const milliseconds = Number.parseFloat(headers['retry-after-ms'] ?? '')
  if (isFiniteNumber(milliseconds) && milliseconds >= 0) return milliseconds
  const value = headers['retry-after']
  if (!value) return null
  const seconds = Number.parseFloat(value)
  if (isFiniteNumber(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
  const at = Date.parse(value)
  return isFiniteNumber(at) && at > now ? at - now : null
}

/** 这条失败文案是不是命中了「重试也没用」的名单。 */
function isPermanentFailure(message: string): boolean {
  return includesAny(message, PermanentFailureMarkers)
}

/** 给用户看的重试原因：优先用服务端原话，没有就按类别给一句中文兜底。 */
function retryMessage(kind: ModelProviderRetryDecision['kind'], message?: string): string {
  const compact = message?.replace(/\s+/gu, ' ').trim().slice(0, ModelTuning.retry.messageChars)
  if (compact) return compact
  if (kind === 'rate-limit') return '服务商限流，请稍后重试'
  if (kind === 'network') return '与服务商的连接被中断'
  return '服务商暂时不可用'
}

/** 把一条失败文案压成一行并去重后收进表。 */
function pushMessage(messages: string[], value: string): void {
  const compact = value.replace(/\s+/gu, ' ').trim()
  if (compact && !messages.includes(compact)) messages.push(compact)
}

/** 文本里有没有出现名单里的任意一条。 */
function includesAny(value: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate))
}

/** 取一个正数，拿不到就用兜底值。 */
function positive(value: LooseOptional<number>, fallback: number): number {
  return isFiniteNumber(value) && value > 0 ? value : fallback
}

/** 取消原因本身是 Error 就原样抛，否则造一个标准的 AbortError。 */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('操作已取消', 'AbortError')
}
