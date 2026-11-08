import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { KernelClient } from '../../src/impl/client/KernelClient'
import { SocketKernelTransport } from '../../src/impl/client/SocketKernelTransport'
import { KernelProtocolVersion } from '../../src/utils/wire/version'

import {
  type FakeKernelConnection,
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
    connection: { send(frame: unknown): void; sendRaw(line: string): void; destroy(): void }
  ) => void | Promise<void>
): Promise<FakeKernelEndpoint> {
  const directory = await temporaryRuntimeDirectory(directories)
  const endpoint = new FakeKernelEndpoint(
    respond as ConstructorParameters<typeof FakeKernelEndpoint>[0]
  )
  endpoints.push(endpoint)
  await endpoint.start(join(directory, 'kernel.sock'))
  return endpoint
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function okResponse(requestId: string, result: unknown) {
  return { type: 'response', requestId, status: 'ok', result } as const
}

function eventFrame(subscriptionId: string, payload: string, sequence: number) {
  return {
    type: 'event',
    subscriptionId,
    event: {
      type: 'test.changed',
      payload,
      sourceModuleId: 'module.publisher',
      sourceGeneration: 1,
      sequence,
    },
  } as const
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
          })
        )
      )
      expect(results.map((response) => response.callId)).toEqual(['a', 'b', 'c'])
      expect(
        results.map((response) => (response.status === 'ok' ? response.output : undefined))
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
          })
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
        })
      )
      const settled = Promise.allSettled(stranded)
      await Bun.sleep(20)
      endpoint.dropConnections()
      const outcomes = await settled
      expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
      for (const outcome of outcomes) {
        expect((outcome as PromiseRejectedResult).reason).toMatchObject({
          rpcError: { code: 'TRANSPORT_DISCONNECTED', retryable: true },
        })
      }
    } finally {
      await transport.dispose()
    }
  })

  test('aborts the actual request, ignores its late result, and releases its cancel listener', async () => {
    const entered = deferred<{ request: ReceivedRequest; connection: FakeKernelConnection }>()
    const cancelled = deferred<ReceivedRequest>()
    const connections = new Set<FakeKernelConnection>()
    const endpoint = await startEndpoint((request, connection) => {
      connections.add(connection)
      if (request.method === 'capability.call') entered.resolve({ request, connection })
      if (request.method === 'capability.cancel') cancelled.resolve(request)
      if (request.method === 'health')
        connection.send(okResponse(request.requestId, { status: 'healthy', modules: [] }))
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
        controller.signal
      )
      const settled = Promise.allSettled([call])
      const actual = await entered.promise
      controller.abort()
      await expect(call).rejects.toMatchObject({ name: 'AbortError' })
      expect((await cancelled.promise).params).toEqual({ requestId: actual.request.requestId })
      actual.connection.send(okResponse(actual.request.requestId, callSuccess('abortable', 'late')))
      await expect(transport.health()).resolves.toMatchObject({ status: 'healthy' })
      expect((await settled)[0]?.status).toBe('rejected')
      controller.abort()
      await transport.health()
      expect(
        endpoint.received.filter((request) => request.method === 'capability.cancel')
      ).toHaveLength(1)
      expect(connections.size).toBe(1)
    } finally {
      await transport.dispose()
    }
  })

  test('a disconnected request cannot send a late cancellation into the next connection', async () => {
    const entered = deferred<{ request: ReceivedRequest; connection: FakeKernelConnection }>()
    const connections = new Set<FakeKernelConnection>()
    const endpoint = await startEndpoint((request, connection) => {
      connections.add(connection)
      if (request.method === 'capability.call') entered.resolve({ request, connection })
      if (request.method === 'health')
        connection.send(okResponse(request.requestId, { status: 'healthy', modules: [] }))
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
          callId: 'old-request',
          sessionId: 'test-session',
          capabilityId: 'test.capability',
          operation: 'slow',
          scope: null,
          input: null,
        },
        controller.signal
      )
      const settled = Promise.allSettled([call])
      const actual = await entered.promise
      actual.connection.destroy()
      expect((await settled)[0]).toMatchObject({
        status: 'rejected',
        reason: { code: 'TRANSPORT_DISCONNECTED' },
      })
      await transport.health()
      controller.abort()
      actual.connection.send(
        okResponse(actual.request.requestId, callSuccess('old-request', 'late'))
      )
      await transport.health()
      expect(connections.size).toBe(2)
      expect(
        endpoint.received.filter((request) => request.method === 'capability.cancel')
      ).toHaveLength(0)
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
          AbortSignal.abort()
        )
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(endpoint.received).toHaveLength(0)
    } finally {
      await transport.dispose()
    }
  })

  for (const serializer of ['toJSON', 'getter'] as const) {
    for (const interrupt of ['abort', 'close', 'throw', 'abort then throw'] as const) {
      test(`owns admission when payload ${serializer} triggers ${interrupt}`, async () => {
        const connections = new Set<FakeKernelConnection>()
        let businessStarts = 0
        const endpoint = await startEndpoint((request, connection) => {
          connections.add(connection)
          if (request.method === 'capability.call') {
            businessStarts += 1
            connection.send(okResponse(request.requestId, callSuccess('serializing', 'executed')))
          } else if (request.method === 'capability.cancel') {
            connection.send(okResponse(request.requestId, false))
          } else if (request.method === 'health') {
            connection.send(okResponse(request.requestId, { status: 'healthy', modules: [] }))
          }
        })
        const transport = new SocketKernelTransport({
          authToken: AuthToken,
          endpoint: endpoint.getEndpoint(),
        })
        try {
          await transport.health()
          const controller = new AbortController()
          let serializations = 0
          const onSerialize = () => {
            serializations += 1
            if (interrupt === 'abort' || interrupt === 'abort then throw') controller.abort()
            if (interrupt === 'close') void transport.dispose()
            if (interrupt === 'throw' || interrupt === 'abort then throw')
              throw new AppError('VALIDATION', 'payload serialization fixture failed')
          }
          const input =
            serializer === 'toJSON'
              ? {
                  toJSON() {
                    onSerialize()
                    return { value: 'serialized' }
                  },
                }
              : {
                  get value() {
                    onSerialize()
                    return 'serialized'
                  },
                }
          const expected =
            interrupt === 'close'
              ? { code: 'TRANSPORT_CLOSED' }
              : interrupt === 'throw'
                ? { code: 'TRANSPORT_WRITE_FAILED' }
                : { name: 'AbortError' }
          await expect(
            transport.call(
              {
                protocolVersion: KernelProtocolVersion,
                callId: 'serializing',
                sessionId: 'test-session',
                capabilityId: 'test.capability',
                operation: 'side-effect',
                scope: null,
                input,
              },
              controller.signal
            )
          ).rejects.toMatchObject(expected)
          if (interrupt === 'close')
            await expect(transport.health()).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
          else await expect(transport.health()).resolves.toMatchObject({ status: 'healthy' })
          expect(serializations).toBe(1)
          expect(businessStarts).toBe(0)
          expect(
            endpoint.received.filter((request) => request.method === 'capability.call')
          ).toHaveLength(0)
          expect(
            endpoint.received.filter((request) => request.method === 'capability.cancel')
          ).toHaveLength(0)
          expect(connections.size).toBe(1)
        } finally {
          await transport.dispose()
        }
      })
    }
  }

  for (const failure of ['sync throw', 'async reject'] as const) {
    test(`isolates observer ${failure} on the same physical connection`, async () => {
      const held = deferred<{ request: ReceivedRequest; connection: FakeKernelConnection }>()
      const delivered = deferred()
      const connections = new Set<FakeKernelConnection>()
      let subscriptionCount = 0
      let healthCount = 0
      const endpoint = await startEndpoint((request, connection) => {
        connections.add(connection)
        if (request.method === 'events.subscribe') {
          subscriptionCount += 1
          connection.send(
            okResponse(request.requestId, { subscriptionId: `sub-${subscriptionCount}` })
          )
        } else if (request.method === 'events.unsubscribe') {
          connection.send(okResponse(request.requestId, true))
        } else if (request.method === 'health') {
          healthCount += 1
          if (healthCount === 1) held.resolve({ request, connection })
          else connection.send(okResponse(request.requestId, { status: 'healthy', modules: [] }))
        }
      })
      const transport = new SocketKernelTransport({
        authToken: AuthToken,
        endpoint: endpoint.getEndpoint(),
      })
      try {
        let failures = 0
        await transport.subscribe('test.changed', () => {
          failures += 1
          const error = new AppError('VALIDATION', 'observer fixture failed')
          if (failure === 'sync throw') throw error
          return Promise.reject(error)
        })
        await transport.subscribe('test.changed', () => delivered.resolve())
        const health = transport.health()
        const healthOutcome = Promise.allSettled([health])
        const actual = await held.promise
        actual.connection.sendRaw(
          [eventFrame('sub-1', 'failure', 1), eventFrame('sub-2', 'other observer', 2)]
            .map((frame) => JSON.stringify(frame))
            .join('\n')
        )
        await Promise.race([delivered.promise, health])
        actual.connection.send(
          okResponse(actual.request.requestId, { status: 'healthy', modules: [] })
        )
        await expect(health).resolves.toMatchObject({ status: 'healthy' })
        expect((await healthOutcome)[0]?.status).toBe('fulfilled')
        await transport.health()
        expect(failures).toBe(1)
        expect(subscriptionCount).toBe(2)
        expect(connections.size).toBe(1)
      } finally {
        await transport.dispose()
      }
    })
  }

  test('invalid event frames still disconnect the physical connection', async () => {
    const held = deferred<{ request: ReceivedRequest; connection: FakeKernelConnection }>()
    const endpoint = await startEndpoint((request, connection) => {
      held.resolve({ request, connection })
    })
    const transport = new SocketKernelTransport({
      authToken: AuthToken,
      endpoint: endpoint.getEndpoint(),
    })
    try {
      const settled = Promise.allSettled([transport.health()])
      const actual = await held.promise
      const malformed = eventFrame('sub-invalid', 'bad sequence', 1)
      actual.connection.sendRaw(
        JSON.stringify({ ...malformed, event: { ...malformed.event, sequence: 1.5 } })
      )
      expect((await settled)[0]).toMatchObject({
        status: 'rejected',
        reason: { code: 'TRANSPORT_DISCONNECTED' },
      })
    } finally {
      await transport.dispose()
    }
  })

  test('delivers subscribed events and stops after unsubscribe', async () => {
    let live: { send(frame: unknown): void } | undefined
    const endpoint = await startEndpoint((request, connection) => {
      live = connection
      if (request.method === 'events.subscribe') {
        connection.send(okResponse(request.requestId, { subscriptionId: 'sub-1' }))
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

  test('re-establishes event subscriptions after the connection drops', async () => {
    let live: { send(frame: unknown): void } | undefined
    let subscriptionSequence = 0
    let onResubscribed: () => void = () => undefined
    const resubscribed = new Promise<void>((resolve) => {
      onResubscribed = resolve
    })
    const endpoint = await startEndpoint((request, connection) => {
      live = connection
      if (request.method === 'events.subscribe') {
        subscriptionSequence += 1
        connection.send(
          okResponse(request.requestId, {
            subscriptionId: `sub-${subscriptionSequence}`,
          })
        )
        if (subscriptionSequence === 2) onResubscribed()
        return
      }
      connection.send(okResponse(request.requestId, { status: 'healthy', modules: [] }))
    })

    const transport = new SocketKernelTransport({
      authToken: AuthToken,
      endpoint: endpoint.getEndpoint(),
    })
    try {
      const seen: string[] = []
      await transport.subscribe('test.changed', (event) => {
        seen.push(String(event.payload))
      })
      live?.send(eventFrame('sub-1', 'first', 1))
      await Bun.sleep(20)
      expect(seen).toEqual(['first'])

      // 断线：服务端的订阅连同它的 id 一起作废。
      endpoint.dropConnections()
      await Bun.sleep(20)
      // 下一次请求会自动重连，订阅必须跟着一起恢复（原来是静默失效，调用方毫不知情）。
      await transport.health()
      await resubscribed
      expect(subscriptionSequence).toBe(2)

      live?.send(eventFrame('sub-2', 'after-reconnect', 2))
      await Bun.sleep(20)
      expect(seen).toEqual(['first', 'after-reconnect'])
    } finally {
      await transport.dispose()
    }
  })

  test('delivers the new subscription first event immediately after its ACK in the same write', async () => {
    const connections = new Set<FakeKernelConnection>()
    const endpoint = await startEndpoint((request, connection) => {
      connections.add(connection)
      if (request.method === 'events.subscribe') {
        connection.sendRaw(
          [
            okResponse(request.requestId, { subscriptionId: 'sub-immediate' }),
            eventFrame('sub-immediate', 'first', 1),
          ]
            .map((frame) => JSON.stringify(frame))
            .join('\n')
        )
      } else if (request.method === 'events.unsubscribe') {
        connection.send(okResponse(request.requestId, true))
      } else if (request.method === 'health') {
        connection.send(okResponse(request.requestId, { status: 'healthy', modules: [] }))
      }
    })
    const transport = new SocketKernelTransport({
      authToken: AuthToken,
      endpoint: endpoint.getEndpoint(),
    })
    try {
      const seen: string[] = []
      const subscription = await transport.subscribe('test.changed', (event) => {
        seen.push(String(event.payload))
      })
      await transport.health()
      expect(seen).toEqual(['first'])
      expect(connections.size).toBe(1)
      await subscription.dispose()
    } finally {
      await transport.dispose()
    }
  })

  test('delivers the restored subscription first event immediately after its new ACK', async () => {
    const held = deferred<{ request: ReceivedRequest; connection: FakeKernelConnection }>()
    const restored = deferred<FakeKernelConnection>()
    let subscriptionCount = 0
    let healthCount = 0
    const endpoint = await startEndpoint((request, connection) => {
      if (request.method === 'events.subscribe') {
        subscriptionCount += 1
        if (subscriptionCount === 1) {
          connection.send(okResponse(request.requestId, { subscriptionId: 'sub-1' }))
        } else {
          connection.sendRaw(
            [
              okResponse(request.requestId, { subscriptionId: 'sub-2' }),
              eventFrame('sub-2', 'first restored', 1),
            ]
              .map((frame) => JSON.stringify(frame))
              .join('\n')
          )
          restored.resolve(connection)
        }
      } else if (request.method === 'events.unsubscribe') {
        connection.send(okResponse(request.requestId, true))
      } else if (request.method === 'health') {
        healthCount += 1
        if (healthCount === 1) held.resolve({ request, connection })
        else connection.send(okResponse(request.requestId, { status: 'healthy', modules: [] }))
      }
    })
    const transport = new SocketKernelTransport({
      authToken: AuthToken,
      endpoint: endpoint.getEndpoint(),
    })
    try {
      const seen: string[] = []
      const subscription = await transport.subscribe('test.changed', (event) => {
        seen.push(String(event.payload))
      })
      const disconnected = Promise.allSettled([transport.health()])
      const first = await held.promise
      first.connection.destroy()
      expect((await disconnected)[0]).toMatchObject({
        status: 'rejected',
        reason: { code: 'TRANSPORT_DISCONNECTED' },
      })
      await transport.health()
      expect(await restored.promise).not.toBe(first.connection)
      await transport.health()
      expect(seen).toEqual(['first restored'])
      expect(subscriptionCount).toBe(2)
      await subscription.dispose()
    } finally {
      await transport.dispose()
    }
  })

  for (const close of ['subscription', 'transport', 'disconnect'] as const) {
    test(`owns a late restored subscription through ${close} close`, async () => {
      const restoring = deferred<{ request: ReceivedRequest; connection: FakeKernelConnection }>()
      const unsubscribing = deferred<{
        request: ReceivedRequest
        connection: FakeKernelConnection
      }>()
      const delivered = deferred()
      let heldHealth = deferred<{ request: ReceivedRequest; connection: FakeKernelConnection }>()
      let holdHealth = true
      let subscriptionCount = 0
      const connections = new Set<FakeKernelConnection>()
      const subscriptions: Array<{ request: ReceivedRequest; connection: FakeKernelConnection }> =
        []
      const endpoint = await startEndpoint((request, connection) => {
        connections.add(connection)
        if (request.method === 'events.subscribe') {
          subscriptionCount += 1
          subscriptions.push({ request, connection })
          if (subscriptionCount === 1)
            connection.send(okResponse(request.requestId, { subscriptionId: 'sub-1' }))
          else restoring.resolve({ request, connection })
        } else if (request.method === 'events.unsubscribe') {
          unsubscribing.resolve({ request, connection })
        } else if (request.method === 'health') {
          if (holdHealth) {
            holdHealth = false
            heldHealth.resolve({ request, connection })
          } else connection.send(okResponse(request.requestId, { status: 'healthy', modules: [] }))
        }
      })
      const transport = new SocketKernelTransport({
        authToken: AuthToken,
        endpoint: endpoint.getEndpoint(),
      })
      let closing: Promise<void> | undefined
      try {
        const seen: string[] = []
        const subscription = await transport.subscribe('test.changed', (event) => {
          seen.push(String(event.payload))
          delivered.resolve()
        })
        subscriptions[0]!.connection.send(eventFrame('sub-1', 'before reconnect', 1))
        await delivered.promise
        const firstDisconnect = Promise.allSettled([transport.health()])
        const first = await heldHealth.promise
        first.connection.destroy()
        expect((await firstDisconnect)[0]).toMatchObject({
          status: 'rejected',
          reason: { code: 'TRANSPORT_DISCONNECTED' },
        })
        await transport.health()
        const actual = await restoring.promise
        expect(actual.connection).not.toBe(first.connection)

        if (close === 'transport') {
          const pending = Promise.allSettled([transport.health()])
          await transport.dispose()
          expect((await pending)[0]).toMatchObject({
            status: 'rejected',
            reason: { code: 'TRANSPORT_CLOSED' },
          })
          actual.connection.send(okResponse(actual.request.requestId, { subscriptionId: 'sub-2' }))
          await subscription.dispose()
          await subscription.dispose()
          await expect(transport.health()).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
          expect(connections.size).toBe(2)
          expect(
            endpoint.received.filter((request) => request.method === 'events.unsubscribe')
          ).toHaveLength(0)
        } else {
          let completed = false
          closing = Promise.resolve(subscription.dispose())
          void closing.then(
            () => {
              completed = true
            },
            () => undefined
          )
          await transport.health()
          expect(completed).toBeFalse()
          if (close === 'disconnect') {
            heldHealth = deferred<{ request: ReceivedRequest; connection: FakeKernelConnection }>()
            holdHealth = true
            const secondDisconnect = Promise.allSettled([transport.health()])
            const second = await heldHealth.promise
            expect(second.connection).toBe(actual.connection)
            second.connection.destroy()
            expect((await secondDisconnect)[0]).toMatchObject({
              status: 'rejected',
              reason: { code: 'TRANSPORT_DISCONNECTED' },
            })
            await closing
            actual.connection.send(
              okResponse(actual.request.requestId, { subscriptionId: 'sub-2' })
            )
            expect(connections.size).toBe(2)
            await transport.health()
            expect(connections.size).toBe(3)
            expect(
              endpoint.received.filter((request) => request.method === 'events.unsubscribe')
            ).toHaveLength(0)
          } else {
            actual.connection.send(
              okResponse(actual.request.requestId, { subscriptionId: 'sub-2' })
            )
            const release = await unsubscribing.promise
            expect(release.connection).toBe(actual.connection)
            expect(release.request.params).toEqual({ subscriptionId: 'sub-2' })
            expect(completed).toBeFalse()
            release.connection.send(okResponse(release.request.requestId, true))
            await closing
            await subscription.dispose()
            actual.connection.send(eventFrame('sub-2', 'after dispose', 2))
            await transport.health()
            expect(
              endpoint.received.filter((request) => request.method === 'events.unsubscribe')
            ).toHaveLength(1)
          }
        }
        expect(subscriptionCount).toBe(2)
        expect(seen).toEqual(['before reconnect'])
      } finally {
        await transport.dispose()
        await closing?.catch(() => undefined)
      }
    })
  }

  test('a subscribe response cannot register a live handle after an observer closes the transport', async () => {
    let subscriptionCount = 0
    const connections = new Set<FakeKernelConnection>()
    const endpoint = await startEndpoint((request, connection) => {
      connections.add(connection)
      if (request.method !== 'events.subscribe') return
      subscriptionCount += 1
      if (subscriptionCount === 1) {
        connection.send(okResponse(request.requestId, { subscriptionId: 'sub-1' }))
      } else {
        connection.sendRaw(
          [
            okResponse(request.requestId, { subscriptionId: 'sub-2' }),
            eventFrame('sub-1', 'close now', 1),
          ]
            .map((frame) => JSON.stringify(frame))
            .join('\n')
        )
      }
    })
    const transport = new SocketKernelTransport({
      authToken: AuthToken,
      endpoint: endpoint.getEndpoint(),
    })
    try {
      const first = await transport.subscribe('test.changed', () => transport.dispose())
      await expect(transport.subscribe('test.changed', () => undefined)).rejects.toMatchObject({
        code: 'TRANSPORT_CLOSED',
      })
      await first.dispose()
      await expect(transport.health()).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
      expect(connections.size).toBe(1)
      expect(subscriptionCount).toBe(2)
      expect(
        endpoint.received.filter((request) => request.method === 'events.unsubscribe')
      ).toHaveLength(0)
    } finally {
      await transport.dispose()
    }
  })

  test('a failed unsubscribe remains a failed release on repeated disposal', async () => {
    let unsubscribeCount = 0
    const connections = new Set<FakeKernelConnection>()
    const endpoint = await startEndpoint((request, connection) => {
      connections.add(connection)
      if (request.method === 'events.subscribe')
        connection.send(okResponse(request.requestId, { subscriptionId: 'sub-denied' }))
      else if (request.method === 'events.unsubscribe') {
        unsubscribeCount += 1
        connection.send({
          type: 'response',
          requestId: request.requestId,
          status: 'error',
          error: { code: 'PERMISSION', message: 'release denied', retryable: false, details: null },
        })
      } else if (request.method === 'health')
        connection.send(okResponse(request.requestId, { status: 'healthy', modules: [] }))
    })
    const transport = new SocketKernelTransport({
      authToken: AuthToken,
      endpoint: endpoint.getEndpoint(),
    })
    try {
      const subscription = await transport.subscribe('test.changed', () => undefined)
      await expect(subscription.dispose()).rejects.toMatchObject({ code: 'PERMISSION' })
      await expect(subscription.dispose()).rejects.toMatchObject({ code: 'PERMISSION' })
      await expect(transport.health()).resolves.toMatchObject({ status: 'healthy' })
      expect(unsubscribeCount).toBe(1)
      expect(connections.size).toBe(1)
    } finally {
      await transport.dispose()
    }
  })

  test('a failed restore leaves the next subscription and normal requests on the new connection alive', async () => {
    const held = deferred<{ request: ReceivedRequest; connection: FakeKernelConnection }>()
    const restored = deferred<{ request: ReceivedRequest; connection: FakeKernelConnection }>()
    const delivered = deferred()
    let subscriptionCount = 0
    let healthCount = 0
    const endpoint = await startEndpoint((request, connection) => {
      if (request.method === 'events.subscribe') {
        subscriptionCount += 1
        if (subscriptionCount === 3) {
          connection.send({
            type: 'response',
            requestId: request.requestId,
            status: 'error',
            error: {
              code: 'UNAVAILABLE',
              message: 'one restore failed',
              retryable: true,
              details: null,
            },
          })
        } else {
          connection.send(
            okResponse(request.requestId, { subscriptionId: `sub-${subscriptionCount}` })
          )
          if (subscriptionCount === 4) restored.resolve({ request, connection })
        }
      } else if (request.method === 'events.unsubscribe') {
        connection.send(okResponse(request.requestId, true))
      } else if (request.method === 'health') {
        healthCount += 1
        if (healthCount === 1) held.resolve({ request, connection })
        else connection.send(okResponse(request.requestId, { status: 'healthy', modules: [] }))
      }
    })
    const transport = new SocketKernelTransport({
      authToken: AuthToken,
      endpoint: endpoint.getEndpoint(),
    })
    try {
      await transport.subscribe('test.changed', () => undefined)
      await transport.subscribe('test.changed', () => delivered.resolve())
      const disconnected = Promise.allSettled([transport.health()])
      const first = await held.promise
      first.connection.destroy()
      expect((await disconnected)[0]).toMatchObject({
        status: 'rejected',
        reason: { code: 'TRANSPORT_DISCONNECTED' },
      })
      await expect(transport.health()).resolves.toMatchObject({ status: 'healthy' })
      const actual = await restored.promise
      await transport.health()
      actual.connection.send(eventFrame('sub-4', 'restored observer', 1))
      await delivered.promise
      expect(actual.connection).not.toBe(first.connection)
      expect(subscriptionCount).toBe(4)
    } finally {
      await transport.dispose()
    }
  })

  test('closing the transport rejects an entered call and removes its cancellation ownership', async () => {
    const entered = deferred<ReceivedRequest>()
    const endpoint = await startEndpoint((request) => entered.resolve(request))
    const transport = new SocketKernelTransport({
      authToken: AuthToken,
      endpoint: endpoint.getEndpoint(),
    })
    try {
      const controller = new AbortController()
      const call = transport.call(
        {
          protocolVersion: KernelProtocolVersion,
          callId: 'closed-request',
          sessionId: 'test-session',
          capabilityId: 'test.capability',
          operation: 'slow',
          scope: null,
          input: null,
        },
        controller.signal
      )
      const settled = Promise.allSettled([call])
      expect((await entered.promise).method).toBe('capability.call')
      await transport.dispose()
      expect((await settled)[0]).toMatchObject({
        status: 'rejected',
        reason: { code: 'TRANSPORT_CLOSED' },
      })
      controller.abort()
      await expect(transport.health()).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
      expect(endpoint.received.map((request) => request.method)).toEqual(['capability.call'])
    } finally {
      await transport.dispose()
    }
  })

  test('rejects RPC results that do not match the wire schema', async () => {
    const endpoint = await startEndpoint((request, connection) => {
      if (request.method === 'handshake') {
        // Missing kernelVersion and modules: schema validation must catch it.
        connection.send(okResponse(request.requestId, { protocolVersion: KernelProtocolVersion }))
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
        })
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
        name: 'KernelClientError',
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
