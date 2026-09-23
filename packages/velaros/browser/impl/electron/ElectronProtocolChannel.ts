import type electron from 'electron'

import { isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { BrowserErrorCodes } from '../../contract/constants.js'
import type { BrowserProtocolChannel } from '../../contract/requires.js'
import { protocolFailure } from '../../utils/cdp/protocol.js'
import { BrowserTuning } from '../../utils/tuning'

import { electronDebuggerHolds } from './ElectronDebuggerHolds'

/**
 * 内嵌页面上模型自己的一条 CDP 会话：debugger 上用 `Target.attachToTarget` 连页面自己挂出来的子会话（flatten）。
 *
 * 域的开关、事件、仿真与 Fetch 拦截都只算在这条子会话上：宿主那条会话（没有 sessionId 的）照常工作，
 * 模型关掉 Network 域也断不了宿主的诊断。模型在这条会话上 `Target.setAutoAttach` 挂出来的孙会话（跨源 iframe、worker）
 * 记在 `children` 里，只有它们能被 `send` 指名；别的会话（宿主的、页面自己的）一律不认。
 * 子会话一断开，Chromium 撤掉它设的仿真，被它拦着的请求直接失败，不会把页面卡死。
 * 开着的时候在 debugger 占用登记里记一笔，临时操作收尾时不会把 debugger 连同子会话一起 detach。
 */
export class ElectronProtocolChannel implements BrowserProtocolChannel {
  private readonly eventListeners = new Set<
    (method: string, params: unknown, sessionId: Optional<string>) => void
  >()
  private readonly closeListeners = new Set<() => void>()
  /** 这条会话挂出来的子会话（flatten）。 */
  private readonly children = new Set<string>()
  private closed = false

  constructor(
    private readonly webContents: electron.WebContents,
    /** 页面自己的那条子会话。 */
    private readonly rootSessionId: string
  ) {
    webContents.debugger.on('message', this.handleMessage)
    webContents.debugger.on('detach', this.handleDetach)
    electronDebuggerHolds.setProtocol(webContents, { sessionId: rootSessionId })
  }

  public async send(
    method: string,
    params: Optional<Record<string, unknown>>,
    sessionId?: string
  ): Promise<unknown> {
    if (this.closed)
      throw new AppError(
        BrowserErrorCodes.protocolFailed,
        `${method}：CDP 会话已经断开，再发一条会重新连。`
      )
    if (sessionId && !this.children.has(sessionId)) {
      throw new AppError(
        BrowserErrorCodes.protocolFailed,
        `${method}：${sessionId} 不是这条会话挂出来的子会话（先 Target.setAutoAttach，从 Target.attachedToTarget 事件里取）。`
      )
    }
    const timers = new TimerScope({ name: 'ElectronProtocolChannel' })
    try {
      return await timers.withTimeout(
        BrowserTuning.protocol.commandTimeoutMs,
        () =>
          this.webContents.debugger.sendCommand(
            method,
            params ?? {},
            sessionId ?? this.rootSessionId
          ),
        {
          label: method,
          timeoutMessage: `${method} 超过 ${BrowserTuning.protocol.commandTimeoutMs} 毫秒没有回话。`,
        }
      )
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError')
        throw new AppError('TIMEOUT', error.message, error)
      throw protocolFailure(method, error)
    } finally {
      timers.dispose()
    }
  }

  public onEvent(
    listener: (method: string, params: unknown, sessionId: Optional<string>) => void
  ): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  public onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  public async close(): Promise<void> {
    if (this.closed) return
    this.markClosed()
    if (this.webContents.isDestroyed() || !this.webContents.debugger.isAttached()) return
    try {
      await this.webContents.debugger.sendCommand('Target.detachFromTarget', {
        sessionId: this.rootSessionId,
      })
    } catch {
      // arch-guard:silent-catch-ok 子会话可能已经跟着页面没了：断开本来就是要的结果，没有调用方能再做什么。
    }
  }

  private readonly handleMessage = (
    _event: electron.Event,
    method: string,
    params: unknown,
    sessionId?: string
  ): void => {
    if (!sessionId) {
      // 宿主那条会话上报的「子会话断了」：页面关了、崩了，这条会话跟着没了。
      if (
        method === 'Target.detachedFromTarget' &&
        isPlainObject(params) &&
        params.sessionId === this.rootSessionId
      )
        this.markClosed()
      return
    }
    const own = sessionId === this.rootSessionId
    if (!own && !this.children.has(sessionId)) return
    if (isPlainObject(params) && isString(params.sessionId)) {
      if (method === 'Target.attachedToTarget') this.children.add(params.sessionId)
      if (method === 'Target.detachedFromTarget') this.children.delete(params.sessionId)
    }
    for (const listener of [...this.eventListeners])
      listener(method, params, own ? undefined : sessionId)
  }

  private readonly handleDetach = (): void => {
    this.markClosed()
  }

  /** 记成已断开：摘掉监听、撤销占用登记、通知订阅者，只做一次。 */
  private markClosed(): void {
    if (this.closed) return
    this.closed = true
    this.webContents.debugger.off('message', this.handleMessage)
    this.webContents.debugger.off('detach', this.handleDetach)
    electronDebuggerHolds.deleteProtocol(this.webContents)
    this.children.clear()
    for (const listener of [...this.closeListeners]) listener()
    this.closeListeners.clear()
    this.eventListeners.clear()
  }
}
