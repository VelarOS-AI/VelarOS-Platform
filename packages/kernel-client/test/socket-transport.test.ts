import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { KernelClient } from '../src/KernelClient'
import { KernelProtocolVersion } from '../src/protocol'
import { SocketKernelTransport } from '../src/socket-transport'

import {
  FakeKernelEndpoint,
  type ReceivedRequest,
  temporaryRuntimeDirectory,
} from './fake-kernel-endpoint'

const AuthToken = 'client-auth-token-0123456789-abcdef'
const directories: string[] = []
const endpoints: FakeKernelEndpoint[] = []

afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) await endpoint.dispose()
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function startEndpoint(
  respond: (
    request: ReceivedRequest,
    connection: { send(frame: unknown): void; sendRaw(line: string): void; destroy(): void },
  ) => void | Promise<void>,
): Promise<FakeKernelEndpoint> {
  const directory = await temporaryRuntimeDirectory(directories)
  const endpoint = new FakeKernelEndpoint(
    respond as ConstructorParameters<typeof FakeKernelEndpoint>[0],
  )
  endpoints.push(endpoint)
  await endpoint.start(join(directory, 'kernel.sock'))
  return endpoint
}

function okResponse(requestId: string, result: unknown) {
  return { type: 'response', requestId, status: 'ok', result }
}

function callSuccess(callId: string, output: unknown) {
  return {
    protocolVersion: KernelProtocolVersion,
    callId,
    status: 'ok',
    output,
  }
}

