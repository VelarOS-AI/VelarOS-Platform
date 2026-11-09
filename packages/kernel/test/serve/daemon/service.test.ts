import { describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import type {
  KernelClientAccessBroker,
  KernelModuleDefinition,
} from '../../../src/contract/requires'
import type { KernelPermissionBroker } from '../../../src/contract/requires'
import { KernelClient } from '../../../src/impl/client/KernelClient'
import { KernelModuleHost } from '../../../src/impl/runtime/KernelModuleHost'
import { kernelModules } from '../../../src/impl/runtime/KernelModuleKit'
import { InProcessKernelTransport } from '../../../src/impl/serve/InProcessKernelTransport'
import { KernelService } from '../../../src/impl/serve/KernelService'
import type { KernelModuleHealth } from '../../../src/types/kernel'
import type { KernelModCatalog } from '../../../src/types/serve'
import type { CapabilityCallRequest } from '../../../src/utils/wire/capability'
import { KernelProtocolVersion } from '../../../src/utils/wire/version'

const CallableToken = kernelModules.token('test.callable', '1.2.0')
const PlainToken = kernelModules.token('test.plain')
const ThrowingToken = kernelModules.token('test.throwing')

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

function call(capabilityId: string, operation = 'read'): CapabilityCallRequest {
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}

function lifecycleService(
  options: {
    readonly invoke?: (signal: AbortSignal, input: unknown) => unknown
    readonly health?: () => KernelModuleHealth | Promise<KernelModuleHealth>
    readonly clientAccessBroker?: KernelClientAccessBroker
    readonly modCatalog?: KernelModCatalog
  } = {}
) {
  const host = new KernelModuleHost({ apiVersion: 1 })
  let publish!: (payload: unknown) => Promise<unknown>
  host.registerModule({
    manifest: {
      id: 'module.lifecycle',
      version: '1.0.0',
      apiVersion: 1,
      provides: [CallableToken],
      requires: [],
      optionalRequires: [],
      permissions: [],
      isolation: 'in-process',
    },
    activate(context) {
      context.registerService(
        CallableToken,
        kernelModules.callable({
          read: {
            metadata: { permissions: [] },
            invoke: (_scope, input, signal) =>
              options.invoke ? options.invoke(signal, input) : 'local-output',
          },
        })
      )
      publish = (payload) => context.events.publish('test.lifecycle', payload)
      return { health: options.health }
    },
  })
  const service = new KernelService({
    host,
    kernelVersion: '0.1.0',
    clientAccessBroker: options.clientAccessBroker ?? {
      requestBind: async () => ({ status: 'granted' as const }),
    },
    modCatalog: options.modCatalog,
  })
  return { service, publish: (payload: unknown) => publish(payload) }
}

function clientRequest(input: unknown = null, callId = 'client-call') {
  return {
    protocolVersion: KernelProtocolVersion,
    callId,
    capabilityId: CallableToken.id,
    operation: 'read',
    scope: null,
    input,
  } as const
}

function openReadSession(client: KernelClient) {
  return client.openCapabilitySession({
    requires: [{ capabilityId: CallableToken.id, operations: ['read'], scope: null }],
  })
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
    host.registerModule(
      moduleDefinition({
        id: 'module.concurrent-service',
        token: CallableToken,
        service: kernelModules.callable({}),
        ready: () => readyGate,
        dispose: () => {
          disposalCount += 1
        },
      })
    )
    const service = new KernelService({ host, kernelVersion: '0.1.0' })

    const firstStart = service.start()
    expect(service.start()).toBe(firstStart)
    const firstDispose = service.dispose()
    expect(service.dispose()).toBe(firstDispose)
    finishReady()
    await Promise.all([firstStart, firstDispose])

    expect(service.getStatus()).toBe('disposed')
    expect(disposalCount).toBe(1)
    await expect(service.start()).rejects.toThrow('已回收的 Kernel service 不能再启动')
  })

  test('builds deterministic module descriptors from host snapshots', async () => {
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.registerModule(
      moduleDefinition({
        id: 'module.callable',
        version: '2.3.4',
        token: CallableToken,
        service: { invoke: () => 'ok' },
      })
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
        service: kernelModules.callable({
          double: {
            metadata: { permissions: [] },
            invoke(scope: unknown, input: unknown, signal: AbortSignal) {
              expect(scope).toBeUndefined()
              expect(signal.aborted).toBeFalse()
              return (input as { value: number }).value * 2
            },
          },
        }),
      })
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

    expect(
      await transport.call({
        ...call(CallableToken.id, 'double'),
        sessionId: 'missing',
      })
    ).toMatchObject({
      status: 'error',
      error: { code: 'CAPABILITY_NOT_GRANTED' },
    })
    const session = await client.openCapabilitySession({
      requires: [{ capabilityId: CallableToken.id, operations: null, scope: null }],
    })
    expect(
      await session.call({
        protocolVersion: KernelProtocolVersion,
        callId: 'call-test.callable',
        capabilityId: CallableToken.id,
        operation: 'double',
        scope: null,
        input: { value: 21 },
      })
    ).toEqual({
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
        service: kernelModules.callable({
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
        message: '能力调用失败',
      },
    })
    expect(JSON.stringify(thrown)).not.toContain('password')
    expect(
      await service.handleCapabilityCall({
        protocolVersion: 1,
        callId: 'bad-protocol',
      })
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
        observed.push(`${request.moduleId}:${request.generation}:${request.permission}`)
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
        service: kernelModules.callable({
          read: {
            metadata: {
              permissions: ['test.allowed', 'test.denied'],
            },
            invoke: () => 'must-not-run',
          },
        }),
      })
    )
    const service = new KernelService({ host, kernelVersion: '0.1.0' })
    await service.start()

    // 拒绝原因必须随失败一起下发：serve 路径原来统一成一句英文、details: null，
    // 和进程内路径（消息就是 broker 给的原因）说的不是一回事。
    expect(await service.handleCapabilityCall(call(CallableToken.id))).toMatchObject({
      status: 'error',
      error: {
        code: 'PERMISSION_DENIED',
        details: { permission: 'test.denied', reason: 'blocked' },
      },
    })
    expect(observed).toEqual(['module.protected:1:test.allowed', 'module.protected:1:test.denied'])
  })

  test('启动失败后进入 failed 终态，不再谎称可重试', async () => {
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.registerModule(
      moduleDefinition({
        id: 'module.boom',
        token: CallableToken,
        service: { invoke: () => 'ok' },
        ready: () => {
          throw new Error('ready boom')
        },
      })
    )
    const service = new KernelService({ host, kernelVersion: '0.1.0' })

    const failure = await service.start().catch((error: unknown) => error)
    expect(failure).toMatchObject({ name: 'KernelError' })
    expect(service.getStatus()).toBe('failed')

    // 会话打开与能力调用都不再标「可重试」。
    expect(
      await service.evaluateCapabilitySessionOpen({
        protocolVersion: KernelProtocolVersion,
        requires: [{ capabilityId: CallableToken.id, operations: null, scope: null }],
      })
    ).toMatchObject({
      status: 'error',
      error: { code: 'KERNEL_NOT_STARTED', retryable: false },
    })
    expect(await service.handleCapabilityCall(call(CallableToken.id))).toMatchObject({
      status: 'error',
      error: { code: 'KERNEL_NOT_STARTED', retryable: false },
    })

    // 再 start() 说明白「不会重试」，而不是重放同一个启动失败。
    await expect(service.start()).rejects.toMatchObject({
      name: 'KernelError',
      code: 'KERNEL_START_FAILED',
    })
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
      })
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

