// 域：CDP 的 JSON-RPC over WebSocket 传输层——外部浏览器驱动与浏览器进程之间唯一的字节通道。
//
// ## 协议不变量（改这些会破什么）
//  - **`id` 单调自增且不复用**：CDP 靠 `id` 把响应配回请求。复用或重置会让两个在飞命令拿到
//    对方的结果——症状是「截图返回了 cookie」这类无法定位的错乱。
//  - **每个在飞请求都带超时租约**：浏览器进程可能不回包就卡住（页面被 alert 阻塞是最常见的
//    一种）。没有超时就是永不 settle 的 Promise，上层串行队列随之整体挂死。
//  - **socket 关闭必须 `rejectAll`**：断开时所有在飞 Promise 一次性拒绝，不能留在 map 里等超时
//    ——那会把「连接没了」延迟成 N 秒后的一串超时错误，丢掉可读诊断。
//  - **`send<T>` 的 `T` 是断言不是校验**：CDP 无 schema，这里是全包 CDP 响应类型的**唯一**收口
//    点（§1.4 白名单②）。调用方的类型安全感到此为止，字段存在性要自己判。
//  - **坏帧不炸链路**：解析失败转成 `AppError` 返回值而非抛出——一个畸形事件包不该终结整条
//    会话（失败方向：降级且可查，而不是整体消失）。
import { isString, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { CdpBrowserPageDriverTransport, CdpJsonRpcMessage, CdpPendingRequest, CdpWebSocketLike } from '../../types/cdp.js'
import { parseMessage } from '../../utils/cdp/transport'
import { BrowserTuning } from '../../utils/tuning'

/** 用一条已经连上的 WebSocket 建传输时的参数。 */
export interface CdpWebSocketTransportOptions {
  /** 已经连上的 socket。 */
  socket: CdpWebSocketLike
  /** 单条命令等回包的毫秒数；不给用 `BrowserTuning.cdp.commandTimeoutMs`。 */
  timeoutMs?: LooseOptional<number>
}

/** 现连一条 WebSocket 建传输时的参数。 */
export interface CdpWebSocketTransportConnectOptions {
  /** 自己造 socket 的口子；不给就用运行环境的 WebSocket。 */
  createSocket?: LooseOptional<(url: string) => CdpWebSocketLike>
  /** 连接与单条命令的毫秒超时；不给用 `BrowserTuning.cdp.commandTimeoutMs`。 */
  timeoutMs?: LooseOptional<number>
}

/**
 * CDP 的 JSON-RPC over WebSocket 传输：下发命令、订阅事件、订阅关闭，外加一把释放。
 *
 * 比通用的 {@link CdpBrowserPageDriverTransport} 多两件：事件与关闭的订阅在这一路上一定有，
 * 以及 `dispose` —— socket 是它自己持有的资源。
 */
export interface CdpWebSocketTransportApi extends CdpBrowserPageDriverTransport {
  /**
   * 下发一条 CDP 命令并等回包；`T` 是断言不是校验。sessionId 给 flatten 模式下的子会话。
   * 协议报错拒绝成 `EXECUTION_FAILED`，context 里 `protocolMessage` 是协议给的原话。
   */
  send<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>
  /** 订阅一类 CDP 事件（只收页面本身的，不收子会话的）；返回取消订阅的函数。 */
  onEvent<T = unknown>(method: string, listener: (params: T) => void): () => void
  /** 订阅这条连接上的全部事件，连同子会话的（sessionId 是子会话，页面本身是 undefined）；返回取消订阅的函数。 */
  onAnyEvent(listener: (method: string, params: unknown, sessionId: Optional<string>) => void): () => void
  /** 订阅传输关闭；返回取消订阅的函数。 */
  onClose(listener: () => void): () => void
  /** 关掉 socket 并拒绝所有在飞请求。 */
  dispose(): void
}

/** 见 {@link CdpWebSocketTransportApi}。 */
class CdpWebSocketTransport implements CdpWebSocketTransportApi {
  private nextId = 1
  private readonly pending = new Map<number, CdpPendingRequest>()
  private readonly eventListeners = new Map<string, Set<(params: unknown) => void>>()
  private readonly anyEventListeners = new Set<(method: string, params: unknown, sessionId: Optional<string>) => void>()
  private readonly closeListeners = new Set<() => void>()
  private readonly timeoutMs: number
  private readonly timers = new TimerScope({ name: 'CdpWebSocketTransport' })
  private readonly textDecoder = new TextDecoder()

  constructor(private readonly options: CdpWebSocketTransportOptions) {
    this.timeoutMs = options.timeoutMs ?? BrowserTuning.cdp.commandTimeoutMs
    options.socket.addEventListener('message', this.handleMessage)
    options.socket.addEventListener('close', this.handleClose)
    options.socket.addEventListener('error', this.handleError)
  }

  public send<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    const id = this.nextId
    this.nextId += 1

    return new Promise<T>((resolve, reject) => {
      const timeout = this.timers.after(this.timeoutMs, () => {
        this.pending.delete(id)
        reject(new AppError('TIMEOUT', `浏览器 CDP 命令超时：${method}`))
      }, {
        label: `cdp.${method}`,
        unref: true,
      })
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      })

      const message: CdpJsonRpcMessage = { id, method, params }
      if (sessionId) message.sessionId = sessionId
      this.options.socket.send(JSON.stringify(message))
    })
  }

  public onEvent<T = unknown>(method: string, listener: (params: T) => void): () => void {
    const listeners = this.eventListeners.get(method) ?? new Set<(params: unknown) => void>()
    const wrapped = listener as (params: unknown) => void
    listeners.add(wrapped)
    this.eventListeners.set(method, listeners)

    return () => {
      listeners.delete(wrapped)
      if (listeners.size < 1) {
        this.eventListeners.delete(method)
      }
    }
  }

  public onAnyEvent(listener: (method: string, params: unknown, sessionId: Optional<string>) => void): () => void {
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
    this.options.socket.removeEventListener('message', this.handleMessage)
    this.options.socket.removeEventListener('close', this.handleClose)
    this.options.socket.removeEventListener('error', this.handleError)
    this.closeListeners.clear()
    this.eventListeners.clear()
    this.anyEventListeners.clear()
    this.rejectAll(new AppError('EXECUTION_ABORTED', '浏览器 CDP 连接已释放。'))
    this.timers.dispose()
    this.options.socket.close()
  }

  private readonly handleMessage = (event: Event): void => {
    const rawData = this.readMessageText((event as MessageEvent).data)
    if (!rawData) return

    const message = parseMessage(rawData)
    if (message instanceof AppError) return
    if (!message) return
    if (!Number.isInteger(message.id)) {
      this.dispatchEventMessage(message)
      return
    }

    const id = Number(message.id)
    const pending = this.pending.get(id)
    if (!pending) return

    pending.timeout.cancel()
    this.pending.delete(id)

    if (message.error) {
      const messageText = isString(message.error.message)
        ? message.error.message
        : '未知的 CDP 错误'
      pending.reject(new AppError('EXECUTION_FAILED', `浏览器 CDP 命令失败：${messageText}`, undefined, {
        cdpMethod: pending.method,
        protocolMessage: messageText,
      }))
      return
    }

    pending.resolve(message.result)
  }

  private readMessageText(data: unknown): Nullable<string> {
    if (isString(data)) return data
    if (data instanceof ArrayBuffer) return this.textDecoder.decode(data)
    if (ArrayBuffer.isView(data)) {
      const bytes = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)
      return this.textDecoder.decode(bytes)
    }

    return null
  }

  private dispatchEventMessage(message: CdpJsonRpcMessage): void {
    if (!isString(message.method)) return

    const sessionId = optionalWhen(isString, message.sessionId)
    for (const listener of [...this.anyEventListeners]) {
      listener(message.method, message.params, sessionId)
    }
    // 按方法订阅的是驱动自己那条会话的事件：子会话的同名事件不能混进来。
    if (sessionId) return
    const listeners = this.eventListeners.get(message.method)
    if (!listeners) return

    for (const listener of listeners) {
      listener(message.params)
    }
  }

  private readonly handleClose = (): void => {
    this.rejectAll(new AppError('EXECUTION_ABORTED', '浏览器 CDP 连接已关闭。'))
    for (const listener of [...this.closeListeners]) {
      listener()
    }
  }

  private readonly handleError = (): void => {
    this.rejectAll(new AppError('NETWORK', '浏览器 CDP 连接出错。'))
  }

  

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.timeout.cancel()
      pending.reject(error)
    }
    this.pending.clear()
  }

  
}

export { CdpWebSocketTransport }
