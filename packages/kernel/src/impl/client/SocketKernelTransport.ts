import {
  createConnection,
  type Socket,
} from 'node:net'

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

import type { KernelRpcEndpoint } from '../../types/client-endpoint'
import type {
  KernelRpcEventFrame,
  KernelRpcMethod,
  KernelRpcResponse,
} from '../../types/client-rpc-frames'
import type {
  KernelClientEventHandler,
  KernelClientTransport,
  KernelEventSubscription,
} from '../../types/client-transport'
import type { KernelServiceHealth } from '../../types/service-health'
import { KernelRpcClientError } from '../../utils/errors-client'
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

interface PendingRequest {
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
  readonly cleanup: () => void
}

/**
 * 一条订阅的本地记录。
 *
 * `subscriptionId` 是服务端发的，断线重连后会换一个，所以它是**可变字段**：本地记录才是
 * 订阅的身份，`dispose()` 关掉的始终是这条记录当前对应的那个服务端订阅。
 */
interface EventSubscriptionRecord {
  readonly eventType: string
  readonly handler: KernelClientEventHandler
  subscriptionId: string
  disposed: boolean
}

export interface SocketKernelTransportOptions {
  readonly authToken: string
  readonly endpoint: KernelRpcEndpoint
  readonly maxFrameBytes?: number
}

/**
 * Persistent local RPC transport supporting concurrent requests, cancellation,
 * identity APIs, and server-pushed Kernel events.
 */
export class SocketKernelTransport implements KernelClientTransport {
  private readonly pending = new Map<string, PendingRequest>()
  /** 服务端订阅 id → 本地记录；断线时清空（id 随连接作废）。 */
  private readonly eventHandlers = new Map<string, EventSubscriptionRecord>()
  /** 还活着的本地订阅记录；跨断线保留，重连后照原样重建。 */
  private readonly subscriptions = new Set<EventSubscriptionRecord>()
  private readonly maxFrameBytes: number
  private socket?: Socket
  private connecting?: Promise<Socket>
  private connectingSocket?: Socket
  private buffer = ''
  private requestSequence = 0
  private disposed = false

  public constructor(private readonly options: SocketKernelTransportOptions) {
    this.maxFrameBytes = options.maxFrameBytes ?? 4 * 1024 * 1024
  }

  public async handshake(): Promise<KernelHandshake> {
    return KernelHandshakeSchema.parse(
      await this.request('handshake', null),
    )
  }

  public async health(): Promise<KernelServiceHealth> {
    return await this.request('health', null) as KernelServiceHealth
  }

  public async openCapabilitySession(
    request: CapabilitySessionOpenRequest,
  ): Promise<CapabilitySessionOpenResponse> {
    return CapabilitySessionOpenResponseSchema.parse(
      await this.request('capability.session.open', request),
    )
  }

  public async closeCapabilitySession(
    request: CapabilitySessionCloseRequest,
  ): Promise<CapabilitySessionCloseResponse> {
    return CapabilitySessionCloseResponseSchema.parse(
      await this.request('capability.session.close', request),
    )
  }

  public async call(
    request: CapabilityCallRequest,
    signal?: AbortSignal,
  ): Promise<CapabilityCallResponse> {
    return CapabilityCallResponseSchema.parse(
      await this.request('capability.call', request, signal),
    )
  }

  public async listMods(request: ModsListRequest): Promise<ModsListResponse> {
    return ModsListResponseSchema.parse(
      await this.request('mods.list', request),
    )
  }

  public async setModEnabled(
    request: ModsSetEnabledRequest,
  ): Promise<ModsSetEnabledResponse> {
    return ModsSetEnabledResponseSchema.parse(
      await this.request('mods.setEnabled', request),
    )
  }

  public async installModFromDirectory(
    request: ModsInstallFromDirectoryRequest,
  ): Promise<ModsInstallFromDirectoryResponse> {
    return ModsInstallFromDirectoryResponseSchema.parse(
      await this.request('mods.installFromDirectory', request),
    )
  }

  public async subscribe(
    eventType: string,
    handler: KernelClientEventHandler,
  ): Promise<KernelEventSubscription> {
    const result = await this.request('events.subscribe', { eventType })
    const record: EventSubscriptionRecord = {
      eventType,
      handler,
      subscriptionId: readSubscriptionId(result),
      disposed: false,
    }
    this.subscriptions.add(record)
    this.eventHandlers.set(record.subscriptionId, record)
    return {
      dispose: async () => {
        if (record.disposed) return
        record.disposed = true
        this.subscriptions.delete(record)
        this.eventHandlers.delete(record.subscriptionId)
        if (this.disposed) return
        await this.request('events.unsubscribe', {
          subscriptionId: record.subscriptionId,
        })
      },
    }
  }

