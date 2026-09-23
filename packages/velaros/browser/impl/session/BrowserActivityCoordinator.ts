import type { TurnContextAppendBus, TurnContextSessionLedgersApi } from '@velaros-ai/context'
import { createTurnContextSessionLedgers } from '@velaros-ai/context'
import { isNumber, toNullable, toOptional } from '@velaros-ai/core'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { BrowserUserActivityEvent } from '../../types/browser.js'
import type { BrowserTurnContextDeltaSource } from '../../types/runtime.js'
import type { BrowserUserActivityItem } from '../../types/session.js'
import type {
  BrowserActivitySessionState,
  BrowserUserActivityWaitResult,
  BrowserUserActivityWaitState,
} from '../../types/session.js'
import { formatSummaryItem } from '../../utils/session'
import { BrowserTuning } from '../../utils/tuning'

/** 建用户活动协调器要的参数，都有缺省。 */
interface BrowserActivityCoordinatorOptions {
  /** 用户最近一次操作之后多少毫秒之内仍算「正在操作」；不给用 `BrowserTuning.session.userIdleWindowMs`。 */
  idleWindowMs?: number
  /** 取当前时间的口子，测试用；不给用 `Date.now`。 */
  now?: () => number
  /** 等待的口子，测试用；不给用计时器。 */
  sleep?: (ms: number) => Promise<void>
  /** agent 开始等 / 等完用户时的通知，宿主用来在界面上说明「正在让路」。 */
  onWaitStateChange?: (sessionId: string, state: BrowserUserActivityWaitState) => void
  /** 可见活动写入广播总线（每宿主一个实例，由宿主装配注入）；缺省则不通知 renderer。 */
  turnContextAppendHub?: TurnContextAppendBus
}

/**
 * 用户活动协调：用户刚动过页面时，让 agent 的动作等一等，别和人抢同一个页面。
 *
 * 记一条活动就把这条会话的「忙」窗口往后推；agent 的动作包在 `withModelAction` 里跑，自己不算成用户操作。
 * 等待期间把状态通知宿主，界面上能说明「正在让路」。
 *
 * 状态归会话：一个运行时一份，按 sessionId 分格。
 */
export interface BrowserActivityCoordinatorApi {
  /** 记一次用户操作：之后的一小段时间里 agent 要给用户让路。 */
  recordUserActivity(input: BrowserUserActivityEvent): void
  /** 环境回合上下文 source adapter：只捕获内存账本，peek 同步零 IO。 */
  createTurnContextSource(): BrowserTurnContextDeltaSource
  /** 等用户停手；等待期间把状态通知宿主，中止信号到了就立刻返回。 */
  waitForUserIdle(
    sessionId: string,
    abortSignal?: AbortSignal,
    onWaitStateChange?: BrowserActivityCoordinatorOptions['onWaitStateChange']
  ): Promise<BrowserUserActivityWaitResult>
  /** 把一次模型动作包起来跑：先等用户停手，跑的过程中不把自己算成用户操作。 */
  withModelAction<T>(sessionId: string, action: () => Promise<T>): Promise<T>
  /** 清掉这条会话的活动记录。 */
  clearSession(sessionId: string): void
  /** 清掉全部会话的状态；运行时收尾时调。 */
  clearAll(): void
}

class BrowserActivityCoordinator implements BrowserActivityCoordinatorApi {
  private static readonly BrowserActivityKindLabels: Record<
    BrowserUserActivityEvent['kind'],
    string
  > = {
    click: '点击',
    keyboard: '键盘',
    scroll: '滚动',
    input: '输入',
    navigation: '导航',
    dialog: '弹窗',
    download: '下载',
    permission: '权限',
    focus: '聚焦',
    unknown: '操作',
  }

  private readonly idleWindowMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly onWaitStateChange?: BrowserActivityCoordinatorOptions['onWaitStateChange']
  private readonly sessions = new Map<string, BrowserActivitySessionState>()
  private readonly turnContextLedgers: TurnContextSessionLedgersApi

