import type { VectorFailureLogger } from '../../types/host.js'
import { getErrorMessage, normalizeVectorFailureKey } from '../../utils/embedding.js'
import { KnowledgeTuning } from '../../utils/tuning.js'

/** 向量故障抑制器的告警窗口（毫秒），对外公布给宿主对齐告警预期。 */
export const VectorFailureLogWindowMs: number = KnowledgeTuning.vectorFailure.windowMs

/** 造一个向量故障抑制器时可以改的东西。 */
export interface VectorFailureMonitorOptions {
  /** 同一类故障多久之内只告警一次（毫秒）；不传就用 `VectorFailureLogWindowMs`。 */
  windowMs?: number
  /** 取当前时刻的函数，测试可以注入一个假时钟。 */
  now?: () => number
}

/** 抑制窗口里记着的一条故障：上次告警时刻与这之后被压掉多少次。 */
export interface VectorFailureMonitorEntry {
  /** 上一次真的告警是什么时候。 */
  lastWarnedAt: number
  /** 从那以后被压掉了多少次。 */
  suppressedCount: number
}

/**
 * 单个知识库运行时独占的向量故障抑制器。
 *
 * 故障窗口住在实例上，不在模块级，所以多个宿主、多次测试或多个租户之间不共享告警状态。
 */
export interface VectorFailureMonitorApi {
  /** 同一类故障在窗口内只告警一次，被压掉的次数随下一次告警一起报出去。 */
  warnOnce(
    log: VectorFailureLogger,
    scope: string,
    message: string,
    error: unknown,
    context?: Record<string, unknown>
  ): void
  /** 清空抑制窗口，下一次故障立刻告警。 */
  clear(): void
}

/** 见 {@link VectorFailureMonitorApi}。 */
export class VectorFailureMonitor implements VectorFailureMonitorApi {
  private readonly entries = new Map<string, VectorFailureMonitorEntry>()
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
