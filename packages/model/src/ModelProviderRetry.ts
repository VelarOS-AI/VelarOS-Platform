const DefaultInitialDelayMs = 2_000
const DefaultMaxDelayMs = 30_000

export interface ModelProviderRetryOptions {
  readonly retryIndex: number
  readonly initialDelayMs?: number
  readonly maxDelayMs?: number
  readonly now?: number
}

export interface ModelProviderRetryDecision {
  readonly kind: 'network' | 'rate-limit' | 'provider'
  readonly delayMs: number
  readonly message: string
}

/** Classify only failures that are safe to treat as transient transport/provider faults. */
export function planModelProviderRetry(
  error: unknown,
  options: ModelProviderRetryOptions,
): ModelProviderRetryDecision | null {
  const facts = collectErrorFacts(error)
  const lower = facts.messages.join(' ').toLowerCase()
  if (isPermanentFailure(lower) || facts.codes.has('ABORT_ERR')) return null

  const rateLimited = facts.statuses.has(429)
    || includesAny(lower, ['rate limit', 'too many requests', 'resource exhausted'])
  const network = [...facts.codes].some((code) => NetworkErrorCodes.has(code))
    || includesAny(lower, [
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
  const provider = [...facts.statuses].some((status) => (
    status === 408 || status === 409 || status === 425 || status >= 500
  )) || facts.retryable
    || includesAny(lower, ['overloaded', 'provider unavailable', 'service unavailable'])
  if (!rateLimited && !network && !provider) return null

  const initialDelayMs = positive(options.initialDelayMs, DefaultInitialDelayMs)
  const maxDelayMs = Math.max(initialDelayMs, positive(options.maxDelayMs, DefaultMaxDelayMs))
  const retryAfterMs = retryAfter(facts.headers, options.now ?? Date.now())
  const exponential = initialDelayMs * (2 ** Math.max(0, options.retryIndex - 1))
  const delayMs = Math.min(maxDelayMs, Math.max(0, retryAfterMs ?? exponential))
  const kind = rateLimited ? 'rate-limit' : network ? 'network' : 'provider'
  return {
    kind,
    delayMs,
    message: retryMessage(kind, facts.messages[0]),
  }
}

export async function waitForModelRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, delayMs))
    const abort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(abortError(signal))
    }
    function done(): void {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

interface ErrorFacts {
  readonly statuses: Set<number>
  readonly codes: Set<string>
  readonly messages: string[]
  readonly headers: Record<string, string>
  retryable: boolean
}

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

function collectErrorFacts(root: unknown): ErrorFacts {
  const facts: ErrorFacts = {
    statuses: new Set(),
    codes: new Set(),
    messages: [],
    headers: {},
    retryable: false,
  }
  const queue: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: root, depth: 0 }]
  const seen = new Set<unknown>()
  while (queue.length > 0) {
    const item = queue.shift()!
    if (item.depth > 4 || item.value === null || item.value === undefined || seen.has(item.value)) continue
    seen.add(item.value)
    if (typeof item.value === 'string') {
      pushMessage(facts.messages, item.value)
      continue
    }
    if (typeof item.value !== 'object') continue
    const record = item.value as Record<string, unknown>
    for (const key of ['status', 'statusCode']) {
      const status = Number(record[key])
      if (Number.isInteger(status) && status >= 100 && status <= 599) facts.statuses.add(status)
    }
    if (typeof record.code === 'string') facts.codes.add(record.code.toUpperCase())
    if (record.isRetryable === true || record.retryable === true) facts.retryable = true
    if (typeof record.message === 'string') pushMessage(facts.messages, record.message)
    mergeHeaders(facts.headers, record.headers)
    mergeHeaders(facts.headers, record.responseHeaders)
    for (const key of ['cause', 'data', 'error', 'lastError', 'response']) {
      if (record[key] !== undefined) queue.push({ value: record[key], depth: item.depth + 1 })
    }
  }
  if (facts.messages.length === 0) pushMessage(facts.messages, String(root))
  return facts
}

function mergeHeaders(target: Record<string, string>, input: unknown): void {
  if (!input || typeof input !== 'object') return
  if (typeof (input as { get?: unknown }).get === 'function') {
    for (const name of ['retry-after-ms', 'retry-after']) {
      const value = (input as { get(name: string): unknown }).get(name)
      if (typeof value === 'string') target[name] = value
    }
    return
  }
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === 'string') target[name.toLowerCase()] = value
  }
}

function retryAfter(headers: Record<string, string>, now: number): number | null {
  const milliseconds = Number.parseFloat(headers['retry-after-ms'] ?? '')
  if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds
  const value = headers['retry-after']
  if (!value) return null
  const seconds = Number.parseFloat(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
  const at = Date.parse(value)
  return Number.isFinite(at) && at > now ? at - now : null
}

function isPermanentFailure(message: string): boolean {
  return includesAny(message, [
    'authentication',
    'context length',
    'context window',
    'invalid api key',
    'invalid request',
    'model not found',
    'permission denied',
    'unauthorized',
  ])
}

function retryMessage(kind: ModelProviderRetryDecision['kind'], message: string | undefined): string {
  const compact = message?.replace(/\s+/gu, ' ').trim().slice(0, 180)
  if (compact) return compact
  if (kind === 'rate-limit') return 'Provider rate limit reached'
  if (kind === 'network') return 'Provider connection was interrupted'
  return 'Provider is temporarily unavailable'
}

function pushMessage(messages: string[], value: string): void {
  const compact = value.replace(/\s+/gu, ' ').trim()
  if (compact && !messages.includes(compact)) messages.push(compact)
}

function includesAny(value: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate))
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}