  constructor(options: BrowserActivityCoordinatorOptions = {}) {
    this.idleWindowMs = options.idleWindowMs ?? BrowserTuning.session.userIdleWindowMs
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? ((ms) => TimerScope.sleep(ms))
    this.onWaitStateChange = options.onWaitStateChange
    this.turnContextLedgers = createTurnContextSessionLedgers('browser.manual-activity', {
      maxEntries: 60,
      appendHub: options.turnContextAppendHub,
    })
  }

  public recordUserActivity(input: BrowserUserActivityEvent): void {
    const sessionId = input.sessionId.trim()
    if (!sessionId) return

    const state = this.ensureSession(sessionId)
    if (state.modelActionDepth > 0) return

    const occurredAt = input.occurredAt ?? this.now()
    state.lastUserActivityAt = occurredAt
    const item: BrowserUserActivityItem = {
      kind: input.kind,
      url: toNullable(input.url),
      occurredAt,
      detail: toOptional(input.detail),
    }
    this.turnContextLedgers.append(sessionId, {
      occurredAt,
      label: BrowserActivityCoordinator.BrowserActivityKindLabels[input.kind],
      summaryText: formatSummaryItem(item).replace(/^- /, ''),
    })
  }

  /** 环境回合上下文 source adapter：只捕获内存账本，peek 同步零 IO。 */
  public createTurnContextSource(): BrowserTurnContextDeltaSource {
    const ledgers = this.turnContextLedgers
    return {
      id: 'browser.manual-activity',
      scopes: ['browser'],
      peekCached: (input) => ({
        ...ledgers.peek(input.sessionId, input),
        anchors: [],
      }),
    }
  }

  public async waitForUserIdle(
    sessionId: string,
    abortSignal?: AbortSignal,
    onWaitStateChange?: BrowserActivityCoordinatorOptions['onWaitStateChange']
  ): Promise<BrowserUserActivityWaitResult> {
    const startedAt = this.now()
    let waited = false
    let emittedWaiting = false

    while (true) {
      abortSignal?.throwIfAborted()
      const state = this.sessions.get(sessionId)
      const lastUserActivityAt = state?.lastUserActivityAt
      if (!isNumber(lastUserActivityAt)) break

      const idleForMs = this.now() - lastUserActivityAt
      const remainingMs = this.idleWindowMs - idleForMs
      if (remainingMs <= 0) break

      if (!emittedWaiting) {
        emittedWaiting = true
        this.emitWaitState(sessionId, 'waiting', onWaitStateChange)
      }
      waited = true
      await this.sleep(Math.max(1, remainingMs))
    }

    if (emittedWaiting) {
      this.emitWaitState(sessionId, 'idle', onWaitStateChange)
    }

    return {
      waited,
      waitedMs: Math.max(0, this.now() - startedAt),
    }
  }

  public async withModelAction<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const state = this.ensureSession(sessionId)
    state.modelActionDepth += 1

    try {
      return await action()
    } finally {
      state.modelActionDepth = Math.max(0, state.modelActionDepth - 1)
    }
  }

  public clearSession(sessionId: string): void {
    this.sessions.delete(sessionId)
    this.turnContextLedgers.clearSession(sessionId)
  }

  public clearAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.turnContextLedgers.clearSession(sessionId)
    }
    this.sessions.clear()
  }

  private ensureSession(sessionId: string): BrowserActivitySessionState {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const state: BrowserActivitySessionState = {
      lastUserActivityAt: null,
      modelActionDepth: 0,
    }
    this.sessions.set(sessionId, state)
    return state
  }

  private emitWaitState(
    sessionId: string,
    state: BrowserUserActivityWaitState,
    onWaitStateChange?: BrowserActivityCoordinatorOptions['onWaitStateChange']
  ): void {
    this.onWaitStateChange?.(sessionId, state)
    onWaitStateChange?.(sessionId, state)
  }
}

export { BrowserActivityCoordinator }
export type { BrowserActivityCoordinatorOptions }
export type {
  BrowserUserActivityWaitResult,
  BrowserUserActivityWaitState,
} from '../../types/session.js'
