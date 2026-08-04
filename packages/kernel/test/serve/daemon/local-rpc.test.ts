import {
  mkdtemp,
  rm,
  stat,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  connectToKernelDaemon,
  createDefaultKernelDaemonPaths,
  discoverKernelDaemon,
  SocketKernelTransport,
} from '@velaros-ai/kernel/client'
import {
  createCapabilityToken,
  createKernelCallableCapability,
  type KernelModuleDefinition,
} from '@velaros-ai/kernel/contracts/abi'
import {
  type CapabilityCallRequest,
  KernelProtocolVersion,
} from '@velaros-ai/kernel/contracts/protocol'
import { KernelModuleHost } from '@velaros-ai/kernel/runtime'
import {
  AllowLoadedKernelClientAccessBroker,
  KernelService,
} from '@velaros-ai/kernel/runtime'

import { KernelDaemonError, KernelLocalDaemon } from '../../../src/serve/daemon'
import { KernelLocalRpcServer } from '../../../src/serve/rpc'

const EchoToken = createCapabilityToken('test.rpc.echo')
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
        createKernelCallableCapability({
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
  test('routes calls, identities, and pushed events over a Unix socket', async () => {
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
        await transport.openSession({
          id: 'session-rpc',
          ownerModuleId: 'module.rpc',
          scope: null,
        }),
      ).toMatchObject({ id: 'session-rpc' })
      expect(
        await transport.startRun({
          id: 'run-rpc',
          ownerModuleId: 'module.rpc',
          sessionId: 'session-rpc',
        }),
      ).toMatchObject({
        id: 'run-rpc',
        sessionId: 'session-rpc',
        generation: 1,
      })
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
      expect((await transport.listSessions()).map(({ id }) => id))
        .toEqual(['session-rpc'])
      expect((await transport.listRuns()).map(({ id }) => id))
        .toEqual(['run-rpc'])
      await expect(transport.getSession('')).rejects.toMatchObject({
        rpcError: {
          code: 'INVALID_PARAMS',
          retryable: false,
        },
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

  test('publishes one discoverable endpoint and enforces a daemon lock', async () => {
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
      expect(await discoverKernelDaemon(paths)).toEqual(descriptor)
      expect((await stat(paths.descriptorPath)).mode & 0o777).toBe(0o600)
      const connected = await connectToKernelDaemon(paths)
      try {
        expect(connected.handshake.kernelVersion).toBe('0.2.0')
        expect(connected.descriptor.instanceId).toBe(descriptor.instanceId)
      } finally {
        await connected.client.dispose()
      }
      await expect(secondDaemon.start()).rejects.toBeInstanceOf(
        KernelDaemonError,
      )
      expect(second.service.getStatus()).toBe('idle')
    } finally {
      await secondDaemon.dispose()
      await firstDaemon.dispose()
    }

    await expect(discoverKernelDaemon(paths)).rejects.toMatchObject({
      code: 'DAEMON_NOT_RUNNING',
    })
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
