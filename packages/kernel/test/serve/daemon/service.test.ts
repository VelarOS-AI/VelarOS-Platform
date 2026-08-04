import { describe, expect, test } from 'bun:test'

import { KernelClient } from '@velaros-ai/kernel/client'
import {
  createCapabilityToken,
  createKernelCallableCapability,
  type KernelModuleDefinition,
  type KernelPermissionBroker,
} from '@velaros-ai/kernel/contracts/abi'
import {
  type CapabilityCallRequest,
  KernelProtocolVersion,
} from '@velaros-ai/kernel/contracts/protocol'
import { KernelModuleHost } from '@velaros-ai/kernel/runtime'
import { KernelService } from '@velaros-ai/kernel/runtime'

import { InProcessKernelTransport } from '../../../src/serve/internal'

const CallableToken = createCapabilityToken('test.callable', '1.2.0')
const PlainToken = createCapabilityToken('test.plain')
const ThrowingToken = createCapabilityToken('test.throwing')

function moduleDefinition(options: {
  readonly id: string
  readonly version?: string
  readonly token: typeof CallableToken
  readonly service: object
  readonly dispose?: () => void
  readonly ready?: () => void | Promise<void>
  readonly permissions?: readonly string[]
}): KernelModuleDefinition {
  return {
    manifest: {
      id: options.id,
      version: options.version ?? '1.0.0',
      apiVersion: 1,
      provides: [options.token],
      requires: [],
      optionalRequires: [],
      permissions: options.permissions ?? [],
      isolation: 'in-process',
    },
    activate(context) {
      context.registerService(options.token, options.service)
      return { dispose: options.dispose, ready: options.ready }
    },
  }
}

function call(
  capabilityId: string,
  operation = 'read',
): CapabilityCallRequest {
  return {
    protocolVersion: KernelProtocolVersion,
    callId: `call-${capabilityId}`,
    sessionId: 'service-direct',
    capabilityId,
    operation,
    scope: null,
    input: { value: 21 },
  }
}

