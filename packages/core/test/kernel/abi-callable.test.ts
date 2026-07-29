import { describe, expect, test } from 'bun:test'

import {
  createKernelCallableCapability,
  UnknownKernelCapabilityOperationError,
} from '../../src/kernel/abi'

describe('callable capability contract', () => {
  test('exposes immutable per-operation metadata and invokes declared operations', async () => {
    const service = createKernelCallableCapability({
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
    expect(await service.invoke(
      'read',
      undefined,
      { path: 'a.ts' },
      new AbortController().signal,
    )).toEqual({ input: { path: 'a.ts' } })
  })

  test('fails closed for unknown and aborted operations', async () => {
    const service = createKernelCallableCapability({
      ping: {
        metadata: { permissions: [] },
        invoke: () => 'pong',
      },
    })

    expect(service.getOperationMetadata('toString')).toBeUndefined()
    expect(() =>
      service.invoke(
        'missing',
        undefined,
        {},
        new AbortController().signal,
      )).toThrow(UnknownKernelCapabilityOperationError)

    const controller = new AbortController()
    controller.abort()
    expect(() =>
      service.invoke('ping', undefined, {}, controller.signal)).toThrow(
        'Capability invocation aborted',
      )
  })

  test('rejects empty and duplicate permission declarations', () => {
    expect(() =>
      createKernelCallableCapability({
        bad: {
          metadata: { permissions: ['fs:read', 'fs:read'] },
          invoke: () => undefined,
        },
      })).toThrow('duplicate permissions')

    expect(() =>
      createKernelCallableCapability({
        bad: {
          metadata: { permissions: [''] },
          invoke: () => undefined,
        },
      })).toThrow('empty permission')
  })
})
