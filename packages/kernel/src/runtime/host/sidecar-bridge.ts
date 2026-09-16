import {
  createConnection,
  type Socket,
} from 'node:net'
import { homedir } from 'node:os'

import {
  isArray,
  isBlank,
  isEmpty,
  isNotNull,
  isNotUndefined,
  isNull,
  isObject,
  isString,
  isTrue,
  isUndefined,
  Log,
  optionalWhen,
  toNullable,
} from '@velaros-ai/core'

import {
  createCapabilityToken,
  createKernelCallableCapability,
  type KernelCapabilityOperationMetadata,
  type KernelModuleActivateContext,
  type KernelModuleDefinition,
  type KernelModuleLifecycle,
  type ScopeRef,
  UnknownKernelCapabilityOperationError,
} from '../../contracts/abi'

import type { KernelModuleIsolationAdapter } from './isolation'

const log = Log.tag('HostBridge')

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
  ): Promise<Nullable<KernelCapabilityOperationMetadata>> {
    const result = await this.request('capability.metadata', {
      capabilityId,
      operation,
    })
    if (isNull(result)) return null
    if (!isObject(result) && !isNull(result) || isNull(result)) {
      throw new Error('HostBridge metadata result is invalid')
    }
    const permissions = Reflect.get(result, 'permissions')
    if (!isArray(permissions)) {
      throw new Error('HostBridge metadata permissions are invalid')
    }
    return {
      permissions: permissions.filter(
        (item): item is string => isString(item),
      ),
      reason: optionalWhen(isString, Reflect.get(result, 'reason')),
    }
  }

  public async invoke(
    capabilityId: string,
    operation: string,
    scope: LooseOptional<ScopeRef>,
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
        scope: toNullable(scope),
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
        } catch (error) {
          log.debug('HostBridge cancellation frame could not be written', { error, requestId })
        }
        this.pending.delete(requestId)
        reject(new DOMException('HostBridge invoke aborted', 'AbortError'))
      }

      if (isNotUndefined(signal) && signal.aborted) {
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
    if (isNotUndefined(this.socket) && !this.socket.destroyed)
      return Promise.resolve(this.socket)
    if (isNotUndefined(this.connecting)) return this.connecting

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
      if (!isBlank(line.trim())) this.handleFrame(line)
      index = this.buffer.indexOf('\n')
    }
  }

  private handleFrame(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch (error) {
      log.warn('Discarding malformed HostBridge frame', { error })
      return
    }
    if (!isObject(parsed) && !isNull(parsed) || isNull(parsed)) return
    const type = Reflect.get(parsed, 'type')
    const requestId = Reflect.get(parsed, 'requestId')
    if (!isString(requestId)) return

    if (type === 'event') {
      const pending = this.pending.get(requestId)
      if (isUndefined(pending?.onEvent)) return
      const eventType = Reflect.get(parsed, 'eventType')
      if (!isString(eventType)) return
      void Promise.resolve(
        pending.onEvent(eventType, Reflect.get(parsed, 'payload')),
      ).catch((error) => {
        log.warn('HostBridge event handler failed', { error, eventType, requestId })
      })
      return
    }

    if (type !== 'response') return
    const pending = this.pending.get(requestId)
    if (isUndefined(pending)) return
    this.pending.delete(requestId)
    const status = Reflect.get(parsed, 'status')
    if (status === 'ok') {
      pending.resolve(Reflect.get(parsed, 'result'))
      return
    }
    const error = Reflect.get(parsed, 'error')
    const message = isObject(error)
      && isString((Reflect.get(error, 'message')))
      ? Reflect.get(error, 'message') as string
      : 'HostBridge request failed'
    const code = isObject(error)
      && isString((Reflect.get(error, 'code')))
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
    this.allowOfflineFallback = isTrue(options.allowOfflineFallback)
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
      const table = new Map<
        string,
        {
          metadata: KernelCapabilityOperationMetadata
          invoke: (
            scope: LooseOptional<ScopeRef>,
            input: unknown,
            signal: AbortSignal,
          ) => Promise<unknown>
        }
      >()
      for (const [operation, metadata] of Object.entries(operations)) {
        table.set(operation, {
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
        })
      }
      context.registerService(
        createCapabilityToken(capabilityId, version),
        createBridgeProxyService(capabilityId, table),
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

/**
 * 桥代理服务：**只有探测到的操作才存在**。
 *
 * ABI 约定（`contracts/abi/callable.ts`）是「`getOperationMetadata` 返回 `undefined` 就在求
 * 权限之前拒绝」。这里一度对未登记的操作返回 `{ permissions: [] }`，等于把任何操作名都当成
 * 零权限操作放行——宿主的权限 broker 一次都问不到，整条权限闸被绕过。现在按白名单来：
 * 表里没有的操作既拿不到元数据，也不会被转发给桥。
 *
 * 表用 `Map`（不是对象字面量）装，`toString`、`constructor` 这类继承键同样落在白名单外。
 */
function createBridgeProxyService(
  capabilityId: string,
  known: ReadonlyMap<
    string,
    {
      metadata: KernelCapabilityOperationMetadata
      invoke: (
        scope: LooseOptional<ScopeRef>,
        input: unknown,
        signal: AbortSignal,
      ) => Promise<unknown>
    }
  >,
) {
  return {
    getOperationMetadata(operation: string) {
      return known.get(operation)?.metadata
    },
    async invoke(
      operation: string,
      scope: LooseOptional<ScopeRef>,
      input: unknown,
      signal: AbortSignal,
    ) {
      const entry = known.get(operation)
      if (isUndefined(entry)) {
        throw new UnknownKernelCapabilityOperationError(capabilityId, operation)
      }
      return entry.invoke(scope, input, signal)
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
      if (isNotNull(metadata)) found[operation] = metadata
    } catch (error) {
      log.debug('HostBridge operation metadata is unavailable', {
        capabilityId,
        error,
        operation,
      })
    }
  }
  return found
}

export function parseHostBridgeEndpoint(
  value: LooseOptional<string>,
): LooseOptional<HostBridgeEndpoint> {
  const trimmed = value?.trim()
  if (isUndefined(trimmed) || isEmpty(trimmed)) return undefined
  return { kind: 'unix', path: trimmed }
}

/**
 * Shared well-known Desktop HostBridge socket path.
 *
 * 用 `os.homedir()` 而不是 `process.env.HOME`：没有 HOME 时原来的 `'/tmp'` 兜底会把 socket
 * 放进共享目录（Windows 上是当前盘根的 `\tmp\`），谁都能建、谁都能顶替。
 */
export function defaultHostBridgeSocketPath(home = homedir()): string {
  const root = isNotUndefined(home) && !isBlank(home.trim()) ? home.trim() : homedir()
  return `${root}/.velaros/host-bridge.sock`
}