describe('InProcessKernelTransport lifecycle', () => {
  test('closes every entry without closing the shared real service or another client', async () => {
    let entries = 0
    const { service } = lifecycleService({
      invoke: () => {
        entries += 1
        return 'other-client'
      },
    })
    const first = new InProcessKernelTransport(service)
    const second = new InProcessKernelTransport(service)
    const firstClient = new KernelClient(first)
    const secondClient = new KernelClient(second)
    try {
      await service.start()
      const firstSession = await openReadSession(firstClient)
      const secondSession = await openReadSession(secondClient)
      expect(
        await first.call({ ...clientRequest(), sessionId: secondSession.sessionId })
      ).toMatchObject({
        status: 'error',
        error: { code: 'CAPABILITY_NOT_GRANTED' },
      })
      first.dispose()
      first.dispose()
      const sends: Array<() => Promise<unknown>> = [
        () => first.handshake(),
        () => first.health(),
        () => first.openCapabilitySession({ protocolVersion: KernelProtocolVersion, requires: [] }),
        () =>
          first.closeCapabilitySession({
            protocolVersion: KernelProtocolVersion,
            sessionId: firstSession.sessionId,
          }),
        () => first.call({ ...clientRequest(), sessionId: firstSession.sessionId }),
        () => first.listMods({ protocolVersion: KernelProtocolVersion }),
        () =>
          first.setModEnabled({
            protocolVersion: KernelProtocolVersion,
            id: 'pack',
            enabled: true,
          }),
        () =>
          first.installModFromDirectory({
            protocolVersion: KernelProtocolVersion,
            directory: 'pack',
          }),
        () => first.subscribe('test.lifecycle', () => undefined),
      ]
      const outcomes = await Promise.allSettled(sends.map((send) => send()))
      for (const outcome of outcomes)
        expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'TRANSPORT_CLOSED' } })
      expect(entries).toBe(0)
      expect(service.getStatus()).toBe('started')
      expect(await secondSession.call(clientRequest())).toMatchObject({
        status: 'ok',
        output: 'other-client',
      })
      expect(entries).toBe(1)
    } finally {
      first.dispose()
      second.dispose()
      await service.dispose()
    }
  })

  test('does not enter the real provider for a pre-aborted request', async () => {
    let entries = 0
    const { service } = lifecycleService({
      invoke: () => {
        entries += 1
        return 'entered'
      },
    })
    const client = new KernelClient(new InProcessKernelTransport(service))
    try {
      await service.start()
      const session = await openReadSession(client)
      const outcomes = await Promise.allSettled([
        session.call(clientRequest(), AbortSignal.abort()),
      ])
      expect(outcomes[0]).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } })
      expect(entries).toBe(0)
      expect(await session.call(clientRequest())).toMatchObject({ status: 'ok', output: 'entered' })
      expect(entries).toBe(1)
    } finally {
      await client.dispose()
      await service.dispose()
    }
  })

  for (const close of ['caller abort', 'transport close'] as const) {
    for (const finish of ['resolve', 'reject'] as const) {
      test(`${close} ends observation while the real provider can later ${finish}`, async () => {
        const entered = deferred<AbortSignal>()
        const work = deferred<unknown>()
        const completed = deferred()
        let actualFinished = false
        const { service } = lifecycleService({
          invoke: (signal, input) => {
            if (input === 'quick') return 'quick-output'
            entered.resolve(signal)
            return work.promise.finally(() => {
              actualFinished = true
              completed.resolve()
            })
          },
        })
        const first = new KernelClient(new InProcessKernelTransport(service))
        const second = new KernelClient(new InProcessKernelTransport(service))
        try {
          await service.start()
          const session = await openReadSession(first)
          const secondSession = await openReadSession(second)
          const controller = new AbortController()
          const observation = Promise.allSettled([
            session.call(clientRequest('slow'), controller.signal),
          ])
          const actualSignal = await entered.promise
          if (close === 'caller abort') controller.abort()
          else await first.dispose()
          expect((await observation)[0]).toMatchObject({
            status: 'rejected',
            reason:
              close === 'caller abort' ? { name: 'AbortError' } : { code: 'TRANSPORT_CLOSED' },
          })
          expect(actualSignal.aborted).toBeTrue()
          expect(actualFinished).toBeFalse()
          expect(service.getStatus()).toBe('started')
          expect(await secondSession.call(clientRequest('quick'))).toMatchObject({
            status: 'ok',
            output: 'quick-output',
          })
          if (finish === 'resolve') work.resolve('late-output')
          else work.reject(new AppError('UNAVAILABLE', 'late real provider failure'))
          await completed.promise
          expect(actualFinished).toBeTrue()
          expect((await observation)[0]?.status).toBe('rejected')
        } finally {
          work.resolve('cleanup')
          await first.dispose()
          await second.dispose()
          await service.dispose()
        }
      })
    }
  }

  test('same callId requests retain independent cancellation and real completion owners', async () => {
    const firstEntered = deferred<AbortSignal>()
    const secondEntered = deferred<AbortSignal>()
    const firstWork = deferred<unknown>()
    const secondWork = deferred<unknown>()
    const firstCompleted = deferred()
    const { service } = lifecycleService({
      invoke: (signal, input) => {
        if (input === 'first') {
          firstEntered.resolve(signal)
          return firstWork.promise.finally(() => firstCompleted.resolve())
        }
        secondEntered.resolve(signal)
        return secondWork.promise
      },
    })
    const client = new KernelClient(new InProcessKernelTransport(service))
    try {
      await service.start()
      const session = await openReadSession(client)
      const controller = new AbortController()
      const firstOutcome = Promise.allSettled([
        session.call(clientRequest('first', 'same-id'), controller.signal),
      ])
      const secondOutcome = Promise.allSettled([session.call(clientRequest('second', 'same-id'))])
      const [firstSignal, secondSignal] = await Promise.all([
        firstEntered.promise,
        secondEntered.promise,
      ])
      controller.abort()
      expect((await firstOutcome)[0]).toMatchObject({
        status: 'rejected',
        reason: { name: 'AbortError' },
      })
      expect(firstSignal.aborted).toBeTrue()
      expect(secondSignal.aborted).toBeFalse()
      secondWork.resolve('second-output')
      expect((await secondOutcome)[0]).toMatchObject({
        status: 'fulfilled',
        value: { status: 'ok', output: 'second-output' },
      })
      firstWork.resolve('late-first-output')
      await firstCompleted.promise
    } finally {
      firstWork.resolve('cleanup')
      secondWork.resolve('cleanup')
      await client.dispose()
      await service.dispose()
    }
  })

  test('late real bind admission cannot revive a closed client', async () => {
    const entered = deferred()
    const admission = deferred<{ status: 'granted' }>()
    const completed = deferred()
    let binds = 0
    const { service } = lifecycleService({
      clientAccessBroker: {
        requestBind: () => {
          binds += 1
          if (binds > 1) return Promise.resolve({ status: 'granted' as const })
          entered.resolve()
          return admission.promise.finally(() => completed.resolve())
        },
      },
    })
    const first = new KernelClient(new InProcessKernelTransport(service))
    const second = new KernelClient(new InProcessKernelTransport(service))
    try {
      await service.start()
      const opening = Promise.allSettled([openReadSession(first)])
      await entered.promise
      await first.dispose()
      expect((await opening)[0]).toMatchObject({
        status: 'rejected',
        reason: { code: 'TRANSPORT_CLOSED' },
      })
      const otherSession = await openReadSession(second)
      expect(await otherSession.call(clientRequest())).toMatchObject({
        status: 'ok',
        output: 'local-output',
      })
      admission.resolve({ status: 'granted' })
      await completed.promise
      await expect(openReadSession(first)).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
      expect((await opening)[0]?.status).toBe('rejected')
      expect(binds).toBe(2)
      expect(service.getStatus()).toBe('started')
    } finally {
      admission.resolve({ status: 'granted' })
      await first.dispose()
      await second.dispose()
      await service.dispose()
    }
  })

  test('close ends health and mod observations while their real port work settles later', async () => {
    const healthEntered = deferred()
    const setEntered = deferred()
    const installEntered = deferred()
    const healthWork = deferred<KernelModuleHealth>()
    const setWork = deferred<Awaited<ReturnType<KernelModCatalog['setEnabled']>>>()
    const installWork = deferred<Awaited<ReturnType<KernelModCatalog['installFromDirectory']>>>()
    const healthCompleted = deferred()
    const setCompleted = deferred()
    const installCompleted = deferred()
    let completions = 0
    const installed = {
      pack: {
        id: 'late-pack',
        kind: 'user' as const,
        version: '1.0.0',
        enabled: true,
        provides: [],
        specifier: 'late-pack/index.mjs',
      },
      reloadRequired: true,
    }
    const { service } = lifecycleService({
      health: () => {
        healthEntered.resolve()
        return healthWork.promise.finally(() => {
          completions += 1
          healthCompleted.resolve()
        })
      },
      modCatalog: {
        list: () => [],
        setEnabled: () => {
          setEntered.resolve()
          return setWork.promise.finally(() => {
            completions += 1
            setCompleted.resolve()
          })
        },
        installFromDirectory: () => {
          installEntered.resolve()
          return installWork.promise.finally(() => {
            completions += 1
            installCompleted.resolve()
          })
        },
      },
    })
    const client = new KernelClient(new InProcessKernelTransport(service))
    try {
      await service.start()
      const outcomes = Promise.allSettled([
        client.health(),
        client.setModEnabled('pack', true),
        client.installModFromDirectory('late-pack'),
      ])
      await Promise.all([healthEntered.promise, setEntered.promise, installEntered.promise])
      await client.dispose()
      for (const outcome of await outcomes)
        expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'TRANSPORT_CLOSED' } })
      expect(completions).toBe(0)
      expect(service.getStatus()).toBe('started')
      healthWork.resolve({ status: 'healthy' })
      setWork.reject(new AppError('UNAVAILABLE', 'late real mod failure'))
      installWork.resolve(installed)
      await Promise.all([healthCompleted.promise, setCompleted.promise, installCompleted.promise])
      expect(completions).toBe(3)
      expect(service.getStatus()).toBe('started')
    } finally {
      healthWork.resolve({ status: 'healthy' })
      setWork.resolve({ ok: false, reloadRequired: false })
      installWork.resolve(installed)
      await client.dispose()
      await service.dispose()
    }
  })

  for (const close of ['handle', 'transport'] as const) {
    test(`${close} disposal suppresses a real publish snapshot delivery without stopping another client`, async () => {
      const entered = deferred()
      const release = deferred()
      const fixture = lifecycleService()
      const first = new KernelClient(new InProcessKernelTransport(fixture.service))
      const second = new KernelClient(new InProcessKernelTransport(fixture.service))
      try {
        await fixture.service.start()
        let block = true
        let otherCalls = 0
        let targetCalls = 0
        let survivorCalls = 0
        await second.subscribe('test.lifecycle', async () => {
          otherCalls += 1
          if (!block) return
          block = false
          entered.resolve()
          await release.promise
        })
        const target = await first.subscribe('test.lifecycle', () => {
          targetCalls += 1
        })
        await first.subscribe('test.lifecycle', () => {
          survivorCalls += 1
        })
        const publishing = fixture.publish('snapshotted')
        await entered.promise
        if (close === 'handle') await target.dispose()
        else await first.dispose()
        release.resolve()
        await publishing
        expect(targetCalls).toBe(0)
        expect(survivorCalls).toBe(close === 'handle' ? 1 : 0)
        expect(otherCalls).toBe(1)
        await fixture.publish('after disposal')
        expect(targetCalls).toBe(0)
        expect(survivorCalls).toBe(close === 'handle' ? 2 : 0)
        expect(otherCalls).toBe(2)
        await target.dispose()
      } finally {
        release.resolve()
        await first.dispose()
        await second.dispose()
        await fixture.service.dispose()
      }
    })
  }

  test('an entered event handler finishes after close while later deliveries stay closed', async () => {
    const entered = deferred()
    const release = deferred()
    const fixture = lifecycleService()
    const first = new KernelClient(new InProcessKernelTransport(fixture.service))
    const second = new KernelClient(new InProcessKernelTransport(fixture.service))
    try {
      await fixture.service.start()
      let firstCalls = 0
      let otherCalls = 0
      let finished = false
      await first.subscribe('test.lifecycle', async () => {
        firstCalls += 1
        entered.resolve()
        await release.promise
        finished = true
      })
      await second.subscribe('test.lifecycle', () => {
        otherCalls += 1
      })
      const publishing = fixture.publish('entered')
      await entered.promise
      await first.dispose()
      expect(finished).toBeFalse()
      expect(otherCalls).toBe(0)
      release.resolve()
      await publishing
      expect(finished).toBeTrue()
      expect(otherCalls).toBe(1)
      await fixture.publish('later')
      expect(firstCalls).toBe(1)
      expect(otherCalls).toBe(2)
    } finally {
      release.resolve()
      await first.dispose()
      await second.dispose()
      await fixture.service.dispose()
    }
  })

  test('a synchronously acquired subscription cannot return a live handle after transport close', async () => {
    const fixture = lifecycleService()
    const first = new KernelClient(new InProcessKernelTransport(fixture.service))
    const second = new KernelClient(new InProcessKernelTransport(fixture.service))
    try {
      await fixture.service.start()
      let firstCalls = 0
      let otherCalls = 0
      const subscribing = Promise.allSettled([
        first.subscribe('test.lifecycle', () => {
          firstCalls += 1
        }),
      ])
      await first.dispose()
      expect((await subscribing)[0]).toMatchObject({
        status: 'rejected',
        reason: { code: 'TRANSPORT_CLOSED' },
      })
      await second.subscribe('test.lifecycle', () => {
        otherCalls += 1
      })
      await fixture.publish('after close')
      expect(firstCalls).toBe(0)
      expect(otherCalls).toBe(1)
    } finally {
      await first.dispose()
      await second.dispose()
      await fixture.service.dispose()
    }
  })

  test('completed requests release both the caller listener and transport cancellation owner', async () => {
    let actualSignal: AbortSignal | undefined
    const { service } = lifecycleService({
      invoke: (signal) => {
        actualSignal = signal
        return 'complete'
      },
    })
    const client = new KernelClient(new InProcessKernelTransport(service))
    try {
      await service.start()
      const session = await openReadSession(client)
      const controller = new AbortController()
      expect(await session.call(clientRequest(), controller.signal)).toMatchObject({
        status: 'ok',
        output: 'complete',
      })
      expect(actualSignal?.aborted).toBeFalse()
      controller.abort()
      expect(actualSignal?.aborted).toBeFalse()
      await client.dispose()
      expect(actualSignal?.aborted).toBeFalse()
    } finally {
      await client.dispose()
      await service.dispose()
    }
  })

  test('closing a session revokes future admission without cancelling an already admitted call', async () => {
    const entered = deferred<AbortSignal>()
    const work = deferred<unknown>()
    const { service } = lifecycleService({
      invoke: (signal, input) => {
        if (input === 'quick') return 'quick-output'
        entered.resolve(signal)
        return work.promise
      },
    })
    const transport = new InProcessKernelTransport(service)
    const client = new KernelClient(transport)
    try {
      await service.start()
      const session = await openReadSession(client)
      const outcome = Promise.allSettled([session.call(clientRequest('slow'))])
      const actualSignal = await entered.promise
      expect(await session.dispose()).toMatchObject({ closed: true })
      expect(actualSignal.aborted).toBeFalse()
      expect(
        await transport.call({ ...clientRequest('quick'), sessionId: session.sessionId })
      ).toMatchObject({
        status: 'error',
        error: { code: 'CAPABILITY_NOT_GRANTED' },
      })
      const nextSession = await openReadSession(client)
      expect(await nextSession.call(clientRequest('quick'))).toMatchObject({
        status: 'ok',
        output: 'quick-output',
      })
      work.resolve('admitted-output')
      expect((await outcome)[0]).toMatchObject({
        status: 'fulfilled',
        value: { status: 'ok', output: 'admitted-output' },
      })
    } finally {
      work.resolve('cleanup')
      await client.dispose()
      await service.dispose()
    }
  })
})
