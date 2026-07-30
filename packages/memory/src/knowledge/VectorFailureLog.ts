import { isObject, isString } from '@velaros-ai/core'

export const VectorFailureLogWindowMs = 10 * 60_000

export interface VectorFailureLogger {
  warn(message: string, payload?: unknown): void
}

interface VectorFailureLogEntry {
  lastWarnedAt: number
  suppressedCount: number
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (isString(error)) return error
  if (error && isObject(error)) {
    const message = (error as { message?: unknown }).message
    return isString(message) ? message : String(message)
  }
  return String(error)
}

function normalizeVectorFailureKey(scope: string, message: string): string {
  if (/invalid_issuer|valid issuer|401 Unauthorized/i.test(message)) return `${scope}:embedding-auth-invalid-issuer`

  if (/authorization|api[_ -]?key|401/i.test(message)) return `${scope}:embedding-auth`

  return `${scope}:${message.slice(0, 500)}`
}

export interface VectorFailureMonitorOptions {
  windowMs?: number
  now?: () => number
}

/**
 * 单个 Knowledge 运行时拥有的向量故障抑制器。
 *
 * 故障窗口不再存放在模块级 Map 中，因此多个宿主、测试或租户之间不会共享告警状态。
 */
export class VectorFailureMonitor {
  private readonly entries = new Map<string, VectorFailureLogEntry>()
  private readonly windowMs: number
  private readonly now: () => number

  constructor(options: VectorFailureMonitorOptions = {}) {
    this.windowMs = options.windowMs ?? VectorFailureLogWindowMs
    this.now = options.now ?? Date.now
  }

  public warnOnce(
    log: VectorFailureLogger,
    scope: string,
    message: string,
    error: unknown,
    context: Record<string, unknown> = {}
  ): void {
    const errorMessage = getErrorMessage(error)
    const key = normalizeVectorFailureKey(scope, errorMessage)
    const now = this.now()
    const entry = this.entries.get(key)

    if (entry && now - entry.lastWarnedAt < this.windowMs) {
      entry.suppressedCount += 1
      return
    }

    this.entries.set(key, {
      lastWarnedAt: now,
      suppressedCount: 0,
    })

    log.warn(message, {
      ...context,
      error: errorMessage,
      suppressedSinceLastWarning: entry?.suppressedCount || undefined,
    })
  }

  public clear(): void {
    this.entries.clear()
  }
}
