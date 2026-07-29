import {
  createConnection,
  type Socket,
} from 'node:net'

import {
  createCapabilityToken,
  createKernelCallableCapability,
  type KernelCapabilityOperationMetadata,
  type KernelModuleActivateContext,
  type KernelModuleDefinition,
  type KernelModuleLifecycle,
  type ScopeRef,
} from '../abi'

import type { KernelModuleIsolationAdapter } from './isolation'

export interface HostBridgeEndpoint {
  readonly kind: 'unix'
  readonly path: string
}

export type HostBridgeRpcMethod =
  | 'ping'
  | 'capability.metadata'
  | 'capability.invoke'

export interface HostBridgeRpcRequest {
  readonly type: 'request'
  readonly requestId: string
  readonly method: HostBridgeRpcMethod
  readonly params: unknown
}

export interface HostBridgeCancelFrame {
  readonly type: 'cancel'
  readonly requestId: string
}

export interface HostBridgeEventFrame {
  readonly type: 'event'
  readonly requestId: string
  readonly eventType: string
  readonly payload: unknown
}

export interface HostBridgeRpcSuccess {
  readonly type: 'response'
  readonly requestId: string
  readonly status: 'ok'
  readonly result: unknown
}

export interface HostBridgeRpcFailure {
  readonly type: 'response'
  readonly requestId: string
  readonly status: 'error'
  readonly error: {
    readonly code: string
    readonly message: string
    readonly retryable: boolean
  }
}

export type HostBridgeRpcResponse = HostBridgeRpcSuccess | HostBridgeRpcFailure

export type HostBridgeOnEvent = (
  eventType: string,
  payload: unknown,
) => void | Promise<void>

interface PendingRequest {
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
  readonly onEvent?: HostBridgeOnEvent
}

/**
 * Kernel-side client for a product HostBridge Unix socket.
 */
export class HostBridgeClient {
  private readonly pending = new Map<string, PendingRequest>()
  private socket?: Socket
  private connecting?: Promise<Socket>
  private buffer = ''
  private sequence = 0
  private disposed = false

  public constructor(private readonly endpoint: HostBridgeEndpoint) {}

  public async ping(): Promise<void> {
    await this.request('ping', null)
  }

  public async getOperationMetadata(
    capabilityId: string,
    operation: string,
  ): Promise<KernelCapabilityOperationMetadata | null> {
    const result = await this.request('capability.metadata', {
      capabilityId,
      operation,
    })
    if (result === null) return null
    if (typeof result !== 'object' || result === null) {
      throw new Error('HostBridge metadata result is invalid')
    }
    const permissions = Reflect.get(result, 'permissions')
    if (!Array.isArray(permissions)) {
      throw new Error('HostBridge metadata permissions are invalid')
    }
    return {
      permissions: permissions.filter(
        (item): item is string => typeof item === 'string',
      ),
      ...(typeof Reflect.get(result, 'reason') === 'string'
        ? { reason: Reflect.get(result, 'reason') as string }
        : {}),
    }
  }

  public async invoke(
    capabilityId: string,
    operation: string,
    scope: ScopeRef | undefined,
    input: unknown,
    signal?: AbortSignal,
    onEvent?: HostBridgeOnEvent,
  ): Promise<unknown> {
    if (signal?.aborted) {
      throw new DOMException('HostBridge invoke aborted', 'AbortError')
    }
    return this.request(
      'capability.invoke',
      {
        capabilityId,
        operation,
        scope: scope ?? null,
        input,
      },
      signal,
      onEvent,
    )
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.socket?.destroy()
    this.socket = undefined
    this.connecting = undefined
    for (const pending of this.pending.values()) {
      pending.reject(new Error('HostBridge client disposed'))
    }
    this.pending.clear()
  }

