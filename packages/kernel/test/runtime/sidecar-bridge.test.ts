import { chmod, mkdir, unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { createCapabilityToken } from '../../src/contracts/abi/capability'
import { defineKernelModule } from '../../src/contracts/abi/module'
import { KernelCapabilityInvoker } from '../../src/runtime/capability-invocation'
import { KernelModuleHost } from '../../src/runtime/host/KernelModuleHost'
import {
  HostBridgeClient,
  SidecarIsolationAdapter,
} from '../../src/runtime/host/sidecar-bridge'

/**
 * 桥这一侧「登记过」的操作名。
 *
 * `execute` 在适配器的探测清单里，`echo` 不在：两者一起用来把「探测得到 → 可调用」和
 * 「探测不到 → 一律拒绝」两条分支分开。
 */
const ProbedBridgeOperation = 'execute'
const UnprobedBridgeOperation = 'echo'

function isEchoOperation(operation: LooseOptional<string>): boolean {
  return operation === ProbedBridgeOperation
    || operation === UnprobedBridgeOperation
}

class MiniHostBridgeServer {
  private readonly socketPath: string
  private readonly server: Server
  private readonly sockets = new Set<Socket>()
  private readonly inflight = new Map<string, AbortController>()
  private started = false
  /** 桥这一侧真正收到的 `capability.invoke` 操作名（权限闸有没有被绕过的证据）。 */
  public readonly invokedOperations: string[] = []
  /** 桥为已登记操作声明的权限。 */
  public operationPermissions: readonly string[] = []
  /** When true, echo emits an event frame before resolving. */
  public emitEventOnEcho = false
  /** When true, echo waits until cancelled. */
  public hangUntilCancel = false

  public constructor(socketPath: string) {
    this.socketPath = socketPath
    this.server = createServer((socket) => this.accept(socket))
  }

  public get path(): string {
    return this.socketPath
  }

  public async start(): Promise<void> {
    if (this.started) return
    await mkdir(tmpdir(), { recursive: true })
    await unlink(this.socketPath).catch(() => undefined)
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.socketPath, () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    await chmod(this.socketPath, 0o600)
    this.started = true
  }

  public async dispose(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
    })
    await unlink(this.socketPath).catch(() => undefined)
    this.started = false
  }

  private accept(socket: Socket): void {
    socket.setEncoding('utf8')
    this.sockets.add(socket)
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim().length > 0) void this.handleLine(socket, line)
        index = buffer.indexOf('\n')
      }
    })
    socket.on('close', () => this.sockets.delete(socket))
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let requestId = 'invalid'
    try {
      const raw = JSON.parse(line) as Record<string, unknown>
      requestId = typeof raw.requestId === 'string' ? raw.requestId : 'invalid'
      if (raw.type === 'cancel') {
        this.inflight.get(requestId)?.abort()
        return
      }
      const method = raw.method
      let result: unknown = null
      if (method === 'ping') {
        result = { ok: true }
      } else if (method === 'capability.metadata') {
        const params = raw.params as { operation?: string }
        result = isEchoOperation(params.operation)
          ? { permissions: [...this.operationPermissions], reason: 'echo' }
          : null
      } else if (method === 'capability.invoke') {
        const params = raw.params as {
          operation?: string
          input?: unknown
        }
        this.invokedOperations.push(params.operation ?? '<missing>')
        if (!isEchoOperation(params.operation)) {
          throw Object.assign(new Error('unknown op'), { code: 'UNKNOWN_OP' })
        }
        if (this.emitEventOnEcho) {
          socket.write(
            `${JSON.stringify({
              type: 'event',
              requestId,
              eventType: 'test.echo.event',
              payload: { echoed: params.input },
            })}\n`,
          )
        }
        if (this.hangUntilCancel) {
          const controller = new AbortController()
          this.inflight.set(requestId, controller)
          try {
            await new Promise<void>((resolve, reject) => {
              if (controller.signal.aborted) {
                reject(new DOMException('aborted', 'AbortError'))
                return
              }
              controller.signal.addEventListener(
                'abort',
                () => reject(new DOMException('aborted', 'AbortError')),
                { once: true },
              )
            })
          } finally {
            this.inflight.delete(requestId)
          }
        }
        result = { echoed: params.input }
      } else {
        throw Object.assign(new Error('unknown method'), {
          code: 'METHOD_NOT_FOUND',
        })
      }
      socket.write(
        `${JSON.stringify({
          type: 'response',
          requestId,
          status: 'ok',
          result,
        })}\n`,
      )
    } catch (error) {
      const aborted =
        error instanceof DOMException && error.name === 'AbortError'
      socket.write(
        `${JSON.stringify({
          type: 'response',
          requestId,
          status: 'error',
          error: {
            code: aborted
              ? 'CALL_ABORTED'
              : typeof error === 'object' &&
                  error !== null &&
                  typeof Reflect.get(error, 'code') === 'string'
                ? Reflect.get(error, 'code')
                : 'HOST_BRIDGE_ERROR',
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        })}\n`,
      )
    }
  }
}

