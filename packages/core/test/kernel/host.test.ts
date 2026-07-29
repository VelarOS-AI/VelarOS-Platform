import { describe, expect, test } from 'bun:test'

import {
  type CapabilityToken,
  createCapabilityToken,
  type KernelModuleActivateContext,
  type KernelModuleDefinition,
  type KernelModuleIsolation,
  type KernelPermissionBroker,
} from '../../src/kernel/abi'
import {
  KernelHostError,
  KernelModuleHost,
  KernelStartupError,
} from '../../src/kernel/host'

interface ValueService {
  read(): string
}

const ValueCapability = createCapabilityToken<ValueService>('test.value')
const DerivedCapability = createCapabilityToken<ValueService>('test.derived')
const CompatibleVersionCapability = createCapabilityToken<ValueService>(
  'test.versioned',
  '1.4.0',
)
const IncompatibleVersionCapability = createCapabilityToken<ValueService>(
  'test.versioned',
  '2.0.0',
)

function moduleDefinition(options: {
  id: string
  version?: string
  provides?: readonly CapabilityToken[]
  requires?: KernelModuleDefinition['manifest']['requires']
  optionalRequires?: KernelModuleDefinition['manifest']['optionalRequires']
  permissions?: readonly string[]
  isolation?: KernelModuleIsolation
  activate?: KernelModuleDefinition['activate']
}): KernelModuleDefinition {
  return {
    manifest: {
      id: options.id,
      version: options.version ?? '1.0.0',
      apiVersion: 1,
      provides: options.provides ?? [],
      requires: options.requires ?? [],
      optionalRequires: options.optionalRequires ?? [],
      permissions: options.permissions ?? [],
      isolation: options.isolation ?? 'in-process',
    },
    activate: options.activate ?? (() => {}),
  }
}

