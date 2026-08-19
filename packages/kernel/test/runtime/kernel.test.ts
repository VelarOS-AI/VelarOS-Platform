import { describe, expect, test } from 'bun:test'

import {
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  type KernelPermissionBroker,
} from '../../src/contracts/abi'
import {
  Kernel,
  KernelCapabilityPermissionDeniedError,
  KernelCapabilityUnavailableError,
} from '../../src/runtime'

const ValueCapability = createCapabilityToken('test.value', '2.4.0')

function valueModule(options: {
  readonly onInvoke?: () => void
  readonly failReady?: boolean
} = {}) {
  return defineKernelModule({
    manifest: {
      id: 'test.value.module',
      version: '1.0.0',
      apiVersion: 1,
      provides: [ValueCapability],
      requires: [],
      optionalRequires: [],
      permissions: ['test:read'],
      isolation: 'in-process',
    },
    activate(context) {
      context.registerService(
        ValueCapability,
        createKernelCallableCapability({
          read: {
            metadata: {
              permissions: ['test:read'],
              reason: 'Read the test value.',
            },
            invoke: () => {
              options.onInvoke?.()
              return 'value'
            },
          },
        }),
      )
      return {
        ready() {
          if (options.failReady) throw new Error('probe ready failure')
        },
      }
    },
  })
}

describe('Kernel', () => {
  test('owns exact active-token resolution and clears visibility on dispose', async () => {
    const kernel = new Kernel()
    kernel.registerModule(valueModule())

    expect(kernel.hasCapability(ValueCapability.id)).toBeFalse()
    expect(kernel.describeComposition().capabilities[0]).toMatchObject({
      id: ValueCapability.id,
      active: false,
    })
    await kernel.start()
    expect(kernel.hasCapability(ValueCapability.id)).toBeTrue()
    expect(kernel.describeComposition().capabilities[0]).toMatchObject({
      id: ValueCapability.id,
      active: true,
      activeGeneration: 1,
    })
    expect(kernel.resolveCallableCapability(ValueCapability.id)).not.toBeNull()
    expect(kernel.getCapability(ValueCapability)).toBeDefined()

    await kernel.dispose()
    await kernel.dispose()
    expect(kernel.hasCapability(ValueCapability.id)).toBeFalse()
    expect(kernel.resolveCallableCapability(ValueCapability.id)).toBeNull()
    expect(() => kernel.registerModule(valueModule())).toThrow(
      'Kernel modules must be registered before start',
    )
    await expect(kernel.start()).rejects.toThrow(
      'Disposed Kernel cannot be started',
    )
  })

  test('checks every operation permission before provider code runs', async () => {
    let invoked = 0
    const kernel = new Kernel()
    kernel.registerModule(valueModule({ onInvoke: () => invoked += 1 }))
    await kernel.start()

    await expect(
      kernel.invokeCapability({
        capabilityId: ValueCapability.id,
        operation: 'read',
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(KernelCapabilityPermissionDeniedError)
    expect(invoked).toBe(0)
  })

  test('invokes only after the host permission authority grants the call', async () => {
    const observed: string[] = []
    const permissionBroker: KernelPermissionBroker = {
      request: (request) => {
        observed.push(
          `${request.moduleId}:${request.generation}:${request.permission}:${request.scope?.id ?? 'no-scope'}`,
        )
        return Promise.resolve({ status: 'granted', grantId: 'probe-grant' })
      },
    }
    const kernel = new Kernel({ permissionBroker })
    kernel.registerModule(valueModule())
    await kernel.start()

    await expect(
      kernel.invokeCapability({
        capabilityId: ValueCapability.id,
        operation: 'read',
        input: {},
        signal: new AbortController().signal,
        permissionContext: {
          permission: 'forged:permission',
          scope: {
            id: 'forged-scope',
            ownerModuleId: 'forged-owner',
          },
        } as never,
      }),
    ).resolves.toBe('value')
    expect(observed).toEqual(['test.value.module:1:test:read:no-scope'])
    await expect(
      kernel.invokeCapability({
        capabilityId: 'test.missing',
        operation: 'read',
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(KernelCapabilityUnavailableError)
  })

  test('keeps strict lifecycle by default and makes optional-host degradation explicit', async () => {
    const strict = new Kernel()
    strict.registerModule(valueModule({ failReady: true }))
    await expect(strict.start()).rejects.toThrow('failed during ready')
    expect(strict.getStatus()).toBe('degraded')

    const failures: string[] = []
    const optional = new Kernel({
      lifecycleFailureMode: 'degrade',
      onLifecycleFailure: ({ phase, error }) => failures.push(`${phase}:${error.message}`),
    })
    optional.registerModule(valueModule({ failReady: true }))
    await expect(optional.start()).resolves.toBeUndefined()
    expect(optional.getStatus()).toBe('degraded')
    expect(optional.hasCapability(ValueCapability.id)).toBeFalse()
    expect(failures).toEqual(['start:Kernel module "test.value.module" failed during ready'])
  })
})