describe('HostBridge sidecar', () => {
  const sockets: MiniHostBridgeServer[] = []

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((server) => server.dispose()))
  })

  test('client pings and invokes through the bridge', async () => {
    const path = join(tmpdir(), `velaros-sidecar-test-${process.pid}-${Date.now()}.sock`)
    const server = new MiniHostBridgeServer(path)
    sockets.push(server)
    await server.start()

    const client = new HostBridgeClient({ kind: 'unix', path })
    await client.ping()
    const metadata = await client.getOperationMetadata('test.echo', 'echo')
    expect(metadata?.permissions).toEqual([])
    const result = await client.invoke(
      'test.echo',
      'echo',
      undefined,
      { value: 42 },
      new AbortController().signal,
    )
    expect(result).toEqual({ echoed: { value: 42 } })
    await client.dispose()
  })

  test('sidecar adapter registers bridge-backed capability', async () => {
    const path = join(tmpdir(), `velaros-sidecar-host-${process.pid}-${Date.now()}.sock`)
    const server = new MiniHostBridgeServer(path)
    sockets.push(server)
    await server.start()

    const adapter = new SidecarIsolationAdapter({
      endpoint: { kind: 'unix', path },
    })
    const host = new KernelModuleHost({
      apiVersion: 1,
      isolationAdapters: [adapter],
    })
    host.registerModules([
      defineKernelModule({
        manifest: {
          id: 'module.echo.sidecar',
          version: '1.0.0',
          apiVersion: 1,
          provides: [createCapabilityToken('test.echo')],
          requires: [],
          optionalRequires: [],
          permissions: [],
          isolation: 'sidecar',
        },
        activate() {
          throw new Error('sidecar activate must not run locally')
        },
      }),
    ])
    await host.start()
    const service = host.getService(createCapabilityToken('test.echo')) as {
      getOperationMetadata(operation: string): unknown
      invoke(
        operation: string,
        scope: undefined,
        input: unknown,
        signal: AbortSignal,
      ): Promise<unknown>
    }
    expect(service.getOperationMetadata(ProbedBridgeOperation)).toEqual({
      permissions: [],
      reason: 'echo',
    })
    const result = await service.invoke(
      ProbedBridgeOperation,
      undefined,
      { hello: 'world' },
      new AbortController().signal,
    )
    expect(result).toEqual({ echoed: { hello: 'world' } })
    await host.dispose()
  })

  test('sidecar adapter denies operations the bridge never declared', async () => {
    const path = join(tmpdir(), `velaros-sidecar-deny-${process.pid}-${Date.now()}.sock`)
    const server = new MiniHostBridgeServer(path)
    server.operationPermissions = ['bridge:execute']
    sockets.push(server)
    await server.start()

    const askedPermissions: string[] = []
    const host = new KernelModuleHost({
      apiVersion: 1,
      isolationAdapters: [
        new SidecarIsolationAdapter({ endpoint: { kind: 'unix', path } }),
      ],
      permissionBroker: {
        request: async (request) => {
          askedPermissions.push(request.permission)
          return { status: 'granted' }
        },
      },
    })
    host.registerModules([
      defineKernelModule({
        manifest: {
          id: 'module.deny.sidecar',
          version: '1.0.0',
          apiVersion: 1,
          provides: [createCapabilityToken('test.deny')],
          requires: [],
          optionalRequires: [],
          permissions: ['bridge:execute'],
          isolation: 'sidecar',
        },
        activate() {
          throw new Error('sidecar activate must not run locally')
        },
      }),
    ])
    await host.start()
    const invoker = new KernelCapabilityInvoker(host)

    // 桥没有登记过的操作：连元数据都不该有，否则调用器会把它当成「零权限操作」。
    const service = host.getService(createCapabilityToken('test.deny')) as {
      getOperationMetadata(operation: string): unknown
    }
    expect(service.getOperationMetadata('delete_everything')).toBeUndefined()
    // `toString` 这类继承键同样在白名单之外。
    expect(service.getOperationMetadata('toString')).toBeUndefined()

    await expect(
      invoker.invoke({
        capabilityId: 'test.deny',
        operation: 'delete_everything',
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      name: 'UnknownKernelCapabilityOperationError',
    })

    // 拒绝发生在权限闸之前，而且桥那一侧一次都没被调到。
    expect(askedPermissions).toEqual([])
    expect(server.invokedOperations).toEqual([])

    // 直接打服务面（绕开调用器）也必须拒绝。
    const callable = host.getService(createCapabilityToken('test.deny')) as {
      invoke(
        operation: string,
        scope: undefined,
        input: unknown,
        signal: AbortSignal,
      ): Promise<unknown>
    }
    await expect(
      callable.invoke(
        'delete_everything',
        undefined,
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'UnknownKernelCapabilityOperationError' })
    expect(server.invokedOperations).toEqual([])

    // 探测得到的操作照常走完权限闸再到桥。
    await invoker.invoke({
      capabilityId: 'test.deny',
      operation: ProbedBridgeOperation,
      input: { ok: true },
      signal: new AbortController().signal,
    })
    expect(askedPermissions).toEqual(['bridge:execute'])
    expect(server.invokedOperations).toEqual([ProbedBridgeOperation])

    await host.dispose()
  })

  test('offline fallback registers degraded health stub', async () => {
    const adapter = new SidecarIsolationAdapter({
      endpoint: {
        kind: 'unix',
        path: join(tmpdir(), `velaros-missing-${process.pid}.sock`),
      },
      allowOfflineFallback: true,
    })
    const host = new KernelModuleHost({
      apiVersion: 1,
      isolationAdapters: [adapter],
    })
    host.registerModules([
      defineKernelModule({
        manifest: {
          id: 'module.offline.sidecar',
          version: '1.0.0',
          apiVersion: 1,
          provides: [createCapabilityToken('test.offline')],
          requires: [],
          optionalRequires: [],
          permissions: [],
          isolation: 'sidecar',
        },
        activate() {
          throw new Error('should not activate')
        },
      }),
    ])
    await host.start()
    const service = host.getService(createCapabilityToken('test.offline')) as {
      invoke(
        operation: string,
        scope: undefined,
        input: unknown,
        signal: AbortSignal,
      ): Promise<unknown>
    }
    const health = await service.invoke(
      'health',
      undefined,
      null,
      new AbortController().signal,
    )
    expect(health).toEqual({
      status: 'degraded',
      message: 'HostBridge offline for test.offline',
    })
    await host.dispose()
  })

  test('client forwards bridge events during invoke', async () => {
    const path = join(tmpdir(), `velaros-sidecar-event-${process.pid}-${Date.now()}.sock`)
    const server = new MiniHostBridgeServer(path)
    server.emitEventOnEcho = true
    sockets.push(server)
    await server.start()

    const client = new HostBridgeClient({ kind: 'unix', path })
    const events: Array<{ type: string; payload: unknown }> = []
    const result = await client.invoke(
      'test.echo',
      'echo',
      undefined,
      { value: 7 },
      undefined,
      (eventType, payload) => {
        events.push({ type: eventType, payload })
      },
    )
    expect(result).toEqual({ echoed: { value: 7 } })
    expect(events).toEqual([
      { type: 'test.echo.event', payload: { echoed: { value: 7 } } },
    ])
    await client.dispose()
  })

  test('client cancel aborts a hanging invoke', async () => {
    const path = join(tmpdir(), `velaros-sidecar-cancel-${process.pid}-${Date.now()}.sock`)
    const server = new MiniHostBridgeServer(path)
    server.hangUntilCancel = true
    sockets.push(server)
    await server.start()

    const client = new HostBridgeClient({ kind: 'unix', path })
    const controller = new AbortController()
    const pending = client.invoke(
      'test.echo',
      'echo',
      undefined,
      {},
      controller.signal,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await client.dispose()
  })

  test('sidecar adapter publishes bridge events on the host bus', async () => {
    const path = join(tmpdir(), `velaros-sidecar-bus-${process.pid}-${Date.now()}.sock`)
    const server = new MiniHostBridgeServer(path)
    server.emitEventOnEcho = true
    sockets.push(server)
    await server.start()

    const adapter = new SidecarIsolationAdapter({
      endpoint: { kind: 'unix', path },
    })
    const host = new KernelModuleHost({
      apiVersion: 1,
      isolationAdapters: [adapter],
    })
    host.registerModules([
      defineKernelModule({
        manifest: {
          id: 'module.echo.events',
          version: '1.0.0',
          apiVersion: 1,
          provides: [createCapabilityToken('test.echo')],
          requires: [],
          optionalRequires: [],
          permissions: [],
          isolation: 'sidecar',
        },
        activate() {
          throw new Error('sidecar activate must not run locally')
        },
      }),
    ])
    await host.start()
    const seen: unknown[] = []
    const subscription = host.subscribe('test.echo.event', (event) => {
      seen.push(event.payload)
    })
    const service = host.getService(createCapabilityToken('test.echo')) as {
      invoke(
        operation: string,
        scope: undefined,
        input: unknown,
        signal: AbortSignal,
      ): Promise<unknown>
    }
    await service.invoke(
      ProbedBridgeOperation,
      undefined,
      { ok: true },
      new AbortController().signal,
    )
    expect(seen).toEqual([{ echoed: { ok: true } }])
    subscription.dispose()
    await host.dispose()
  })
})