describe('KernelService', () => {
  test('starts with zero modules and exposes a healthy empty catalog', async () => {
    const host = new KernelModuleHost({ apiVersion: 1 })
    const service = new KernelService({ host, kernelVersion: '0.1.0' })

    await service.start()

    expect(service.handshake()).toEqual({
      protocolVersion: KernelProtocolVersion,
      kernelVersion: '0.1.0',
      modules: [],
    })
    expect(await service.health()).toEqual({
      status: 'healthy',
      modules: [],
    })
  })

  test('keeps service state disposed when shutdown races an in-flight start', async () => {
    let finishReady!: () => void
    const readyGate = new Promise<void>((resolve) => {
      finishReady = resolve
    })
    let disposalCount = 0
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.registerModule(moduleDefinition({
      id: 'module.concurrent-service',
      token: CallableToken,
      service: createKernelCallableCapability({}),
      ready: () => readyGate,
      dispose: () => {
        disposalCount += 1
      },
    }))
    const service = new KernelService({ host, kernelVersion: '0.1.0' })

    const firstStart = service.start()
    expect(service.start()).toBe(firstStart)
    const firstDispose = service.dispose()
    expect(service.dispose()).toBe(firstDispose)
    finishReady()
    await Promise.all([firstStart, firstDispose])

    expect(service.getStatus()).toBe('disposed')
    expect(disposalCount).toBe(1)
    await expect(service.start()).rejects.toThrow(
      'Disposed kernel service cannot be started',
    )
  })

  test('builds deterministic module descriptors from host snapshots', async () => {
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.registerModule(
      moduleDefinition({
        id: 'module.callable',
        version: '2.3.4',
        token: CallableToken,
        service: { invoke: () => 'ok' },
      }),
    )
    const service = new KernelService({ host, kernelVersion: '9.0.0' })
    await service.start()

    expect(service.handshake().modules).toEqual([
      {
        id: 'module.callable',
        version: '2.3.4',
        apiVersion: 1,
        provides: [{ id: 'test.callable', version: '1.2.0' }],
        requires: [],
        optionalRequires: [],
        permissions: [],
        isolation: 'in-process',
        catalogRevision: 'module.callable@2.3.4#1',
      },
    ])
  })

  test('routes a successful call through the transport-only client', async () => {
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.registerModule(
      moduleDefinition({
        id: 'module.callable',
        token: CallableToken,
        service: createKernelCallableCapability({
          double: {
            metadata: { permissions: [] },
            invoke(
            scope: unknown,
            input: unknown,
            signal: AbortSignal,
          ) {
            expect(scope).toBeUndefined()
            expect(signal.aborted).toBeFalse()
            return (input as { value: number }).value * 2
          },
          },
        }),
      }),
    )
    const service = new KernelService({
      host,
      kernelVersion: '0.1.0',
      clientAccessBroker: {
        requestBind: async () => ({ status: 'granted' as const }),
      },
    })
    await service.start()
    const transport = new InProcessKernelTransport(service)
    const client = new KernelClient(transport)

    expect(await transport.call({
      ...call(CallableToken.id, 'double'),
      sessionId: 'missing',
    })).toMatchObject({
      status: 'error',
      error: { code: 'CAPABILITY_NOT_GRANTED' },
    })
    const session = await client.openCapabilitySession({
      requires: [
        { capabilityId: CallableToken.id, operations: null, scope: null },
      ],
    })
    expect(await session.call({
      protocolVersion: KernelProtocolVersion,
      callId: 'call-test.callable',
      capabilityId: CallableToken.id,
      operation: 'double',
      scope: null,
      input: { value: 21 },
    })).toEqual({
      protocolVersion: KernelProtocolVersion,
      callId: 'call-test.callable',
      status: 'ok',
      output: 42,
    })
  })

  test('returns structured failures without leaking implementation errors', async () => {
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.registerModules([
      moduleDefinition({
        id: 'module.plain',
        token: PlainToken,
        service: { value: 'not callable' },
      }),
      moduleDefinition({
        id: 'module.throwing',
        token: ThrowingToken,
        service: createKernelCallableCapability({
          read: {
            metadata: { permissions: [] },
            invoke() {
              throw new Error('private database password')
            },
          },
        }),
      }),
    ])
    const service = new KernelService({ host, kernelVersion: '0.1.0' })

    expect(await service.handleCapabilityCall(call('test.missing'))).toMatchObject({
      status: 'error',
      error: { code: 'KERNEL_NOT_STARTED' },
    })

    await service.start()

    expect(await service.handleCapabilityCall(call('test.missing'))).toMatchObject({
      status: 'error',
      error: { code: 'CAPABILITY_NOT_FOUND' },
    })
    expect(await service.handleCapabilityCall(call(PlainToken.id))).toMatchObject({
      status: 'error',
      error: { code: 'CAPABILITY_NOT_CALLABLE' },
    })
    const thrown = await service.handleCapabilityCall(call(ThrowingToken.id))
    expect(thrown).toMatchObject({
      status: 'error',
      error: {
        code: 'CAPABILITY_CALL_FAILED',
        message: 'Capability call failed',
      },
    })
    expect(JSON.stringify(thrown)).not.toContain('password')
    expect(
      await service.handleCapabilityCall({
        protocolVersion: 1,
        callId: 'bad-protocol',
      }),
    ).toMatchObject({
      callId: 'bad-protocol',
      status: 'error',
      error: { code: 'INVALID_REQUEST' },
    })
  })

  test('passes every protected capability call through the host permission broker', async () => {
    const observed: string[] = []
    const permissionBroker: KernelPermissionBroker = {
      request: async (request) => {
        observed.push(
          `${request.moduleId}:${request.generation}:${request.permission}`,
        )
        return request.permission === 'test.allowed'
          ? { status: 'granted' }
          : { status: 'denied', reason: 'blocked' }
      },
    }
    const host = new KernelModuleHost({ apiVersion: 1, permissionBroker })
    host.registerModule(
      moduleDefinition({
        id: 'module.protected',
        token: CallableToken,
        permissions: ['test.allowed', 'test.denied'],
        service: createKernelCallableCapability({
          read: {
            metadata: {
              permissions: ['test.allowed', 'test.denied'],
            },
            invoke: () => 'must-not-run',
          },
        }),
      }),
    )
    const service = new KernelService({ host, kernelVersion: '0.1.0' })
    await service.start()

    expect(await service.handleCapabilityCall(call(CallableToken.id)))
      .toMatchObject({
        status: 'error',
        error: { code: 'PERMISSION_DENIED' },
      })
    expect(observed).toEqual([
      'module.protected:1:test.allowed',
      'module.protected:1:test.denied',
    ])
  })

  test('disposes modules once and rejects calls after disposal', async () => {
    let disposeCount = 0
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.registerModule(
      moduleDefinition({
        id: 'module.callable',
        token: CallableToken,
        service: { invoke: () => 'ok' },
        dispose: () => {
          disposeCount += 1
        },
      }),
    )
    const service = new KernelService({ host, kernelVersion: '0.1.0' })
    await service.start()

    await service.dispose()
    await service.dispose()

    expect(disposeCount).toBe(1)
    expect(service.getStatus()).toBe('disposed')
    expect(await service.health()).toMatchObject({ status: 'stopped' })
    expect(await service.handleCapabilityCall(call(CallableToken.id))).toMatchObject({
      status: 'error',
      error: { code: 'KERNEL_NOT_STARTED', retryable: false },
    })
  })
})
