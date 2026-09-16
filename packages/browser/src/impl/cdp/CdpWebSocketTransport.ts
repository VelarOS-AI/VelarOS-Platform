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
import { isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { CdpBrowserPageDriverTransport } from './CdpBrowserPageDriver'

export interface CdpWebSocketLike {
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: Event) => void): void
  removeEventListener(type: string, listener: (event: Event) => void): void
}

export interface CdpWebSocketTransportOptions {
  socket: CdpWebSocketLike
  timeoutMs?: LooseOptional<number>
}

export interface CdpWebSocketTransportConnectOptions {
  createSocket?: LooseOptional<(url: string) => CdpWebSocketLike>
  timeoutMs?: LooseOptional<number>
}

interface CdpPendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: TimerLease
}

interface CdpJsonRpcMessage {
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: {
    message?: unknown
  }
}

const DefaultCdpCommandTimeoutMs = 10_000

class CdpWebSocketTransport implements CdpBrowserPageDriverTransport {
  private nextId = 1
  private readonly pending = new Map<number, CdpPendingRequest>()
  private readonly eventListeners = new Map<string, Set<(params: unknown) => void>>()
  private readonly closeListeners = new Set<() => void>()
  private readonly timeoutMs: number
  private readonly timers = new TimerScope({ name: 'CdpWebSocketTransport' })
  private readonly textDecoder = new TextDecoder()

  public static connect(
    url: string,
    options: CdpWebSocketTransportConnectOptions = {}
  ): Promise<CdpWebSocketTransport> {
    const createSocket = options.createSocket ?? this.createDefaultSocket
    const socket = createSocket(url)
    const timeoutMs = options.timeoutMs ?? DefaultCdpCommandTimeoutMs
    const timers = new TimerScope({ name: 'CdpWebSocketTransport.connect' })

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        socket.removeEventListener('open', handleOpen)
        socket.removeEventListener('error', handleError)
        socket.removeEventListener('close', handleClose)
        timeout.cancel()
        timers.dispose()
      }
      const handleOpen = () => {
        cleanup()
        resolve(new CdpWebSocketTransport({ socket, timeoutMs }))
      }
      const handleError = () => {
        cleanup()
        reject(new AppError('NETWORK', `无法连接浏览器 CDP WebSocket：${url}`))
      }
      const handleClose = () => {
        cleanup()
        reject(new AppError('NETWORK', `浏览器 CDP WebSocket 连接已关闭：${url}`))
      }
      const timeout = timers.after(timeoutMs, () => {
        cleanup()
        reject(new AppError('TIMEOUT', `连接浏览器 CDP WebSocket 超时：${url}`))
      }, {
        label: 'cdp.connect',
        unref: true,
      })

      socket.addEventListener('open', handleOpen)
      socket.addEventListener('error', handleError)
      socket.addEventListener('close', handleClose)
    })
  }

  constructor(private readonly options: CdpWebSocketTransportOptions) {
    this.timeoutMs = options.timeoutMs ?? DefaultCdpCommandTimeoutMs
    options.socket.addEventListener('message', this.handleMessage)
    options.socket.addEventListener('close', this.handleClose)
    options.socket.addEventListener('error', this.handleError)
  }

  public send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId
    this.nextId += 1

    return new Promise<T>((resolve, reject) => {
      const timeout = this.timers.after(this.timeoutMs, () => {
        this.pending.delete(id)
        reject(new AppError('TIMEOUT', `CDP command timed out: ${method}`))
      }, {
        label: `cdp.${method}`,
        unref: true,
      })
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      })

      this.options.socket.send(JSON.stringify({
        id,
        method,
        params,
      }))
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
    this.rejectAll(new AppError('EXECUTION_ABORTED', 'CDP transport disposed.'))
    this.timers.dispose()
    this.options.socket.close()
  }

  private readonly handleMessage = (event: Event): void => {
    const rawData = this.readMessageText((event as MessageEvent).data)
    if (!rawData) return

    const message = this.parseMessage(rawData)
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
        : 'unknown CDP error'
      pending.reject(new AppError('EXECUTION_FAILED', `CDP command failed: ${messageText}`))
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

    const listeners = this.eventListeners.get(message.method)
    if (!listeners) return

    for (const listener of listeners) {
      listener(message.params)
    }
  }

  private readonly handleClose = (): void => {
    this.rejectAll(new AppError('EXECUTION_ABORTED', 'CDP transport closed.'))
    for (const listener of [...this.closeListeners]) {
      listener()
    }
  }

  private readonly handleError = (): void => {
    this.rejectAll(new AppError('NETWORK', 'CDP transport socket error.'))
  }

  private parseMessage(rawData: string): Nullable<CdpJsonRpcMessage> | AppError {
    try {
      return JSON.parse(rawData) as CdpJsonRpcMessage
    } catch (error) {
      return new AppError('VALIDATION', 'Invalid CDP JSON-RPC message.', error)
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.timeout.cancel()
      pending.reject(error)
    }
    this.pending.clear()
  }

  private static createDefaultSocket(url: string): CdpWebSocketLike {
    const WebSocketCtor = globalThis.WebSocket
    if (!WebSocketCtor) {
      throw new AppError('PLATFORM', '当前运行时不支持 WebSocket，无法连接 CDP。')
    }

    return new WebSocketCtor(url) as CdpWebSocketLike
  }
}

export { CdpWebSocketTransport }
