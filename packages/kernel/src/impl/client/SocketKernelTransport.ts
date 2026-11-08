import { createConnection, type Socket } from 'node:net'

import {
  isBlank,
  isBoolean,
  isNotUndefined,
  isNull,
  isObject,
  isRecord,
  isString,
  isTrue,
  isUndefined,
  Log,
} from '@velaros-ai/core'
import { createAbortError } from '@velaros-ai/core/error'

import type { KernelRpcMethod } from '../../contract/constants'
import { KernelClientErrorCodes, KernelRpcLimits } from '../../contract/constants'
import type { KernelEventSubscription } from '../../contract/provides'
import type { KernelClientEventHandler, KernelClientTransport } from '../../contract/requires'
import type {
  KernelClientEventSubscriptionRecord,
  KernelClientPendingRequest,
  SocketKernelTransportOptions,
} from '../../types/client'
import type { KernelServiceHealth } from '../../types/kernel.js'
import type { KernelRpcEventFrame, KernelRpcResponse } from '../../types/wire'
import { fromKernelRpcError, type KernelClientError } from '../../utils/errors'
import {
  type CapabilityCallRequest,
  type CapabilityCallResponse,
  CapabilityCallResponseSchema,
  type CapabilitySessionCloseRequest,
  type CapabilitySessionCloseResponse,
  CapabilitySessionCloseResponseSchema,
  type CapabilitySessionOpenRequest,
  type CapabilitySessionOpenResponse,
  CapabilitySessionOpenResponseSchema,
} from '../../utils/wire/capability'
import { type KernelHandshake, KernelHandshakeSchema } from '../../utils/wire/handshake'
import {
  type ModsInstallFromDirectoryRequest,
  type ModsInstallFromDirectoryResponse,
  ModsInstallFromDirectoryResponseSchema,
  type ModsListRequest,
  type ModsListResponse,
  ModsListResponseSchema,
  type ModsSetEnabledRequest,
  type ModsSetEnabledResponse,
  ModsSetEnabledResponseSchema,
} from '../../utils/wire/mods'

const log = Log.tag('SocketKernelTransport')

/**
 * 长连接的本机 RPC 传输：并发请求、取消、服务端推来的内核事件都走它。
 *
 * 断线之后下一次请求会自己重连，还活着的订阅跟着连接一起重建。实例由产品或
 * `kernelDaemons.connect` 构造，交给 `KernelClient` 用。
 */
export class SocketKernelTransport implements KernelClientTransport {
  /** 中止一次请求时的失败文案。 */
  private static readonly AbortMessage = 'Kernel RPC 请求已中止'

  /** 传输被回收之后，一切请求的失败文案。 */
  private static readonly ClosedMessage = 'Kernel RPC 传输已关闭'

  /** 连接中途断开时，在途请求的失败文案。 */
  private static readonly DisconnectedMessage = 'Kernel RPC 连接已断开'

  /** 连不上端点时的失败文案。 */
  private static readonly ConnectFailedMessage = '连不上 Kernel RPC 端点'

  private readonly pending = new Map<string, KernelClientPendingRequest>()
  /** 服务端订阅 id → 本地记录；断线时清空（id 随连接作废）。 */
  private readonly eventHandlers = new Map<string, KernelClientEventSubscriptionRecord>()
  /** 还活着的本地订阅记录；跨断线保留，重连后照原样重建。 */
  private readonly subscriptions = new Set<KernelClientEventSubscriptionRecord>()
  private readonly maxFrameBytes: number
  private socket?: Socket
  private connecting?: Promise<Socket>
  private connectingSocket?: Socket
  private buffer = ''
  private requestSequence = 0
  private disposed = false

  public constructor(private readonly options: SocketKernelTransportOptions) {
    this.maxFrameBytes = options.maxFrameBytes ?? KernelRpcLimits.maxFrameBytes
  }

  public async handshake(): Promise<KernelHandshake> {
    return KernelHandshakeSchema.parse(await this.request('handshake', null))
  }

  public async health(): Promise<KernelServiceHealth> {
    return (await this.request('health', null)) as KernelServiceHealth
  }