  private async request(
    method: HostBridgeRpcMethod,
    params: unknown,
    signal?: AbortSignal,
    onEvent?: HostBridgeOnEvent,
  ): Promise<unknown> {
    if (this.disposed) throw new Error('HostBridge client is disposed')
    const socket = await this.connect()
    const requestId = `hb-${process.pid}-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.has(requestId)) return
        try {
          socket.write(
            `${JSON.stringify({
              type: 'cancel',
              requestId,
            } satisfies HostBridgeCancelFrame)}\n`,
          )
        } catch {
          // Best-effort cancel; response path still rejects below.
        }
        this.pending.delete(requestId)
        reject(new DOMException('HostBridge invoke aborted', 'AbortError'))
      }

      if (signal !== undefined && signal.aborted) {
        onAbort()
        return
      }

      this.pending.set(requestId, {
        onEvent,
        resolve: (result) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(result)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
      signal?.addEventListener('abort', onAbort, { once: true })

      try {
        socket.write(
          `${JSON.stringify({
            type: 'request',
            requestId,
            method,
            params,
          } satisfies HostBridgeRpcRequest)}\n`,
        )
      } catch (error) {
        this.pending.delete(requestId)
        signal?.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private connect(): Promise<Socket> {
    if (this.socket !== undefined && !this.socket.destroyed)
      return Promise.resolve(this.socket)
    if (this.connecting !== undefined) return this.connecting

    this.connecting = new Promise((resolve, reject) => {
      const socket = createConnection(this.endpoint.path)
      const onError = (error: Error) => {
        this.connecting = undefined
        reject(error)
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.off('error', onError)
        if (this.disposed) {
          socket.destroy()
          reject(new Error('HostBridge client disposed'))
          return
        }
        socket.setEncoding('utf8')
        socket.on('data', (chunk: string) => this.read(chunk))
        socket.on('error', () => undefined)
        socket.on('close', () => {
          if (this.socket === socket) this.socket = undefined
          this.rejectPending(new Error('HostBridge connection closed'))
        })
        this.socket = socket
        this.connecting = undefined
        resolve(socket)
      })
    })
    return this.connecting
  }

  private read(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim().length > 0) this.handleFrame(line)
      index = this.buffer.indexOf('\n')
    }
  }

  private handleFrame(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const type = Reflect.get(parsed, 'type')
    const requestId = Reflect.get(parsed, 'requestId')
    if (typeof requestId !== 'string') return

    if (type === 'event') {
      const pending = this.pending.get(requestId)
      if (pending?.onEvent === undefined) return
      const eventType = Reflect.get(parsed, 'eventType')
      if (typeof eventType !== 'string') return
      void Promise.resolve(
        pending.onEvent(eventType, Reflect.get(parsed, 'payload')),
      ).catch(() => undefined)
      return
    }

    if (type !== 'response') return
    const pending = this.pending.get(requestId)
    if (pending === undefined) return
    this.pending.delete(requestId)
    const status = Reflect.get(parsed, 'status')
    if (status === 'ok') {
      pending.resolve(Reflect.get(parsed, 'result'))
      return
    }
    const error = Reflect.get(parsed, 'error')
    const message = typeof error === 'object' && error !== null
      && typeof Reflect.get(error, 'message') === 'string'
      ? Reflect.get(error, 'message') as string
      : 'HostBridge request failed'
    const code = typeof error === 'object' && error !== null
      && typeof Reflect.get(error, 'code') === 'string'
      ? Reflect.get(error, 'code') as string
      : 'HOST_BRIDGE_ERROR'
    pending.reject(Object.assign(new Error(message), { code }))
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

export interface SidecarIsolationAdapterOptions {
  readonly endpoint: HostBridgeEndpoint
  /** When bridge is unreachable, register throwing stubs so Host can still start. */
  readonly allowOfflineFallback?: boolean
}

/**
 * Isolation adapter that proxies module-provided capabilities to a product HostBridge.
 */
export class SidecarIsolationAdapter implements KernelModuleIsolationAdapter {
  public readonly isolation = 'sidecar' as const
  private readonly client: HostBridgeClient
  private readonly allowOfflineFallback: boolean

  public constructor(options: SidecarIsolationAdapterOptions) {
    this.client = new HostBridgeClient(options.endpoint)
    this.allowOfflineFallback = options.allowOfflineFallback === true
  }

  public async activate(
    module: KernelModuleDefinition,
    context: KernelModuleActivateContext,
  ): Promise<KernelModuleLifecycle | void> {
    try {
      await this.client.ping()
    } catch (error) {
      if (!this.allowOfflineFallback) throw error
      for (const token of module.manifest.provides) {
        context.registerService(
          createCapabilityToken(token.id, token.version),
          createOfflineStub(token.id),
        )
      }
      return {
        dispose: async () => {
          await this.client.dispose()
        },
      }
    }

    const publishEvent: HostBridgeOnEvent = async (eventType, payload) => {
      await context.events.publish(eventType, payload)
    }
    for (const token of module.manifest.provides) {
      const capabilityId = token.id
      const version = token.version
      const operations = await discoverBridgeOperations(this.client, capabilityId)
      const table: Record<
        string,
        {
          metadata: KernelCapabilityOperationMetadata
          invoke: (
            scope: ScopeRef | undefined,
            input: unknown,
            signal: AbortSignal,
          ) => Promise<unknown>
        }
      > = {}
      for (const [operation, metadata] of Object.entries(operations)) {
        table[operation] = {
          metadata,
          invoke: (scope, input, signal) =>
            this.client.invoke(
              capabilityId,
              operation,
              scope,
              input,
              signal,
              publishEvent,
            ),
        }
      }
      context.registerService(
        createCapabilityToken(capabilityId, version),
        createBridgeProxyService(this.client, capabilityId, table, publishEvent),
      )
    }

    return {
      dispose: async () => {
        await this.client.dispose()
      },
    }
  }
}

function createOfflineStub(capabilityId: string) {
  return createKernelCallableCapability({
    health: {
      metadata: { permissions: [] },
      invoke: () => ({
        status: 'degraded',
        message: `HostBridge offline for ${capabilityId}`,
      }),
    },
  })
}

function createBridgeProxyService(
  client: HostBridgeClient,
  capabilityId: string,
  known: Record<
    string,
    {
      metadata: KernelCapabilityOperationMetadata
      invoke: (
        scope: ScopeRef | undefined,
        input: unknown,
        signal: AbortSignal,
      ) => Promise<unknown>
    }
  >,
  publishEvent: HostBridgeOnEvent,
) {
  return {
    getOperationMetadata(operation: string) {
      if (known[operation] !== undefined) return known[operation].metadata
      return { permissions: [] }
    },
    async invoke(
      operation: string,
      scope: ScopeRef | undefined,
      input: unknown,
      signal: AbortSignal,
    ) {
      if (known[operation] !== undefined)
        return known[operation].invoke(scope, input, signal)
      return client.invoke(
        capabilityId,
        operation,
        scope,
        input,
        signal,
        publishEvent,
      )
    },
  }
}

async function discoverBridgeOperations(
  client: HostBridgeClient,
  capabilityId: string,
): Promise<Record<string, KernelCapabilityOperationMetadata>> {
  const candidates = [
    'health',
    'execute',
    'supports_provider',
    'open_page',
    'navigate_page',
    'get_page_state',
    'close_session',
    'close_all_sessions',
  ]
  const found: Record<string, KernelCapabilityOperationMetadata> = {}
  for (const operation of candidates) {
    try {
      const metadata = await client.getOperationMetadata(capabilityId, operation)
      if (metadata !== null) found[operation] = metadata
    } catch {
      // Bridge may not implement metadata for this op yet.
    }
  }
  return found
}

export function createSidecarIsolationAdapter(
  options: SidecarIsolationAdapterOptions,
): KernelModuleIsolationAdapter {
  return new SidecarIsolationAdapter(options)
}

export function parseHostBridgeEndpoint(
  value: string | undefined,
): HostBridgeEndpoint | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed.length === 0) return undefined
  return { kind: 'unix', path: trimmed }
}

/** Shared well-known Desktop HostBridge socket path. */
export function defaultHostBridgeSocketPath(home = process.env.HOME): string {
  const root = home !== undefined && home.trim().length > 0 ? home.trim() : '/tmp'
  return `${root}/.velaros/host-bridge.sock`
}
