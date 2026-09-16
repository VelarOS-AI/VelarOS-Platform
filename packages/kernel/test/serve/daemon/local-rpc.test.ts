import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import type { KernelModuleDefinition } from '../../../src/contract/requires'
import { kernelDaemons } from '../../../src/impl/client/KernelDaemonDirectory'
import { SocketKernelTransport } from '../../../src/impl/client/SocketKernelTransport'
import { KernelModuleHost } from '../../../src/impl/runtime/KernelModuleHost'
import { kernelModules } from '../../../src/impl/runtime/KernelModuleKit'
import { AllowLoadedKernelClientAccessBroker } from '../../../src/impl/serve/AllowLoadedKernelClientAccessBroker'
import { KernelLocalDaemon } from '../../../src/impl/serve/KernelLocalDaemon'
import { KernelLocalRpcServer } from '../../../src/impl/serve/KernelLocalRpcServer'
import { KernelService } from '../../../src/impl/serve/KernelService'
import { KernelClientError } from '../../../src/utils/errors'
import { createDefaultKernelDaemonPaths } from '../../../src/utils/rpc/descriptor'
import type { CapabilityCallRequest } from '../../../src/utils/wire/capability'
import { KernelProtocolVersion } from '../../../src/utils/wire/version'

const EchoToken = kernelModules.token('test.rpc.echo')
const RpcAuthToken = 'test-auth-token-0123456789-abcdefgh'
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