  public async openCapabilitySession(
    request: CapabilitySessionOpenRequest
  ): Promise<CapabilitySessionOpenResponse> {
    return CapabilitySessionOpenResponseSchema.parse(
      await this.request('capability.session.open', request)
    )
  }

  public async closeCapabilitySession(
    request: CapabilitySessionCloseRequest
  ): Promise<CapabilitySessionCloseResponse> {
    return CapabilitySessionCloseResponseSchema.parse(
      await this.request('capability.session.close', request)
    )
  }

  public async call(
    request: CapabilityCallRequest,
    signal?: AbortSignal
  ): Promise<CapabilityCallResponse> {
    return CapabilityCallResponseSchema.parse(
      await this.request('capability.call', request, signal)
    )
  }

  public async listMods(request: ModsListRequest): Promise<ModsListResponse> {
    return ModsListResponseSchema.parse(await this.request('mods.list', request))
  }

  public async setModEnabled(request: ModsSetEnabledRequest): Promise<ModsSetEnabledResponse> {
    return ModsSetEnabledResponseSchema.parse(await this.request('mods.setEnabled', request))
  }

  public async installModFromDirectory(
    request: ModsInstallFromDirectoryRequest
  ): Promise<ModsInstallFromDirectoryResponse> {
    return ModsInstallFromDirectoryResponseSchema.parse(
      await this.request('mods.installFromDirectory', request)
    )
  }

  public async subscribe(
    eventType: string,
    handler: KernelClientEventHandler
  ): Promise<KernelEventSubscription> {
    if (this.disposed) throw this.closedError()
    const socket = await this.connect()
    const record: KernelClientEventSubscriptionRecord = { eventType, handler, disposed: false }
    await this.bindSubscription(record, socket)
    if (this.disposed) throw this.closedError()
    if (socket.destroyed || this.socket !== socket || isUndefined(record.subscriptionId))
      throw this.disconnectedError()
    return {
      dispose: async () => {
        record.disposed = true
        this.subscriptions.delete(record)
        if (
          isNotUndefined(record.subscriptionId) &&
          this.eventHandlers.get(record.subscriptionId) === record
        )
          this.eventHandlers.delete(record.subscriptionId)
        await record.binding
        await record.release?.()
      },
    }
  }

  /** 绑定一次真实连接上的订阅；晚到回应由发起这次请求的记录和连接收尾。 */
  private async bindSubscription(
    record: KernelClientEventSubscriptionRecord,
    socket: Socket
  ): Promise<void> {
    const binding: Promise<void> = this.requestOnSocket(
      socket,
      'events.subscribe',
      { eventType: record.eventType },
      undefined,
      async (result) => {
        const subscriptionId = this.readSubscriptionId(result)
        let releasing: Promise<void> | undefined
        const release = () => (releasing ??= this.unsubscribe(socket, subscriptionId))
        if (record.binding === binding) record.release = release
        if (
          record.disposed ||
          this.disposed ||
          socket.destroyed ||
          this.socket !== socket ||
          record.binding !== binding
        ) {
          await release()
          return
        }
        // ACK 后同一个 read 中就可能跟着事件；登记必须先于 Promise 的续体。
        record.subscriptionId = subscriptionId
        this.subscriptions.add(record)
        this.eventHandlers.set(subscriptionId, record)
      }
    ).then(
      () => undefined,
      (error: unknown) => {
        if (record.disposed && (this.disposed || socket.destroyed)) return
        throw error
      }
    )
    record.binding = binding
    try {
      await binding
    } finally {
      if (record.binding === binding) record.binding = undefined
    }
  }

  /** 只释放原连接上的实际 id；断线已使它失效，清理本身绝不触发重连。 */
  private async unsubscribe(socket: Socket, subscriptionId: string): Promise<void> {
    if (socket.destroyed) return
    try {
      await this.requestOnSocket(socket, 'events.unsubscribe', { subscriptionId })
    } catch (error) {
      if (socket.destroyed) return
      throw error
    }
  }

