import { isPlainObject, isString, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Log } from '@velaros-ai/core/logger'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { BrowserProtocolLimits } from '../../contract/constants.js'
import type { BrowserProtocolChannel } from '../../contract/requires.js'
import type { BrowserProtocolEvents, CdpEventsInput, CdpSendInput } from '../../types/browser.js'
import type {
  BrowserProtocolPausedRequest,
  BrowserProtocolSessionState,
} from '../../types/session.js'
import { pausedRequestUrl, protocolMethodMatches } from '../../utils/cdp/protocol.js'
import { BrowserTuning } from '../../utils/tuning'

/**
 * 模型自己那条 CDP 会话（`velaros:cdp`）在运行时这一侧的管家：每个浏览器会话最多一条，第一次用到时经页面驱动的
 * `openProtocolChannel` 连上，之后跨程序保留，reset、会话关闭、外部浏览器切标签页时断开。
 *
 * - 事件按到达顺序记进缓冲，序号全进程只增不减（断开重连之后游标照样有效）；缓冲只为守住内存有上限，挤掉的条数记下来。
 * - 被模型的 Fetch 拦下的请求记在账上，模型发放行类命令就销账；程序跑完就没人应答了，所以超过上限没人放行的由这里替它放行，
 *   并在事件里记一条 `Velar.requestAutoContinued`——不兜底，页面会一直卡着。
 * - 通道自己断了（页面关了、调试器被拿走）就忘掉这条会话，下次用到时重连。
 */
export interface BrowserProtocolSessionsApi {
  /** 在这个浏览器会话的模型 CDP 会话上发一条命令；还没有会话（或已经断了）就先经 open 连一条。 */
  send(
    sessionId: string,
    open: () => Promise<BrowserProtocolChannel>,
    command: CdpSendInput
  ): Promise<unknown>
  /** 读模型 CDP 会话收到的事件：after 之后、匹配 method 的；还没有会话就先连一条（事件从连上起记）。 */
  read(
    sessionId: string,
    open: () => Promise<BrowserProtocolChannel>,
    query: CdpEventsInput
  ): Promise<BrowserProtocolEvents>
  /** 断开这个浏览器会话的模型 CDP 会话；没有就什么都不做。 */
  close(sessionId: string): Promise<void>
  /** 断开全部会话、停掉兜底的计时器。 */
  dispose(): Promise<void>
}

export class BrowserProtocolSessions implements BrowserProtocolSessionsApi {
  /** 放行类命令：发出去之后，对应的被拦下的请求就不归兜底管了。 */
  private static readonly ReleasingFetchMethods = new Set([
    'Fetch.continueRequest',
    'Fetch.fulfillRequest',
    'Fetch.failRequest',
    'Fetch.continueWithAuth',
    'Fetch.continueResponse',
  ])

  private readonly log = Log.tag('BrowserProtocolSessions')
  private readonly sessions = new Map<string, BrowserProtocolSessionState>()
  private readonly generations = new Map<string, symbol>()
  private readonly opening = new Map<string, Promise<BrowserProtocolSessionState>>()
  private readonly timers = new TimerScope({ name: 'BrowserProtocolSessions' })
  private sweeper: Nullable<TimerLease> = null
  /** 全进程最后一个事件的序号。 */
  private lastSeq = 0

  public async send(
    sessionId: string,
    open: () => Promise<BrowserProtocolChannel>,
    command: CdpSendInput
  ): Promise<unknown> {
    const state = await this.ensure(sessionId, open)
    const result = await state.channel.send(command.method, command.params, command.session)
    const requestId = command.params?.requestId
    if (BrowserProtocolSessions.ReleasingFetchMethods.has(command.method) && isString(requestId))
      state.paused.delete(requestId)
    // 关掉 Fetch 时 Chromium 把这条会话拦着的请求一并放行：账上这一会话的都销掉。
    if (command.method === 'Fetch.disable') {
      for (const [id, paused] of state.paused)
        if (paused.session === command.session) state.paused.delete(id)
    }
    return result
  }

  public async read(
    sessionId: string,
    open: () => Promise<BrowserProtocolChannel>,
    query: CdpEventsInput
  ): Promise<BrowserProtocolEvents> {
    const state = await this.ensure(sessionId, open)
    const after = query.after ?? 0
    return {
      events: state.events.filter(
        (event) => event.seq > after && protocolMethodMatches(event.method, query.method)
      ),
      last: this.lastSeq,
      dropped: state.dropped,
    }
  }

  public async close(sessionId: string): Promise<void> {
    this.generations.delete(sessionId)
    this.opening.delete(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state) return
    this.forget(sessionId, state)
    await this.timers.withTimeout(
      BrowserTuning.protocol.closeTimeoutMs,
      () => state.channel.close(),
      { label: 'browser.protocol.close' }
    )
  }