describe('kernel client socket transport', () => {
  test('matches concurrent responses to their originating requestId', async () => {
    // Answering out of order proves correlation is by requestId, not arrival order.
    const pending: ReceivedRequest[] = []
    const endpoint = await startEndpoint((request, connection) => {
      if (request.method !== 'capability.call') return
      pending.push(request)
      if (pending.length < 3) return
      for (const queued of [...pending].reverse()) {
        const callId = (queued.params as { callId: string }).callId
        connection.send(okResponse(queued.requestId, callSuccess(callId, callId)))
      }
    })

    const transport = new SocketKernelTransport({
      authToken: AuthToken,
      endpoint: endpoint.getEndpoint(),
    })
    try {
      const results = await Promise.all(
        ['a', 'b', 'c'].map((callId) =>
          transport.call({
            protocolVersion: KernelProtocolVersion,
            callId,
            sessionId: 'test-session',
            capabilityId: 'test.capability',
            operation: 'echo',
            scope: null,
            input: callId,
          })),
      )
      expect(results.map((response) => response.callId)).toEqual(['a', 'b', 'c'])
      expect(
        results.map((response) =>
          response.status === 'ok' ? response.output : undefined),
      ).toEqual(['a', 'b', 'c'])
    } finally {
      await transport.dispose()
    }
  })

  test('rejects every pending request when the socket disconnects', async () => {
    const endpoint = await startEndpoint((request, connection) => {
      // Answer the handshake, then strand the capability calls and drop the link.
      if (request.method === 'handshake') {
        connection.send(
          okResponse(request.requestId, {
            protocolVersion: KernelProtocolVersion,
            kernelVersion: '0.3.0',
            modules: [],
          }),
        )
      }
    })

    const transport = new SocketKernelTransport({
      authToken: AuthToken,
      endpoint: endpoint.getEndpoint(),
    })
    try {
      await transport.handshake()
      const stranded = ['a', 'b'].map((callId) =>
        transport.call({
          protocolVersion: KernelProtocolVersion,
          callId,
          sessionId: 'test-session',
          capabilityId: 'test.capability',
          operation: 'echo',
          scope: null,
          input: null,
        }))
      const settled = Promise.allSettled(stranded)
      await Bun.sleep(20)
      endpoint.dropConnections()
      const outcomes = await settled
      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        'rejected',
        'rejected',
      ])
      for (const outcome of outcomes) {
        expect((outcome as PromiseRejectedResult).reason).toMatchObject({
          rpcError: { code: 'TRANSPORT_DISCONNECTED', retryable: true },
        })
      }
    } finally {
      await transport.dispose()
    }
  })

  test('aborts a capability call and asks the Kernel to cancel it', async () => {
    const endpoint = await startEndpoint(() => {
      // Never answer: the abort path must resolve without a server response.
    })

    const transport = new SocketKernelTransport({
      authToken: AuthToken,
      endpoint: endpoint.getEndpoint(),
    })
    try {
      const controller = new AbortController()
      const call = transport.call(
        {
          protocolVersion: KernelProtocolVersion,
          callId: 'abortable',
          sessionId: 'test-session',
          capabilityId: 'test.capability',
          operation: 'slow',
          scope: null,
          input: null,
        },
        controller.signal,
      )
      await Bun.sleep(20)
      controller.abort()
      await expect(call).rejects.toMatchObject({ name: 'AbortError' })

      await Bun.sleep(20)
      const cancel = endpoint.received.find(
        (request) => request.method === 'capability.cancel',
      )
      expect(cancel).toBeDefined()
      const target = endpoint.received.find(
        (request) => request.method === 'capability.call',
      )
      expect(cancel?.params).toEqual({ requestId: target?.requestId })
    } finally {
      await transport.dispose()
    }
  })

  test('rejects a call whose signal is already aborted before it is sent', async () => {
    const endpoint = await startEndpoint(() => undefined)
    const transport = new SocketKernelTransport({
      authToken: AuthToken,
      endpoint: endpoint.getEndpoint(),
    })
    try {
      await expect(
        transport.call(
          {
            protocolVersion: KernelProtocolVersion,
            callId: 'already-aborted',
            sessionId: 'test-session',
            capabilityId: 'test.capability',
            operation: 'slow',
            scope: null,
            input: null,
          },
          AbortSignal.abort(),
        ),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(endpoint.received).toHaveLength(0)
    } finally {
      await transport.dispose()
    }
  })

  test('delivers subscribed events and stops after unsubscribe', async () => {
    let live: { send(frame: unknown): void } | undefined
    const endpoint = await startEndpoint((request, connection) => {
      live = connection
      if (request.method === 'events.subscribe') {
        connection.send(
          okResponse(request.requestId, { subscriptionId: 'sub-1' }),
        )
        return
      }
      if (request.method === 'events.unsubscribe') {
        connection.send(okResponse(request.requestId, true))
      }
    })

    const transport = new SocketKernelTransport({
      authToken: AuthToken,
      endpoint: endpoint.getEndpoint(),
    })
    const client = new KernelClient(transport)
    try {
      const seen: string[] = []
      const subscription = await client.subscribe('test.changed', (event) => {
        seen.push(String(event.payload))
      })

      live?.send({
        type: 'event',
        subscriptionId: 'sub-1',
        event: {
          type: 'test.changed',
          payload: 'first',
          sourceModuleId: 'module.publisher',
          sourceGeneration: 1,
          sequence: 1,
        },
      })
      await Bun.sleep(20)
      expect(seen).toEqual(['first'])

      await subscription.dispose()
      live?.send({
        type: 'event',
        subscriptionId: 'sub-1',
        event: {
          type: 'test.changed',
          payload: 'second',
          sourceModuleId: 'module.publisher',
          sourceGeneration: 1,
          sequence: 2,
        },
      })
      await Bun.sleep(20)
      expect(seen).toEqual(['first'])
    } finally {
      await client.dispose()
    }
  })

  test('rejects RPC results that do not match the wire schema', async () => {
    const endpoint = await startEndpoint((request, connection) => {
      if (request.method === 'handshake') {
        // Missing kernelVersion and modules: schema validation must catch it.
        connection.send(
          okResponse(request.requestId, { protocolVersion: KernelProtocolVersion }),
        )
        return
      }
      if (request.method === 'capability.call') {
        connection.send(okResponse(request.requestId, { nonsense: true }))
      }
    })

    const transport = new SocketKernelTransport({
      authToken: AuthToken,
      endpoint: endpoint.getEndpoint(),
    })
    try {
      await expect(transport.handshake()).rejects.toThrow()
      await expect(
        transport.call({
          protocolVersion: KernelProtocolVersion,
          callId: 'bad-response',
          sessionId: 'test-session',
          capabilityId: 'test.capability',
          operation: 'echo',
          scope: null,
          input: null,
        }),
      ).rejects.toThrow()
    } finally {
      await transport.dispose()
    }
  })

  test('surfaces Kernel-reported errors with their wire code', async () => {
    const endpoint = await startEndpoint((request, connection) => {
      connection.send({
        type: 'response',
        requestId: request.requestId,
        status: 'error',
        error: {
          code: 'CAPABILITY_NOT_FOUND',
          message: 'Capability "missing" is not available',
          retryable: false,
          details: null,
        },
      })
    })

    const transport = new SocketKernelTransport({
      authToken: AuthToken,
      endpoint: endpoint.getEndpoint(),
    })
    try {
      await expect(transport.health()).rejects.toMatchObject({
        name: 'KernelRpcClientError',
        rpcError: { code: 'CAPABILITY_NOT_FOUND', retryable: false },
      })
    } finally {
      await transport.dispose()
    }
  })

  test('reports a stable transport error when nothing is listening', async () => {
    const directory = await temporaryRuntimeDirectory(directories)
    const transport = new SocketKernelTransport({
      authToken: AuthToken,
      endpoint: { kind: 'unix', path: join(directory, 'absent.sock') },
    })
    try {
      await expect(transport.handshake()).rejects.toMatchObject({
        rpcError: { code: 'TRANSPORT_CONNECT_FAILED', retryable: true },
      })
    } finally {
      await transport.dispose()
    }
  })

  test('rejects requests issued after the transport is closed', async () => {
    const endpoint = await startEndpoint(() => undefined)
    const transport = new SocketKernelTransport({
      authToken: AuthToken,
      endpoint: endpoint.getEndpoint(),
    })
    await transport.dispose()
    await expect(transport.health()).rejects.toMatchObject({
      rpcError: { code: 'TRANSPORT_CLOSED', retryable: true },
    })
  })
})