  /** 某条订阅恢复失败只记日志；普通请求与其他订阅不受它的失败影响。 */
  private async restoreSubscriptions(socket: Socket): Promise<void> {
    for (const record of [...this.subscriptions]) {
      if (this.disposed || socket.destroyed || this.socket !== socket) return
      if (record.disposed) continue
      try {
        await this.bindSubscription(record, socket)
      } catch (error) {
        log.error('Kernel 事件订阅在重连后未能恢复', {
          error,
          eventType: record.eventType,
        })
      }
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const record of this.subscriptions) record.disposed = true
    this.eventHandlers.clear()
    this.subscriptions.clear()
    const socket = this.socket
    const connectingSocket = this.connectingSocket
    this.socket = undefined
    this.connecting = undefined
    this.connectingSocket = undefined
    socket?.destroy()
    connectingSocket?.destroy()
    this.rejectPending(this.closedError())
  }

  private async request(
    method: KernelRpcMethod,
    params: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.disposed) throw this.closedError()
    if (isTrue(signal?.aborted)) throw createAbortError(SocketKernelTransport.AbortMessage)
    const socket = await this.connect()
    return this.requestOnSocket(socket, method, params, signal)
  }

  /** 向已经取得的那条连接发请求；accept 在接收成功帧时同步取得结果归属。 */
  private async requestOnSocket(
    socket: Socket,
    method: KernelRpcMethod,
    params: unknown,
    signal?: AbortSignal,
    accept?: (result: unknown) => unknown
  ): Promise<unknown> {
    this.assertRequestActive(socket, signal)
    const requestId = `${process.pid}-${++this.requestSequence}`
    let frame: string
    try {
      frame = `${JSON.stringify({
        type: 'request',
        requestId,
        authToken: this.options.authToken,
        method,
        params,
      })}\n`
    } catch {
      this.assertRequestActive(socket, signal)
      throw this.localFailure(
        KernelClientErrorCodes.transportWriteFailed,
        'Kernel RPC 请求发不出去',
        true
      )
    }
    // unknown payload 的 toJSON/getter 可以重入取消或关闭；尚未发出就没有可取消的远端请求。
    this.assertRequestActive(socket, signal)
    return new Promise((resolve, reject) => {
      let sent = false
      const onAbort = () => {
        this.pending.delete(requestId)
        cleanup()
        reject(createAbortError(SocketKernelTransport.AbortMessage))
        if (sent) this.sendCancellation(socket, requestId)
      }
      const cleanup = () => signal?.removeEventListener('abort', onAbort)
      this.pending.set(requestId, {
        resolve: (result) => {
          try {
            resolve(isUndefined(accept) ? result : accept(result))
          } catch (error) {
            reject(error)
          }
        },
        reject,
        cleanup,
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        this.assertRequestActive(socket, signal)
      } catch (error) {
        this.pending.delete(requestId)
        cleanup()
        reject(error)
        return
      }
      try {
        socket.write(frame)
        sent = true
      } catch {
        this.pending.delete(requestId)
        cleanup()
        reject(
          this.localFailure(
            KernelClientErrorCodes.transportWriteFailed,
            'Kernel RPC 请求发不出去',
            true
          )
        )
      }
    })
  }

  /** 序列化与真实写入之间也要核对同一个请求的取消、关闭和连接身份。 */
  private assertRequestActive(socket: Socket, signal?: AbortSignal): void {
    if (this.disposed) throw this.closedError()
    if (isTrue(signal?.aborted)) throw createAbortError(SocketKernelTransport.AbortMessage)
    if (socket.destroyed || this.socket !== socket) throw this.disconnectedError()
  }

  private connect(): Promise<Socket> {
    if (isNotUndefined(this.socket) && !this.socket.destroyed) return Promise.resolve(this.socket)
    if (isNotUndefined(this.connecting)) return this.connecting

    this.connecting = new Promise((resolve, reject) => {
      const socket =
        this.options.endpoint.kind === 'unix'
          ? createConnection(this.options.endpoint.path)
          : createConnection(this.options.endpoint.port, this.options.endpoint.host)
      this.connectingSocket = socket
      const onError = () => {
        socket.off('close', onClose)
        this.connectingSocket = undefined
        this.connecting = undefined
        reject(this.connectError())
      }
      const onClose = () => {
        socket.off('error', onError)
        this.connectingSocket = undefined
        this.connecting = undefined
        reject(this.disposed ? this.closedError() : this.connectError())
      }
      socket.once('error', onError)
      socket.once('close', onClose)
      socket.once('connect', () => {
        socket.off('error', onError)
        socket.off('close', onClose)
        this.connectingSocket = undefined
        if (this.disposed) {
          socket.destroy()
          reject(this.closedError())
          return
        }
        socket.setEncoding('utf8')
        socket.on('data', (chunk: string) => this.read(chunk))
        socket.on('error', () => undefined)
        socket.on('close', () => this.onClose(socket))
        this.socket = socket
        this.connecting = undefined
        resolve(socket)
        // 恢复绑定在这条实际连接上；旧请求的迟到收尾不能进入下一条连接。
        if (this.subscriptions.size > 0) void this.restoreSubscriptions(socket)
      })
    })
    return this.connecting
  }

  private read(chunk: string): void {
    this.buffer += chunk
    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) {
        this.socket?.destroy()
        return
      }
      if (!isBlank(line.trim())) this.handleFrame(line)
      newlineIndex = this.buffer.indexOf('\n')
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxFrameBytes) {
      this.socket?.destroy()
    }
  }

  private handleFrame(line: string): void {
    let input: unknown
    try {
      input = JSON.parse(line) as unknown
    } catch (error) {
      log.warn('Discarding malformed Kernel RPC frame', { error })
      this.socket?.destroy()
      return
    }
    if ((!isObject(input) && !isNull(input)) || isNull(input)) return
    const type = Reflect.get(input, 'type')
    try {
      if (type === 'response') {
        this.handleResponse(this.decodeResponse(input))
      } else if (type === 'event') {
        void this.handleEvent(this.decodeEventFrame(input))
      }
    } catch (error) {
      log.warn('Discarding invalid Kernel RPC frame', { error })
      this.socket?.destroy()
    }
  }

  private handleResponse(response: KernelRpcResponse): void {
    const pending = this.pending.get(response.requestId)
    if (isUndefined(pending)) return
    this.pending.delete(response.requestId)
    pending.cleanup()
    if (response.status === 'ok') pending.resolve(response.result)
    else pending.reject(fromKernelRpcError(response.error))
  }

  private async handleEvent(frame: KernelRpcEventFrame): Promise<void> {
    const record = this.eventHandlers.get(frame.subscriptionId)
    if (isUndefined(record) || record.disposed) return
    try {
      await record.handler(frame.event)
    } catch (error) {
      log.warn('内核事件回调失败', { error, subscriptionId: frame.subscriptionId })
    }
  }

  private sendCancellation(socket: Socket, targetRequestId: string): void {
    if (socket.destroyed || this.socket !== socket) return
    const requestId = `${process.pid}-${++this.requestSequence}`
    try {
      socket.write(
        `${JSON.stringify({
          type: 'request',
          requestId,
          authToken: this.options.authToken,
          method: 'capability.cancel',
          params: { requestId: targetRequestId },
        })}\n`
      )
    } catch (error) {
      log.debug('Kernel cancellation frame could not be written', { error, targetRequestId })
    }
  }

  private onClose(socket: Socket): void {
    if (this.socket !== socket) return
    this.socket = undefined
    this.buffer = ''
    // 服务端订阅 id 随连接作废，但本地记录留着：下次连上时照原样重建（restoreSubscriptions）。
    this.eventHandlers.clear()
    this.rejectPending(this.disconnectedError())
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup()
      pending.reject(error)
    }
    this.pending.clear()
  }

  /** 解出一帧响应；状态、失败信封或必填字段不合格时抛 INVALID_RESPONSE。 */
  private decodeResponse(input: object): KernelRpcResponse {
    const requestId = this.readRequiredString(input, 'requestId')
    const status = Reflect.get(input, 'status')
    if (status === 'ok')
      return {
        type: 'response',
        requestId,
        status,
        result: Reflect.get(input, 'result'),
      }
    if (status !== 'error') throw this.invalidResponse('RPC status is invalid')
    const errorInput = Reflect.get(input, 'error')
    if ((!isObject(errorInput) && !isNull(errorInput)) || isNull(errorInput)) {
      throw this.invalidResponse('RPC error is missing')
    }
    const retryable = Reflect.get(errorInput, 'retryable')
    if (!isBoolean(retryable)) {
      throw this.invalidResponse('RPC error retryable flag is invalid')
    }
    // details 是服务端交代「为什么失败」的地方（权限拒绝的原因、安装失败的目录与原因……）。
    // 原来这里一律写死 null，服务端说什么都到不了调用方手上。
    const details = Reflect.get(errorInput, 'details')
    return {
      type: 'response',
      requestId,
      status,
      error: {
        code: this.readRequiredString(errorInput, 'code'),
        message: this.readRequiredString(errorInput, 'message', true),
        retryable,
        details: isRecord(details) ? details : null,
      },
    }
  }

  /** 解出一帧服务端推来的事件；事件内容缺失或序号不是整数时抛 INVALID_RESPONSE。 */
  private decodeEventFrame(input: object): KernelRpcEventFrame {
    const eventInput = Reflect.get(input, 'event')
    if ((!isObject(eventInput) && !isNull(eventInput)) || isNull(eventInput)) {
      throw this.invalidResponse('事件帧里没有事件内容')
    }
    const sourceGeneration = Reflect.get(eventInput, 'sourceGeneration')
    const sequence = Reflect.get(eventInput, 'sequence')
    if (!Number.isInteger(sourceGeneration) || !Number.isInteger(sequence)) {
      throw this.invalidResponse('Kernel event sequence is invalid')
    }
    return {
      type: 'event',
      subscriptionId: this.readRequiredString(input, 'subscriptionId'),
      event: {
        type: this.readRequiredString(eventInput, 'type'),
        payload: Reflect.get(eventInput, 'payload'),
        sourceModuleId: this.readRequiredString(eventInput, 'sourceModuleId'),
        sourceGeneration: sourceGeneration as number,
        sequence: sequence as number,
      },
    }
  }

  /** 取一个必填的字符串字段；缺席、类型不对或（不允许空时）为空都抛 INVALID_RESPONSE。 */
  private readRequiredString(input: object, field: string, allowEmpty = false): string {
    const value = Reflect.get(input, field)
    if (isString(value) && (allowEmpty || value.length > 0)) return value
    throw this.invalidResponse(`RPC field "${field}" is invalid`)
  }

  /** 从订阅回应里取出服务端发的订阅 id；取不出抛 INVALID_RESPONSE。 */
  private readSubscriptionId(input: unknown): string {
    if ((!isObject(input) && !isNull(input)) || isNull(input)) {
      throw this.invalidResponse('Subscription result is not an object')
    }
    const subscriptionId = Reflect.get(input, 'subscriptionId')
    if (isString(subscriptionId) && subscriptionId.length > 0) return subscriptionId
    throw this.invalidResponse('Subscription id is missing')
  }

  /** 收到不合协议的帧时的失败；不可重试，重试同一条连接只会再收到同样的垃圾。 */
  private invalidResponse(message: string): KernelClientError {
    return this.localFailure(KernelClientErrorCodes.invalidResponse, message, false)
  }

  /** 传输已回收后的失败；可重试的意思是「换一条连接可以再来」。 */
  private closedError(): KernelClientError {
    return this.localFailure(
      KernelClientErrorCodes.transportClosed,
      SocketKernelTransport.ClosedMessage,
      true
    )
  }

  /** 原连接已经失效；仅由后续业务请求决定是否重连。 */
  private disconnectedError(): KernelClientError {
    return this.localFailure(
      KernelClientErrorCodes.transportDisconnected,
      SocketKernelTransport.DisconnectedMessage,
      true
    )
  }

  /** 连不上端点时的失败。 */
  private connectError(): KernelClientError {
    return this.localFailure(
      KernelClientErrorCodes.transportConnectFailed,
      SocketKernelTransport.ConnectFailedMessage,
      true
    )
  }

  /**
   * 本地产生的失败（连不上、已关闭、帧不合法）包成客户端错误。
   *
   * `details` 里带上这条传输连的端点：一个进程里同时挂着几台内核时，光看文案分不出是哪条
   * 连接出的问题。
   */
  private localFailure(code: string, message: string, retryable: boolean): KernelClientError {
    const endpoint = this.options.endpoint
    return fromKernelRpcError({
      code,
      message,
      retryable,
      details: {
        endpoint: endpoint.kind === 'unix' ? endpoint.path : `${endpoint.host}:${endpoint.port}`,
      },
    })
  }
}
