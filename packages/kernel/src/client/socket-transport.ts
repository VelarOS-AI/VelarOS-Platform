import {
  createConnection,
  type Socket,
} from 'node:net'

import {
  isArray,
  isBlank,
  isBoolean,
  isNotUndefined,
  isNull,
  isObject,
  isString,
  isTrue,
  isUndefined,
  Log,
} from '@velaros-ai/core'
import type {
  KernelServiceHealth,
  OpenKernelSessionInput,
  StartKernelRunInput,
} from '@velaros-ai/kernel/contracts'
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
  type KernelHandshake,
  KernelHandshakeSchema,
  type KernelRunIdentity,
  KernelRunIdentitySchema,
  type KernelSessionIdentity,
  KernelSessionIdentitySchema,
  type ModsInstallFromDirectoryRequest,
  type ModsInstallFromDirectoryResponse,
  ModsInstallFromDirectoryResponseSchema,
  type ModsListRequest,
  type ModsListResponse,
  ModsListResponseSchema,
  type ModsSetEnabledRequest,
  type ModsSetEnabledResponse,
  ModsSetEnabledResponseSchema,
} from '@velaros-ai/kernel/contracts/protocol'

import type { KernelRpcEndpoint } from './contracts/endpoint'
import type {
  KernelRpcEventFrame,
  KernelRpcMethod,
  KernelRpcResponse,
} from './contracts/rpc-frames'
import { KernelRpcClientError } from './errors'
import type {
  KernelClientEventHandler,
  KernelClientTransport,
  KernelEventSubscription,
} from './transport'

const log = Log.tag('SocketKernelTransport')

interface PendingRequest {
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
  readonly cleanup: () => void
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
  private readonly eventHandlers = new Map<string, KernelClientEventHandler>()
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

  public async openSession(
    input: OpenKernelSessionInput,
  ): Promise<KernelSessionIdentity> {
    return KernelSessionIdentitySchema.parse(
      await this.request('session.open', input),
    )
  }

  public async getSession(
    sessionId: string,
  ): Promise<KernelSessionIdentity | undefined> {
    const result = await this.request('session.get', { sessionId })
    return isNull(result)
      ? undefined
      : KernelSessionIdentitySchema.parse(result)
  }

  public async listSessions(): Promise<readonly KernelSessionIdentity[]> {
    const result = await this.request('session.list', null)
    if (!isArray(result)) {
      throw invalidResponse('Session list is not an array')
    }
    return result.map((identity) =>
      KernelSessionIdentitySchema.parse(identity))
  }

  public async closeSession(sessionId: string): Promise<boolean> {
    return parseBoolean(
      await this.request('session.close', { sessionId }),
    )
  }

  public async startRun(
    input: StartKernelRunInput,
  ): Promise<KernelRunIdentity> {
    return KernelRunIdentitySchema.parse(
      await this.request('run.start', input),
    )
  }

  public async getRun(
    runId: string,
  ): Promise<KernelRunIdentity | undefined> {
    const result = await this.request('run.get', { runId })
    return isNull(result)
      ? undefined
      : KernelRunIdentitySchema.parse(result)
  }

  public async listRuns(): Promise<readonly KernelRunIdentity[]> {
    const result = await this.request('run.list', null)
    if (!isArray(result)) {
      throw invalidResponse('Run list is not an array')
    }
    return result.map((identity) => KernelRunIdentitySchema.parse(identity))
  }

  public async finishRun(runId: string): Promise<boolean> {
    return parseBoolean(await this.request('run.finish', { runId }))
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
    const subscriptionId = readSubscriptionId(result)
    this.eventHandlers.set(subscriptionId, handler)
    let disposed = false
    return {
      dispose: async () => {
        if (disposed) return
        disposed = true
        this.eventHandlers.delete(subscriptionId)
        if (this.disposed) return
        await this.request('events.unsubscribe', { subscriptionId })
      },
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.eventHandlers.clear()
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
    const handler = this.eventHandlers.get(frame.subscriptionId)
    if (isUndefined(handler)) return
    void Promise.resolve(handler(frame.event)).catch((error) => {
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

function parseBoolean(input: unknown): boolean {
  if (isBoolean(input)) return input
  throw invalidResponse('RPC result is not a boolean')
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
  return {
    type: 'response',
    requestId,
    status,
    error: {
      code: readRequiredString(errorInput, 'code'),
      message: readRequiredString(errorInput, 'message', true),
      retryable,
      details: null,
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
