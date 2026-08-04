import { describe, expect, test } from 'bun:test'

import {
  KernelIdentityRegistry,
  KernelIdentityRegistryError,
} from '../../src/runtime/service'

describe('KernelIdentityRegistry', () => {
  test('owns generic session and run identity lifecycles', () => {
    let now = 100
    const registry = new KernelIdentityRegistry({ now: () => now++ })

    expect(
      registry.openSession({
        id: 'session-1',
        ownerModuleId: 'module.agent',
        scope: null,
      }),
    ).toEqual({
      id: 'session-1',
      ownerModuleId: 'module.agent',
      scope: null,
      createdAt: 100,
    })
    expect(
      registry.startRun({
        id: 'run-1',
        ownerModuleId: 'module.agent',
        sessionId: 'session-1',
      }),
    ).toEqual({
      id: 'run-1',
      ownerModuleId: 'module.agent',
      sessionId: 'session-1',
      generation: 1,
      startedAt: 101,
    })

    expect(registry.closeSession('session-1')).toBeTrue()
    expect(registry.getSession('session-1')).toBeUndefined()
    expect(registry.getRun('run-1')).toBeUndefined()

    registry.openSession({
      id: 'session-1',
      ownerModuleId: 'module.agent',
      scope: null,
    })
    expect(
      registry.startRun({
        id: 'run-1',
        ownerModuleId: 'module.agent',
        sessionId: 'session-1',
      }).generation,
    ).toBe(2)
  })

  test('rejects invalid links and duplicate active identities', () => {
    const registry = new KernelIdentityRegistry()
    registry.openSession({
      id: 'session-1',
      ownerModuleId: 'module.agent',
      scope: null,
    })

    expect(() =>
      registry.openSession({
        id: 'session-1',
        ownerModuleId: 'module.agent',
        scope: null,
      }),
    ).toThrow(KernelIdentityRegistryError)
    expect(() =>
      registry.startRun({
        id: 'run-orphan',
        ownerModuleId: 'module.agent',
        sessionId: 'missing',
      }),
    ).toThrow('Session "missing" is not active')
  })
})
