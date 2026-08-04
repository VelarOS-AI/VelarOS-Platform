import {
  type TurnContextAppendHub,
  TurnContextSessionLedgers,
} from '@velaros-ai/agent/run-context'
import { isNumber,toNullable, toOptional } from '@velaros-ai/core'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type {
  BrowserTurnContextDeltaSource,
  BrowserUserActivityEvent,
  BrowserUserActivityItem,
} from './types.js'

type BrowserUserActivityWaitState = 'waiting' | 'idle'

interface BrowserActivityCoordinatorOptions {
  idleWindowMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onWaitStateChange?: (sessionId: string, state: BrowserUserActivityWaitState) => void
  /** 可见活动写入广播总线（每宿主一个实例，由宿主装配注入）；缺省则不通知 renderer。 */
  turnContextAppendHub?: TurnContextAppendHub
}

interface BrowserUserActivityWaitResult {
  waited: boolean
  waitedMs: number
}

interface BrowserActivitySessionState {
  lastUserActivityAt: Nullable<number>
  modelActionDepth: number
}

const DefaultIdleWindowMs = 1_200

const BrowserActivityKindLabels: Record<BrowserUserActivityEvent['kind'], string> = {
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

class BrowserActivityCoordinator {
  private readonly idleWindowMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly onWaitStateChange?: BrowserActivityCoordinatorOptions['onWaitStateChange']
  private readonly sessions = new Map<string, BrowserActivitySessionState>()
  private readonly turnContextLedgers: TurnContextSessionLedgers

  constructor(options: BrowserActivityCoordinatorOptions = {}) {
    this.idleWindowMs = options.idleWindowMs ?? DefaultIdleWindowMs
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? ((ms) => TimerScope.sleep(ms))
    this.onWaitStateChange = options.onWaitStateChange
    this.turnContextLedgers = new TurnContextSessionLedgers('browser.manual-activity', {
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
      label: BrowserActivityKindLabels[input.kind],
      summaryText: this.formatSummaryItem(item).replace(/^- /, ''),
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

  private formatSummaryItem(item: BrowserUserActivityItem): string {
    const suffix = item.url ? `（${item.url}）` : ''
    const detail = item.detail ? `：${item.detail}` : ''

    switch (item.kind) {
      case 'click':
        return `- 用户在浏览器中点击页面${suffix}${detail}。`
      case 'keyboard':
        return `- 用户在浏览器中使用键盘${suffix}${detail}。`
      case 'scroll':
        return `- 用户在浏览器中滚动页面${suffix}${detail}。`
      case 'input':
        return `- 用户在浏览器中输入内容，文本未记录${suffix}${detail}。`
      case 'navigation':
        return `- 用户在浏览器中导航到 ${item.url ?? '新页面'}${detail}。`
      case 'dialog':
        return `- 用户触发或处理了浏览器弹窗${suffix}${detail}。`
      case 'download':
        return `- 用户触发或处理了浏览器下载${suffix}${detail}。`
      case 'permission':
        return `- 用户触发或处理了浏览器权限请求${suffix}${detail}。`
      case 'focus':
        return `- 用户聚焦了浏览器页面${suffix}${detail}。`
      case 'unknown':
        return `- 用户操作了浏览器页面${suffix}${detail}。`
    }
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
export type {
  BrowserActivityCoordinatorOptions,
  BrowserUserActivityWaitResult,
  BrowserUserActivityWaitState,
}