  /**
   * 重连之后把还活着的订阅重新建起来。
   *
   * 断线时服务端的订阅连同它的 id 一起没了，而 `request()` 会在下一次调用时自动重连——
   * 结果就是「连接自己恢复了、订阅悄悄失效了，调用方一无所知」。这里跟着连接一起恢复；
   * 某一条恢复不了就记错误日志，不影响别的订阅，也不拖累触发重连的那次请求。
   */
  private async restoreSubscriptions(): Promise<void> {
    for (const record of [...this.subscriptions]) {
      if (record.disposed || this.disposed) continue
      try {
        const result = await this.request('events.subscribe', {
          eventType: record.eventType,
        })
        if (record.disposed) continue
        record.subscriptionId = readSubscriptionId(result)
        this.eventHandlers.set(record.subscriptionId, record)
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
    this.eventHandlers.clear()
    this.subscriptions.clear()
    const socket = this.socket
    const connectingSocket = this.connectingSocket
    this.socket = undefined
    this.connecting = undefined
    this.connectingSocket = undefined
    socket?.destroy()
    connectingSocket?.destroy()
    this.rejectPending(
      new KernelRpcClientError({
        code: 'TRANSPORT_CLOSED',
        message: 'Kernel RPC transport is closed',
        retryable: true,
        details: null,
      }),
    )
  }

  private async request(
    method: KernelRpcMethod,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.disposed) {
      throw new KernelRpcClientError({
        code: 'TRANSPORT_CLOSED',
        message: 'Kernel RPC transport is closed',
        retryable: true,
        details: null,
      })
    }
    if (isSignalAborted(signal)) throw abortError()
    const socket = await this.connect()
    if (this.disposed) throw transportClosedError()
    if (isSignalAborted(signal)) throw abortError()
    const requestId = `${process.pid}-${++this.requestSequence}`

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(requestId)
        reject(abortError())
        this.sendCancellation(requestId)
      }
      const cleanup = () => signal?.removeEventListener('abort', onAbort)
      this.pending.set(requestId, { resolve, reject, cleanup })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        socket.write(
          `${JSON.stringify({
            type: 'request',
            requestId,
            authToken: this.options.authToken,
            method,
            params,
          })}\n`,
        )
      } catch {
        this.pending.delete(requestId)
        cleanup()
        reject(new KernelRpcClientError({
          code: 'TRANSPORT_WRITE_FAILED',
          message: 'Kernel RPC request could not be sent',
          retryable: true,
          details: null,
        }))
      }
    })
  }

  private connect(): Promise<Socket> {
    if (isNotUndefined(this.socket) && !this.socket.destroyed) return Promise.resolve(this.socket)
    if (isNotUndefined(this.connecting)) return this.connecting

    this.connecting = new Promise((resolve, reject) => {
      const socket = this.options.endpoint.kind === 'unix'
        ? createConnection(this.options.endpoint.path)
        : createConnection(
            this.options.endpoint.port,
            this.options.endpoint.host,
          )
      this.connectingSocket = socket
      const onError = () => {
        socket.off('close', onClose)
        this.connectingSocket = undefined
        this.connecting = undefined
        reject(transportConnectError())
      }
      const onClose = () => {
        socket.off('error', onError)
        this.connectingSocket = undefined
        this.connecting = undefined
        reject(
          this.disposed
            ? transportClosedError()
            : transportConnectError(),
        )
      }
      socket.once('error', onError)
      socket.once('close', onClose)
      socket.once('connect', () => {
        socket.off('error', onError)
        socket.off('close', onClose)
        this.connectingSocket = undefined
        if (this.disposed) {
          socket.destroy()
          reject(transportClosedError())
          return
        }
        socket.setEncoding('utf8')
        socket.on('data', (chunk: string) => this.read(chunk))
        socket.on('error', () => undefined)
        socket.on('close', () => this.onClose(socket))
        this.socket = socket
        this.connecting = undefined
        resolve(socket)
        // 连接已经就绪（socket 已挂上），恢复订阅走的是普通请求，不会再触发一次连接。
        if (this.subscriptions.size > 0) void this.restoreSubscriptions()
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
    if (!isObject(input) && !isNull(input) || isNull(input)) return
    const type = Reflect.get(input, 'type')
    try {
      if (type === 'response') {
        this.handleResponse(decodeResponse(input))
      } else if (type === 'event') {
        this.handleEvent(decodeEventFrame(input))
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
    else pending.reject(new KernelRpcClientError(response.error))
  }

  private handleEvent(frame: KernelRpcEventFrame): void {
    const record = this.eventHandlers.get(frame.subscriptionId)
    if (isUndefined(record) || record.disposed) return
    void Promise.resolve(record.handler(frame.event)).catch((error) => {
      log.warn('Kernel event handler failed', { error, subscriptionId: frame.subscriptionId })
    })
  }

  private sendCancellation(targetRequestId: string): void {
    if (isUndefined(this.socket) || this.socket.destroyed) return
    const requestId = `${process.pid}-${++this.requestSequence}`
    try {
      this.socket.write(
        `${JSON.stringify({
          type: 'request',
          requestId,
          authToken: this.options.authToken,
          method: 'capability.cancel',
          params: { requestId: targetRequestId },
        })}\n`,
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
    this.rejectPending(
      new KernelRpcClientError({
        code: 'TRANSPORT_DISCONNECTED',
        message: 'Kernel RPC connection closed',
        retryable: true,
        details: null,
      }),
    )
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup()
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function decodeResponse(input: object): KernelRpcResponse {
  const requestId = readRequiredString(input, 'requestId')
  const status = Reflect.get(input, 'status')
  if (status === 'ok') return {
      type: 'response',
      requestId,
      status,
      result: Reflect.get(input, 'result'),
    }
  if (status !== 'error') throw invalidResponse('RPC status is invalid')
  const errorInput = Reflect.get(input, 'error')
  if (!isObject(errorInput) && !isNull(errorInput) || isNull(errorInput)) {
    throw invalidResponse('RPC error is missing')
  }
  const retryable = Reflect.get(errorInput, 'retryable')
  if (!isBoolean(retryable)) {
    throw invalidResponse('RPC error retryable flag is invalid')
  }
  // details 是服务端交代「为什么失败」的地方（权限拒绝的原因、安装失败的目录与原因……）。
  // 原来这里一律写死 null，服务端说什么都到不了调用方手上。
  const details = Reflect.get(errorInput, 'details')
  return {
    type: 'response',
    requestId,
    status,
    error: {
      code: readRequiredString(errorInput, 'code'),
      message: readRequiredString(errorInput, 'message', true),
      retryable,
      details: isRecord(details) ? details : null,
    },
  }
}

function decodeEventFrame(input: object): KernelRpcEventFrame {
  const eventInput = Reflect.get(input, 'event')
  if (!isObject(eventInput) && !isNull(eventInput) || isNull(eventInput)) {
    throw invalidResponse('Kernel event is missing')
  }
  const sourceGeneration = Reflect.get(eventInput, 'sourceGeneration')
  const sequence = Reflect.get(eventInput, 'sequence')
  if (
    !Number.isInteger(sourceGeneration)
    || !Number.isInteger(sequence)
  ) {
    throw invalidResponse('Kernel event sequence is invalid')
  }
  return {
    type: 'event',
    subscriptionId: readRequiredString(input, 'subscriptionId'),
    event: {
      type: readRequiredString(eventInput, 'type'),
      payload: Reflect.get(eventInput, 'payload'),
      sourceModuleId: readRequiredString(eventInput, 'sourceModuleId'),
      sourceGeneration: sourceGeneration as number,
      sequence: sequence as number,
    },
  }
}

function readRequiredString(
  input: object,
  field: string,
  allowEmpty = false,
): string {
  const value = Reflect.get(input, field)
  if (
    isString(value)
    && (allowEmpty || value.length > 0)
  ) return value
  throw invalidResponse(`RPC field "${field}" is invalid`)
}

function readSubscriptionId(input: unknown): string {
  if (!isObject(input) && !isNull(input) || isNull(input)) {
    throw invalidResponse('Subscription result is not an object')
  }
  const subscriptionId = Reflect.get(input, 'subscriptionId')
  if (isString(subscriptionId) && subscriptionId.length > 0) return subscriptionId
  throw invalidResponse('Subscription id is missing')
}

function invalidResponse(message: string): KernelRpcClientError {
  return new KernelRpcClientError({
    code: 'INVALID_RESPONSE',
    message,
    retryable: false,
    details: null,
  })
}

function abortError(): Error {
  return new DOMException('Kernel RPC request aborted', 'AbortError')
}

function isSignalAborted(signal: LooseOptional<AbortSignal>): boolean {
  return isTrue(signal?.aborted)
}

function transportClosedError(): KernelRpcClientError {
  return new KernelRpcClientError({
    code: 'TRANSPORT_CLOSED',
    message: 'Kernel RPC transport is closed',
    retryable: true,
    details: null,
  })
}

function transportConnectError(): KernelRpcClientError {
  return new KernelRpcClientError({
    code: 'TRANSPORT_CONNECT_FAILED',
    message: 'Kernel RPC endpoint is unavailable',
    retryable: true,
    details: null,
  })
}
