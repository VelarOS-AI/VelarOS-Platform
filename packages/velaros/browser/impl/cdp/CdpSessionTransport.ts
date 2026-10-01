// 域：共用的浏览器级 CDP 连接上的一条标签页会话（flatten）——页面驱动与模型自己的 CDP 会话各挂一条。
//
// ## 不变量（改这些会破什么）
//  - **只认自己这一页**：按方法订阅只收这条会话自己的事件；订阅全部事件时，这条会话自己的 sessionId 报成 undefined，
//    它（与它的子会话）挂出来的子会话（跨进程 iframe、模型挂的 worker）照原 sessionId 转过来。哪些子会话归这一页，
//    靠这条会话与子会话上的 Target.attachedToTarget / detachedFromTarget 记账；别的标签页的会话一概不收、也发不过去。
//  - **断了就一次性拒绝在飞的命令**：浏览器报这条会话脱开（标签页关了）或者连接断了（用户退出了浏览器），
//    在飞的命令当场拒绝、再触发关闭，不留着等超时（和 CdpWebSocketTransport 的 rejectAll 同一个理由）。
//  - **释放只脱开自己**：dispose 发 Target.detachFromTarget、退订，绝不关共用的 socket——同一个浏览器里别的会话还在用它。
import { isNonBlankString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { CdpTargetAttachedEvent, CdpTargetDetachedEvent } from '../../types/cdp.js'
import { BrowserTuning } from '../../utils/tuning'

import type { CdpWebSocketTransportApi } from './CdpWebSocketTransport'

/** 标签页会话要浏览器级连接做的三件事：发命令、报连接上的全部事件、报连接关闭。 */
export interface CdpSessionTransportConnection {
  /** 在连接上发一条命令：sessionId 指发给哪条会话（undefined 是浏览器级会话），timeoutMs 是这一条等回包的毫秒数。 */
  send<T = unknown>(
    method: string,
    params: Optional<Record<string, unknown>>,
    sessionId: Optional<string>,
    timeoutMs: number
  ): Promise<T>
  /** 订阅连接上的全部事件（sessionId 是哪条会话发的，浏览器级会话的是 undefined）；返回取消订阅的函数。 */
  onAnyEvent(
    listener: (method: string, params: unknown, sessionId: Optional<string>) => void
  ): () => void
  /** 订阅连接关闭（浏览器退出、socket 断开、连接被释放）；返回取消订阅的函数。 */
  onClose(listener: () => void): () => void
}

/** 建一条标签页会话传输的参数。 */
export interface CdpSessionTransportOptions {
  /** 共用的浏览器级连接。 */
  connection: CdpSessionTransportConnection
  /** 挂上的是哪个标签页。 */
  targetId: string
  /** Target.attachToTarget（flatten）交回的 sessionId。 */
  sessionId: string
  /** 这条会话上单条命令等回包的毫秒数；不给用 `BrowserTuning.cdp.commandTimeoutMs`。 */
  timeoutMs?: LooseOptional<number>
}

/**
 * 共用的浏览器级连接上的一条标签页会话：形状与 {@link CdpWebSocketTransportApi} 一样，页面驱动与模型的 CDP 会话都拿它当传输。
 * 命令缺省发给这一页，明写的 sessionId 只能是这一页挂出来的子会话；关闭是这一页脱开或连接断开；释放只脱开这一页。
 */
export interface CdpSessionTransportApi extends CdpWebSocketTransportApi {
  /** 这条会话挂在哪个标签页上。 */
  readonly targetId: string
  /** 这条会话的 sessionId。 */
  readonly sessionId: string
}

/** 见 {@link CdpSessionTransportApi}。 */
export class CdpSessionTransport implements CdpSessionTransportApi {
  public readonly targetId: string
  public readonly sessionId: string
  private readonly timeoutMs: number
  /** 这一页（与它的子会话）挂出来的子会话。 */
  private readonly children = new Set<string>()
  private readonly eventListeners = new Map<string, Set<(params: unknown) => void>>()
  private readonly anyEventListeners = new Set<
    (method: string, params: unknown, sessionId: Optional<string>) => void
  >()
  private readonly closeListeners = new Set<() => void>()
  /** 在飞命令的拒绝口：会话一断就全拒掉。 */
  private readonly inflight = new Set<(error: AppError) => void>()
  private readonly unsubscribers: Array<() => void> = []
  private closed = false

  constructor(private readonly options: CdpSessionTransportOptions) {
    this.targetId = options.targetId
    this.sessionId = options.sessionId
    this.timeoutMs = options.timeoutMs ?? BrowserTuning.cdp.commandTimeoutMs
    this.unsubscribers.push(
      options.connection.onAnyEvent(this.handleEvent),
      options.connection.onClose(this.handleClose)
    )
  }

  public send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(
        new AppError('EXECUTION_ABORTED', `浏览器标签页会话已经断开：${method}`)
      )
    const target = sessionId ?? this.sessionId
    if (target !== this.sessionId && !this.children.has(target)) {
      const protocolMessage = `会话 ${target} 不是这一页挂出来的，这条会话发不过去`
      return Promise.reject(
        new AppError('EXECUTION_FAILED', `浏览器 CDP 命令失败：${protocolMessage}`, undefined, {
          cdpMethod: method,
          protocolMessage,
        })
      )
    }

    return new Promise<T>((resolve, reject) => {
      this.inflight.add(reject)
      this.options.connection.send<T>(method, params, target, timeoutMs ?? this.timeoutMs).then(
        (value) => {
          this.inflight.delete(reject)
          resolve(value)
        },
        (error: unknown) => {
          this.inflight.delete(reject)
          reject(error)
        }
      )
    })
  }

  public onEvent<T = unknown>(method: string, listener: (params: T) => void): () => void {
    const listeners = this.eventListeners.get(method) ?? new Set<(params: unknown) => void>()
    const wrapped = listener as (params: unknown) => void
    listeners.add(wrapped)
    this.eventListeners.set(method, listeners)

    return () => {
      listeners.delete(wrapped)
      if (listeners.size < 1) this.eventListeners.delete(method)
    }
  }

  public onAnyEvent(
    listener: (method: string, params: unknown, sessionId: Optional<string>) => void
  ): () => void {
    this.anyEventListeners.add(listener)
    return () => {
      this.anyEventListeners.delete(listener)
    }
  }

  public onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  public dispose(): void {
    const attached = !this.closed
    this.closed = true
    this.release(new AppError('EXECUTION_ABORTED', '浏览器标签页会话已释放。'))
    this.eventListeners.clear()
    this.anyEventListeners.clear()
    this.closeListeners.clear()
    this.children.clear()
    if (!attached) return

    void this.options.connection
      .send('Target.detachFromTarget', { sessionId: this.sessionId }, undefined, this.timeoutMs)
      .catch(() => {
        // arch-guard:silent-catch-ok 脱开是尽力而为：标签页可能已经关了、连接可能正好断了，会话在这边都已经作废。
      })
  }

  private readonly handleEvent = (
    method: string,
    params: unknown,
    sessionId: Optional<string>
  ): void => {
    if (!sessionId) {
      // 浏览器级会话上的事件只关心一件：这条会话脱开了（标签页关了、被别的客户端摘掉）。
      if (
        method === 'Target.detachedFromTarget' &&
        (params as CdpTargetDetachedEvent).sessionId === this.sessionId
      )
        this.close()
      return
    }
    if (sessionId !== this.sessionId && !this.children.has(sessionId)) return

    this.trackChild(method, params)
    const reported = sessionId === this.sessionId ? undefined : sessionId
    for (const listener of [...this.anyEventListeners]) listener(method, params, reported)
    // 按方法订阅的是这一页自己的事件：子会话的同名事件不能混进来。
    if (reported) return
    const listeners = this.eventListeners.get(method)
    if (!listeners) return
    for (const listener of [...listeners]) listener(params)
  }

  private readonly handleClose = (): void => {
    this.close()
  }

  /** 这条会话或子会话上挂出来、脱开的子会话记进（划出）账里。 */
  private trackChild(method: string, params: unknown): void {
    if (method === 'Target.attachedToTarget') {
      const { sessionId } = params as CdpTargetAttachedEvent
      if (isNonBlankString(sessionId)) this.children.add(sessionId)
      return
    }
    if (method === 'Target.detachedFromTarget') {
      const { sessionId } = params as CdpTargetDetachedEvent
      if (isNonBlankString(sessionId)) this.children.delete(sessionId)
    }
  }

  private close(): void {
    if (this.closed) return
    this.closed = true
    this.release(
      new AppError('EXECUTION_ABORTED', '浏览器标签页会话已断开：标签页关了，或者浏览器连接断了。')
    )
    for (const listener of [...this.closeListeners]) listener()
  }

  /** 退订连接、拒绝在飞的命令。 */
  private release(error: AppError): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    for (const abort of [...this.inflight]) abort(error)
    this.inflight.clear()
  }
}