  public async dispose(): Promise<void> {
    const sessionIds = new Set([...this.sessions.keys(), ...this.opening.keys()])
    try {
      await Promise.all([...sessionIds].map((sessionId) => this.close(sessionId)))
    } finally {
      if (this.sessions.size === 0) {
        this.sweeper?.cancel()
        this.sweeper = null
      }
    }
  }

  /** 这个浏览器会话的记账；没有就连一条（同一时刻只连一次）。 */
  private async ensure(
    sessionId: string,
    open: () => Promise<BrowserProtocolChannel>
  ): Promise<BrowserProtocolSessionState> {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const pending = this.opening.get(sessionId)
    if (pending) return pending
    const generation = Symbol(sessionId)
    this.generations.set(sessionId, generation)
    const opened = this.open(sessionId, open, generation).finally(() => {
      if (this.opening.get(sessionId) === opened) this.opening.delete(sessionId)
    })
    this.opening.set(sessionId, opened)
    return opened
  }

  private async open(
    sessionId: string,
    open: () => Promise<BrowserProtocolChannel>,
    generation: symbol
  ): Promise<BrowserProtocolSessionState> {
    const channel = await open()
    if (this.generations.get(sessionId) !== generation) {
      void this.timers
        .withTimeout(BrowserTuning.protocol.closeTimeoutMs, () => channel.close(), {
          label: 'browser.protocol.retired.close',
        })
        .catch((error: unknown) => {
          this.log.warn('retired protocol channel cleanup failed', { sessionId, error })
        })
      throw new AppError('CLOSED', '浏览器会话已关闭，迟到的协议连接已丢弃。')
    }
    const state: BrowserProtocolSessionState = {
      channel,
      events: [],
      dropped: 0,
      paused: new Map(),
      unsubscribe: [],
    }
    state.unsubscribe.push(
      channel.onEvent((method, params, session) => this.record(state, method, params, session))
    )
    state.unsubscribe.push(channel.onClose(() => this.forget(sessionId, state)))
    this.sessions.set(sessionId, state)
    this.sweeper ??= this.timers.every(
      BrowserTuning.protocol.pausedRequestSweepMs,
      () => this.sweep(),
      {
        label: 'browser.protocol.autoContinue',
        unref: true,
      }
    )
    return state
  }

  /** 记一条事件：挤掉超出上限的最早那条；被 Fetch 拦下的请求记进账。 */
  private record(
    state: BrowserProtocolSessionState,
    method: string,
    params: unknown,
    session: Optional<string>
  ): void {
    this.lastSeq += 1
    state.events.push({ seq: this.lastSeq, method, params, session: toNullable(session) })
    if (state.events.length > BrowserProtocolLimits.bufferedEvents) {
      state.events.shift()
      state.dropped += 1
    }
    if (method === 'Fetch.requestPaused' && isPlainObject(params) && isString(params.requestId)) {
      state.paused.set(params.requestId, {
        session,
        pausedAt: Date.now(),
        url: pausedRequestUrl(params),
      })
    }
  }

  /** 把超过上限没人放行的请求替模型放行。 */
  private sweep(): void {
    const now = Date.now()
    for (const state of this.sessions.values()) {
      for (const [requestId, paused] of state.paused) {
        if (now - paused.pausedAt < BrowserProtocolLimits.autoContinueMs) continue
        state.paused.delete(requestId)
        void this.autoContinue(state, requestId, paused, now)
      }
    }
  }

  private async autoContinue(
    state: BrowserProtocolSessionState,
    requestId: string,
    paused: BrowserProtocolPausedRequest,
    now: number
  ): Promise<void> {
    try {
      await state.channel.send('Fetch.continueRequest', { requestId }, paused.session)
      this.record(
        state,
        'Velar.requestAutoContinued',
        { requestId, url: paused.url, pausedMs: now - paused.pausedAt },
        paused.session
      )
    } catch (error) {
      // 请求多半已经跟着页面没了：没有什么可放行的，记一笔日志就够。
      this.log.debug('替模型放行被拦下的请求没成', {
        requestId,
        error: AppError.from(error).message,
      })
    }
  }

  /** 忘掉一条会话：退订、从表里拿掉；表空了就停掉兜底的计时器。 */
  private forget(sessionId: string, state: BrowserProtocolSessionState): void {
    if (this.sessions.get(sessionId) !== state) return
    for (const unsubscribe of state.unsubscribe) unsubscribe()
    this.sessions.delete(sessionId)
    this.generations.delete(sessionId)
    if (this.sessions.size === 0 && this.sweeper) {
      this.timers.cancel(this.sweeper)
      this.sweeper = null
    }
  }
}