function createRpcService(): {
  readonly service: KernelService
  readonly call: CapabilityCallRequest
} {
  const host = new KernelModuleHost({ apiVersion: 1 })
  const definition: KernelModuleDefinition = {
    manifest: {
      id: 'module.rpc',
      version: '1.0.0',
      apiVersion: 1,
      provides: [EchoToken],
      requires: [],
      optionalRequires: [],
      permissions: [],
      isolation: 'in-process',
    },
    activate(context) {
      context.registerService(
        EchoToken,
        kernelModules.callable({
          echo: {
            metadata: { permissions: [] },
            async invoke(_scope, input) {
              await context.events.publish('test.rpc.completed', input)
              return input
            },
          },
          wait: {
            metadata: { permissions: [] },
            invoke(_scope, _input, signal) {
              return new Promise((_resolve, reject) => {
                signal.addEventListener(
                  'abort',
                  () => reject(new DOMException('aborted', 'AbortError')),
                  { once: true },
                )
              })
            },
          },
        }),
      )
    },
  }
  host.registerModule(definition)
  return {
    service: new KernelService({
      host,
      kernelVersion: '0.2.0',
      clientAccessBroker: new AllowLoadedKernelClientAccessBroker(host),
    }),
    call: {
      protocolVersion: KernelProtocolVersion,
      callId: 'call-rpc',
      sessionId: 'will-be-overwritten',
      capabilityId: EchoToken.id,
      operation: 'echo',
      scope: null,
      input: { value: 42 },
    },
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'velaros-kernel-rpc-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('Kernel local RPC', () => {
  test.skipIf(process.platform === 'win32')('routes calls, identities, and pushed events over a Unix socket', async () => {
    const directory = await temporaryDirectory()
    const { service, call } = createRpcService()
    const server = new KernelLocalRpcServer({
      authToken: RpcAuthToken,
      endpoint: { kind: 'unix', path: join(directory, 'kernel.sock') },
      service,
    })
    const endpoint = await server.start()
    const transport = new SocketKernelTransport({
      authToken: RpcAuthToken,
      endpoint,
    })
    let resolveEvent: (event: unknown) => void = () => undefined
    const receivedEvent = new Promise<unknown>((resolve) => {
      resolveEvent = resolve
    })
    const subscription = await transport.subscribe(
      'test.rpc.completed',
      (event) => resolveEvent(event),
    )

    try {
      const handshake = await transport.handshake()
      expect(handshake.kernelVersion).toBe('0.2.0')
      expect(JSON.stringify(handshake)).not.toContain(RpcAuthToken)
      expect(
        await transport.call(call),
      ).toMatchObject({
        status: 'error',
        error: { code: 'CAPABILITY_NOT_GRANTED' },
      })
      const sessionOpen = await transport.openCapabilitySession({
        protocolVersion: KernelProtocolVersion,
        requires: [
          {
            capabilityId: EchoToken.id,
            operations: null,
            scope: null,
          },
        ],
      })
      expect(sessionOpen).toMatchObject({
        status: 'ok',
        requires: [
          {
            capabilityId: EchoToken.id,
            operations: null,
            scope: null,
          },
        ],
      })
      if (sessionOpen.status !== 'ok') throw new Error('session open failed')
      const boundCall = { ...call, sessionId: sessionOpen.sessionId }
      expect(await transport.call(boundCall)).toMatchObject({
        status: 'ok',
        output: { value: 42 },
      })
      expect(await withTimeout(receivedEvent)).toMatchObject({
        type: 'test.rpc.completed',
        payload: { value: 42 },
        sourceModuleId: 'module.rpc',
      })
      const controller = new AbortController()
      const cancelled = transport.call(
        { ...boundCall, callId: 'call-cancelled', operation: 'wait' },
        controller.signal,
      )
      setTimeout(() => controller.abort(), 10)
      await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      await subscription.dispose()
      await transport.dispose()
      await server.dispose()
    }

    expect(service.getStatus()).toBe('disposed')
  })

  test.skipIf(process.platform === 'win32')('publishes one discoverable endpoint and enforces a daemon lock', async () => {
    const directory = await temporaryDirectory()
    const paths = createDefaultKernelDaemonPaths('test-kernel', directory)
    const first = createRpcService()
    const firstDaemon = new KernelLocalDaemon({
      paths,
      service: first.service,
    })
    const descriptor = await firstDaemon.start()
    const second = createRpcService()
    const secondDaemon = new KernelLocalDaemon({
      paths,
      service: second.service,
    })

    try {
      expect(await kernelDaemons.discover(paths)).toEqual(descriptor)
      if (process.platform !== 'win32') {
        expect((await stat(paths.descriptorPath)).mode & 0o777).toBe(0o600)
      }
      const connected = await kernelDaemons.connect(paths)
      try {
        expect(connected.handshake.kernelVersion).toBe('0.2.0')
        expect(connected.descriptor.instanceId).toBe(descriptor.instanceId)
      } finally {
        await connected.client.dispose()
      }
      await expect(secondDaemon.start()).rejects.toBeInstanceOf(
        KernelClientError,
      )
      expect(second.service.getStatus()).toBe('idle')
    } finally {
      await secondDaemon.dispose()
      await firstDaemon.dispose()
    }

    await expect(kernelDaemons.discover(paths)).rejects.toMatchObject({
      code: 'DAEMON_NOT_RUNNING',
    })
  })

  test.skipIf(process.platform === 'win32')('refuses a runtime directory that other local users can enter', async () => {
    // 缺省落点在共享的 <tmpdir>/velaros-kernel-<uid>：别的用户预先建好这个目录，就能替换
    // descriptor 把客户端引到自己的 socket，客户端会把认证令牌发过去。
    const directory = await temporaryDirectory()
    const runtimeDirectory = join(directory, 'shared-runtime')
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
    await chmod(runtimeDirectory, 0o755)
    const paths = createDefaultKernelDaemonPaths('test-kernel', runtimeDirectory)
    const { service } = createRpcService()
    const daemon = new KernelLocalDaemon({ paths, service })

    try {
      await expect(daemon.start()).rejects.toMatchObject({
        name: 'KernelClientError',
        code: 'DAEMON_LOCK_FAILED',
      })
      // 目录已存在时 mkdir 的 mode 不生效，所以拒绝之后它仍然是 0755，没有被悄悄改掉。
      expect((await stat(runtimeDirectory)).mode & 0o777).toBe(0o755)
      await expect(kernelDaemons.discover(paths)).rejects.toMatchObject({
        code: 'DAEMON_NOT_RUNNING',
      })

      // 收紧到 0700 之后照常起来。
      await chmod(runtimeDirectory, 0o700)
      await daemon.start()
      expect((await kernelDaemons.discover(paths)).pid).toBe(process.pid)
    } finally {
      await daemon.dispose()
    }
  })

  test('supports the explicit loopback TCP fallback', async () => {
    const { service } = createRpcService()
    const server = new KernelLocalRpcServer({
      authToken: RpcAuthToken,
      endpoint: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      service,
    })
    const endpoint = await server.start()
    const transport = new SocketKernelTransport({
      authToken: RpcAuthToken,
      endpoint,
    })

    try {
      expect(endpoint).toMatchObject({
        kind: 'tcp',
        host: '127.0.0.1',
      })
      expect(endpoint.kind === 'tcp' && endpoint.port).not.toBe(0)
      expect((await transport.handshake()).kernelVersion).toBe('0.2.0')
    } finally {
      await transport.dispose()
      await server.dispose()
    }
  })

  test('rejects missing and incorrect RPC credentials without leaking secrets', async () => {
    const directory = await temporaryDirectory()
    const { service } = createRpcService()
    const server = new KernelLocalRpcServer({
      authToken: RpcAuthToken,
      endpoint: { kind: 'unix', path: join(directory, 'auth.sock') },
      service,
    })
    const endpoint = await server.start()

    try {
      for (const authToken of [
        '',
        'wrong-auth-token-0123456789-abcdef',
      ]) {
        const transport = new SocketKernelTransport({ authToken, endpoint })
        try {
          const error = await transport.handshake().catch(
            (caught: unknown) => caught,
          )
          expect(error).toMatchObject({
            rpcError: {
              code: 'UNAUTHORIZED',
              retryable: false,
            },
          })
          expect(JSON.stringify(error)).not.toContain(RpcAuthToken)
        } finally {
          await transport.dispose()
        }
      }
    } finally {
      await server.dispose()
    }
  })
})

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for RPC event')), 2000)
    }),
  ])
}
