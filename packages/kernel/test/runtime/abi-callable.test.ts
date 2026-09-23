import { describe, expect, test } from 'bun:test'

import { KernelCallErrorCodes } from '../../src/contract/constants'
import { kernelModules } from '../../src/impl/runtime/KernelModuleKit'

describe('callable capability contract', () => {
  test('exposes immutable per-operation metadata and invokes declared operations', async () => {
    const service = kernelModules.callable({
      read: {
        metadata: {
          permissions: ['fs:read'],
          reason: 'Read an injected resource.',
        },
        invoke: (_scope, input) => ({ input }),
      },
    })

    const metadata = service.getOperationMetadata('read')
    expect(metadata).toEqual({
      permissions: ['fs:read'],
      reason: 'Read an injected resource.',
    })
    expect(Object.isFrozen(metadata)).toBe(true)
    expect(Object.isFrozen(metadata?.permissions)).toBe(true)
    expect(
      await service.invoke('read', undefined, { path: 'a.ts' }, new AbortController().signal)
    ).toEqual({ input: { path: 'a.ts' } })
  })

  test('fails closed for unknown and aborted operations', async () => {
    const service = kernelModules.callable({
      ping: {
        metadata: { permissions: [] },
        invoke: () => 'pong',
      },
    })

    expect(service.getOperationMetadata('toString')).toBeUndefined()
    expect(() => service.invoke('missing', undefined, {}, new AbortController().signal)).toThrow(
      expect.objectContaining({ code: KernelCallErrorCodes.operationNotFound })
    )

    const controller = new AbortController()
    controller.abort()
    expect(() => service.invoke('ping', undefined, {}, controller.signal)).toThrow(
      '能力调用已被中止'
    )
  })

  test('rejects empty and duplicate permission declarations', () => {
    expect(() =>
      kernelModules.callable({
        bad: {
          metadata: { permissions: ['fs:read', 'fs:read'] },
          invoke: () => undefined,
        },
      })
    ).toThrow('重复的权限名')

    expect(() =>
      kernelModules.callable({
        bad: {
          metadata: { permissions: [''] },
          invoke: () => undefined,
        },
      })
    ).toThrow('空的权限名')
  })
})