describe('KernelModuleHost', () => {
  test('resolves and starts dependencies deterministically', async () => {
    const activationOrder: string[] = []
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.registerModules([
      moduleDefinition({
        id: 'module.z-consumer',
        requires: [{ id: ValueCapability.id, versionRange: '^1.0.0' }],
        activate(context) {
          activationOrder.push(context.moduleId)
          expect(context.services.get(ValueCapability).read()).toBe('ready')
        },
      }),
      moduleDefinition({
        id: 'module.b-independent',
        activate(context) {
          activationOrder.push(context.moduleId)
        },
      }),
      moduleDefinition({
        id: 'module.a-provider',
        provides: [ValueCapability],
        activate(context) {
          activationOrder.push(context.moduleId)
          context.registerService(ValueCapability, { read: () => 'ready' })
        },
      }),
    ])

    expect(host.resolvePlan().order).toEqual([
      'module.a-provider',
      'module.b-independent',
      'module.z-consumer',
    ])
    await host.start()

    expect(activationOrder).toEqual([
      'module.a-provider',
      'module.b-independent',
      'module.z-consumer',
    ])
    expect(host.getService(ValueCapability).read()).toBe('ready')
  })

  test('uses optional capabilities when compatible and ignores them when absent', () => {
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.registerModules([
      moduleDefinition({
        id: 'module.a-consumer',
        optionalRequires: [
          { id: ValueCapability.id, versionRange: '^1.0.0' },
          { id: 'test.absent' },
        ],
      }),
      moduleDefinition({
        id: 'module.z-provider',
        provides: [ValueCapability],
      }),
    ])

    expect(host.resolvePlan().order).toEqual([
      'module.z-provider',
      'module.a-consumer',
    ])
  })

  test('delivers attributed events and removes subscriptions on disposal', async () => {
    const received: string[] = []
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.registerModules([
      moduleDefinition({
        id: 'module.publisher',
        provides: [ValueCapability],
        activate(context) {
          context.registerService(ValueCapability, { read: () => 'value' })
          return {
            ready: async () => {
              await context.events.publish('test.changed', 'payload')
            },
          }
        },
      }),
      moduleDefinition({
        id: 'module.subscriber',
        requires: [{ id: ValueCapability.id }],
        activate(context) {
          context.events.subscribe<string>('test.changed', (event) => {
            received.push(
              `${event.sourceModuleId}:${event.sequence}:${event.payload}`,
            )
          })
        },
      }),
    ])

    await host.start()
    expect(received).toEqual(['module.publisher:1:payload'])
    await host.dispose()
    expect(host.getOptionalService(ValueCapability)).toBeUndefined()
  })

  test('rolls a failed ready phase back in reverse dependency order', async () => {
    const disposalOrder: string[] = []
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.registerModules([
      moduleDefinition({
        id: 'module.provider',
        provides: [ValueCapability],
        activate(context) {
          context.registerService(ValueCapability, { read: () => 'value' })
          return {
            dispose: () => {
              disposalOrder.push(context.moduleId)
            },
          }
        },
      }),
      moduleDefinition({
        id: 'module.consumer',
        provides: [DerivedCapability],
        requires: [{ id: ValueCapability.id }],
        activate(context) {
          context.registerService(DerivedCapability, { read: () => 'derived' })
          return {
            ready: () => {
              throw new Error('not ready')
            },
            dispose: () => {
              disposalOrder.push(context.moduleId)
            },
          }
        },
      }),
    ])

    const failure = await host.start().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(KernelStartupError)
    expect((failure as KernelStartupError).phase).toBe('ready')
    expect(disposalOrder).toEqual(['module.consumer', 'module.provider'])
    expect(host.getOptionalService(ValueCapability)).toBeUndefined()
    expect(host.getOptionalService(DerivedCapability)).toBeUndefined()
    expect(host.getModule('module.consumer')?.status).toBe('failed')
    expect(host.getModule('module.provider')?.status).toBe('disposed')
  })

  test('suspends and disposes consumers before providers', async () => {
    const lifecycleOrder: string[] = []
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.registerModules([
      moduleDefinition({
        id: 'module.provider',
        provides: [ValueCapability],
        activate(context) {
          context.registerService(ValueCapability, { read: () => 'value' })
          return {
            suspend: () => {
              lifecycleOrder.push(`suspend:${context.moduleId}`)
            },
            dispose: () => {
              lifecycleOrder.push(`dispose:${context.moduleId}`)
            },
          }
        },
      }),
      moduleDefinition({
        id: 'module.consumer',
        requires: [{ id: ValueCapability.id }],
        activate(context) {
          return {
            suspend: () => {
              lifecycleOrder.push(`suspend:${context.moduleId}`)
            },
            dispose: () => {
              lifecycleOrder.push(`dispose:${context.moduleId}`)
            },
          }
        },
      }),
    ])

    await host.start()
    await host.suspend()
    await host.dispose()

    expect(lifecycleOrder).toEqual([
      'suspend:module.consumer',
      'suspend:module.provider',
      'dispose:module.consumer',
      'dispose:module.provider',
    ])
  })

  test('rejects missing, incompatible, duplicate, and cyclic graphs', () => {
    const missingHost = new KernelModuleHost({ apiVersion: 1 })
    missingHost.registerModule(
      moduleDefinition({
        id: 'module.missing',
        requires: [{ id: ValueCapability.id }],
      }),
    )
    expectHostError(missingHost, 'MISSING_CAPABILITY')

    const compatibleHost = new KernelModuleHost({ apiVersion: 1 })
    compatibleHost.registerModules([
      moduleDefinition({
        id: 'module.provider',
        version: '9.0.0',
        provides: [CompatibleVersionCapability],
      }),
      moduleDefinition({
        id: 'module.consumer',
        version: '0.1.0',
        requires: [{
          id: CompatibleVersionCapability.id,
          versionRange: '^1.0.0',
        }],
      }),
    ])
    expect(compatibleHost.resolvePlan().order).toEqual([
      'module.provider',
      'module.consumer',
    ])

    const incompatibleHost = new KernelModuleHost({ apiVersion: 1 })
    incompatibleHost.registerModules([
      moduleDefinition({
        id: 'module.provider',
        version: '9.0.0',
        provides: [IncompatibleVersionCapability],
      }),
      moduleDefinition({
        id: 'module.consumer',
        version: '0.1.0',
        requires: [{
          id: IncompatibleVersionCapability.id,
          versionRange: '^1.0.0',
        }],
      }),
    ])
    expectHostError(incompatibleHost, 'VERSION_MISMATCH')

    const duplicateHost = new KernelModuleHost({ apiVersion: 1 })
    duplicateHost.registerModules([
      moduleDefinition({
        id: 'module.first',
        provides: [ValueCapability],
      }),
      moduleDefinition({
        id: 'module.second',
        provides: [ValueCapability],
      }),
    ])
    expectHostError(duplicateHost, 'DUPLICATE_CAPABILITY')

    const cyclicHost = new KernelModuleHost({ apiVersion: 1 })
    cyclicHost.registerModules([
      moduleDefinition({
        id: 'module.first',
        provides: [ValueCapability],
        requires: [{ id: DerivedCapability.id }],
      }),
      moduleDefinition({
        id: 'module.second',
        provides: [DerivedCapability],
        requires: [{ id: ValueCapability.id }],
      }),
    ])
    expectHostError(cyclicHost, 'CYCLIC_DEPENDENCY')
  })

  test('blocks hidden service dependencies and undeclared providers', async () => {
    const hiddenConsumerHost = new KernelModuleHost({ apiVersion: 1 })
    hiddenConsumerHost.registerModules([
      moduleDefinition({
        id: 'module.provider',
        provides: [ValueCapability],
        activate(context) {
          context.registerService(ValueCapability, { read: () => 'value' })
        },
      }),
      moduleDefinition({
        id: 'module.consumer',
        activate(context) {
          context.services.get(ValueCapability)
        },
      }),
    ])

    const hiddenFailure = await hiddenConsumerHost.start()
      .catch((error: unknown) => error)
    expect(hiddenFailure).toBeInstanceOf(KernelStartupError)
    expect(
      (hiddenFailure as KernelStartupError).cause,
    ).toBeInstanceOf(KernelHostError)
    expect(
      ((hiddenFailure as KernelStartupError).cause as KernelHostError).code,
    ).toBe('UNDECLARED_CAPABILITY_ACCESS')

    const undeclaredProviderHost = new KernelModuleHost({ apiVersion: 1 })
    undeclaredProviderHost.registerModule(
      moduleDefinition({
        id: 'module.invalid-provider',
        activate(context) {
          context.registerService(ValueCapability, { read: () => 'value' })
        },
      }),
    )
    const providerFailure = await undeclaredProviderHost.start()
      .catch((error: unknown) => error)
    expect(providerFailure).toBeInstanceOf(KernelStartupError)
    expect(
      ((providerFailure as KernelStartupError).cause as KernelHostError).code,
    ).toBe('UNDECLARED_CAPABILITY_PROVIDER')

    const wrongVersionToken = createCapabilityToken<ValueService>(
      ValueCapability.id,
      '1.1.0',
    )
    const wrongVersionHost = new KernelModuleHost({ apiVersion: 1 })
    wrongVersionHost.registerModule(
      moduleDefinition({
        id: 'module.wrong-version',
        provides: [ValueCapability],
        activate(context) {
          context.registerService(wrongVersionToken, {
            read: () => 'wrong-version',
          })
        },
      }),
    )
    const wrongVersionFailure = await wrongVersionHost.start()
      .catch((error: unknown) => error)
    expect(
      ((wrongVersionFailure as KernelStartupError).cause as KernelHostError)
        .code,
    ).toBe('UNDECLARED_CAPABILITY_PROVIDER')
  })

  test('reports module health without interpreting capability details', async () => {
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.registerModule(
      moduleDefinition({
        id: 'module.health',
        activate() {
          return {
            health: () => ({
              status: 'degraded',
              details: { queueDepth: 3 },
            }),
          }
        },
      }),
    )

    await host.start()
    const snapshots = await host.checkHealth()

    expect(snapshots[0]?.health).toEqual({
      status: 'degraded',
      details: { queueDepth: 3 },
    })
  })

  test('invalidates captured module contexts and never disposes twice', async () => {
    let capturedContext: KernelModuleActivateContext | undefined
    let disposeCount = 0
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.registerModule(
      moduleDefinition({
        id: 'module.context',
        provides: [ValueCapability],
        activate(context) {
          capturedContext = context
          context.registerService(ValueCapability, { read: () => 'value' })
          return {
            ready: () => {
              throw new Error('ready failed')
            },
            dispose: () => {
              disposeCount += 1
            },
          }
        },
      }),
    )

    await host.start().catch(() => undefined)
    expect(() =>
      capturedContext?.registerService(
        ValueCapability,
        { read: () => 'resurrected' },
      )).toThrow(KernelHostError)
    await host.dispose()

    expect(disposeCount).toBe(1)
    expect(host.getOptionalService(ValueCapability)).toBeUndefined()
  })

  test('revokes old generations while retaining namespaced module state', async () => {
    let originalContext: KernelModuleActivateContext | undefined
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.registerModule(
      moduleDefinition({
        id: 'module.replaceable',
        provides: [ValueCapability],
        async activate(context) {
          originalContext = context
          await context.state.set('counter', 1)
          context.registerService(ValueCapability, { read: () => 'v1' })
        },
      }),
    )

    await host.start()
    const oldHandle = host.getServiceHandle(ValueCapability)
    const oldService = oldHandle.get()
    expect(oldService.read()).toBe('v1')

    await host.replaceModule(
      moduleDefinition({
        id: 'module.replaceable',
        version: '1.1.0',
        provides: [ValueCapability],
        async activate(context) {
          const previous = await context.state.get<number>('counter')
          context.registerService(ValueCapability, {
            read: () => `v2:${previous}`,
          })
        },
      }),
    )

    expect(host.getModule('module.replaceable')?.generation).toBe(2)
    expect(host.getService(ValueCapability).read()).toBe('v2:1')
    expect(oldHandle.isActive()).toBe(false)
    expect(() => oldHandle.get()).toThrow(KernelHostError)
    expect(() => oldService.read()).toThrow(KernelHostError)
    await expect(originalContext!.state.get('counter')).rejects
      .toBeInstanceOf(KernelHostError)
  })

  test('leases frozen services without violating Proxy invariants', async () => {
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.registerModule(
      moduleDefinition({
        id: 'module.frozen-service',
        provides: [ValueCapability],
        activate(context) {
          context.registerService(
            ValueCapability,
            Object.freeze({ read: () => 'frozen' }),
          )
        },
      }),
    )

    await host.start()
    const handle = host.getServiceHandle(ValueCapability)
    const service = handle.get()

    expect(service.read()).toBe('frozen')
    expect(Object.keys(service)).toEqual([])
    expect(Object.getOwnPropertyDescriptor(service, 'read')).toBeUndefined()

    await host.dispose()
    expect(handle.isActive()).toBeFalse()
    expect(() => service.read()).toThrow(KernelHostError)
  })

  test('keeps the current graph live when a staged replacement fails', async () => {
    let replacementContext: KernelModuleActivateContext | undefined
    const deliveredEvents: string[] = []
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.subscribe<string>('replacement.ready', (event) => {
      deliveredEvents.push(event.payload)
    })
    host.registerModule(
      moduleDefinition({
        id: 'module.atomic-replace',
        provides: [ValueCapability],
        activate(context) {
          context.registerService(ValueCapability, { read: () => 'stable' })
        },
      }),
    )
    await host.start()
    const stableService = host.getService(ValueCapability)

    const failure = await host.replaceModule(
      moduleDefinition({
        id: 'module.atomic-replace',
        version: '2.0.0',
        provides: [ValueCapability],
        activate(context) {
          replacementContext = context
          context.registerService(ValueCapability, { read: () => 'broken' })
          return {
            async ready() {
              await context.events.publish('replacement.ready', 'staged')
              throw new Error('replacement failed')
            },
          }
        },
      }),
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(KernelStartupError)
    expect(host.getModule('module.atomic-replace')?.generation).toBe(1)
    expect(host.getModule('module.atomic-replace')?.status).toBe('ready')
    expect(host.getService(ValueCapability).read()).toBe('stable')
    expect(stableService.read()).toBe('stable')
    expect(deliveredEvents).toEqual([])
    expect(() =>
      replacementContext?.registerService(
        ValueCapability,
        { read: () => 'resurrected' },
      )).toThrow(KernelHostError)
  })

  test('rejects service resolution through the wrong capability version', async () => {
    const host = new KernelModuleHost({ apiVersion: 1 })
    host.registerModule(
      moduleDefinition({
        id: 'module.versioned-service',
        provides: [ValueCapability],
        activate(context) {
          context.registerService(ValueCapability, { read: () => 'value' })
        },
      }),
    )
    await host.start()
    const wrongVersion = createCapabilityToken<ValueService>(
      ValueCapability.id,
      '2.0.0',
    )

    expect(host.getOptionalService(wrongVersion)).toBeUndefined()
    expect(() => host.getService(wrongVersion)).toThrow(KernelHostError)
  })

  test('denies permissions by default and binds broker identity in the host', async () => {
    const observedRequests: string[] = []
    const permissionBroker: KernelPermissionBroker = {
      request: async (request) => {
        observedRequests.push(
          `${request.moduleId}:${request.generation}:${request.permission}`,
        )
        return { status: 'granted', grantId: 'grant-1' }
      },
    }
    let declaredStatus: string | undefined
    let undeclaredStatus: string | undefined
    const host = new KernelModuleHost({
      apiVersion: 1,
      permissionBroker,
    })
    host.registerModule(
      moduleDefinition({
        id: 'module.permission',
        provides: [ValueCapability],
        permissions: ['test.read'],
        async activate(context) {
          context.registerService(ValueCapability, { read: () => 'value' })
          declaredStatus = (
            await context.permissions.request({ permission: 'test.read' })
          ).status
          undeclaredStatus = (
            await context.permissions.request({ permission: 'test.write' })
          ).status
        },
      }),
    )

    await host.start()
    expect(declaredStatus).toBe('granted')
    expect(undeclaredStatus).toBe('denied')
    expect(
      await host.requestCapabilityPermission(
        ValueCapability,
        { permission: 'test.read' },
      ),
    ).toMatchObject({ status: 'granted' })
    expect(
      await host.requestCapabilityPermission(
        ValueCapability,
        { permission: 'test.write' },
      ),
    ).toMatchObject({ status: 'denied' })
    expect(observedRequests).toEqual([
      'module.permission:1:test.read',
      'module.permission:1:test.read',
    ])

    let defaultStatus: string | undefined
    const defaultHost = new KernelModuleHost({ apiVersion: 1 })
    defaultHost.registerModule(
      moduleDefinition({
        id: 'module.default-deny',
        permissions: ['test.read'],
        async activate(context) {
          defaultStatus = (
            await context.permissions.request({ permission: 'test.read' })
          ).status
        },
      }),
    )
    await defaultHost.start()
    expect(defaultStatus).toBe('denied')
  })

  test('requires isolation adapters and never invokes external modules locally', async () => {
    let localActivateCalled = false
    const missingAdapterHost = new KernelModuleHost({ apiVersion: 1 })
    missingAdapterHost.registerModule(
      moduleDefinition({
        id: 'module.external',
        isolation: 'sidecar',
        activate() {
          localActivateCalled = true
        },
      }),
    )

    const missingFailure = await missingAdapterHost.start()
      .catch((error: unknown) => error)
    expect(missingFailure).toBeInstanceOf(KernelStartupError)
    expect(
      ((missingFailure as KernelStartupError).cause as KernelHostError).code,
    ).toBe('MISSING_ISOLATION_ADAPTER')
    expect(localActivateCalled).toBe(false)

    let adapterActivateCalled = false
    const adaptedHost = new KernelModuleHost({
      apiVersion: 1,
      isolationAdapters: [{
        isolation: 'sidecar',
        activate: (_module, context) => {
          adapterActivateCalled = true
          context.registerService(ValueCapability, {
            read: () => 'isolated',
          })
        },
      }],
    })
    adaptedHost.registerModule(
      moduleDefinition({
        id: 'module.adapted',
        isolation: 'sidecar',
        provides: [ValueCapability],
        activate() {
          localActivateCalled = true
        },
      }),
    )

    await adaptedHost.start()
    expect(adapterActivateCalled).toBe(true)
    expect(localActivateCalled).toBe(false)
    expect(adaptedHost.getService(ValueCapability).read()).toBe('isolated')
  })
})

function expectHostError(
  host: KernelModuleHost,
  code: KernelHostError['code'],
): void {
  try {
    host.resolvePlan()
    throw new Error('Expected host plan to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(KernelHostError)
    expect((error as KernelHostError).code).toBe(code)
  }
}
