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
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { CdpBrowserPageDriverTransport, CdpJsonRpcMessage, CdpPendingRequest, CdpWebSocketLike } from '../../types/cdp.js'
import { parseMessage } from '../../utils/cdp/transport'
import { createDefaultSocket } from '../../utils/cdp/transport.js'
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
    const createSocket = options.createSocket ?? createDefaultSocket
    const socket = createSocket(url)
    const timeoutMs = options.timeoutMs ?? BrowserTuning.cdp.commandTimeoutMs
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
    this.timeoutMs = options.timeoutMs ?? BrowserTuning.cdp.commandTimeoutMs
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
        reject(new AppError('TIMEOUT', `浏览器 CDP 命令超时：${method}`))
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
      pending.reject(new AppError('EXECUTION_FAILED', `浏览器 CDP 命令失败：${messageText}`))
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
