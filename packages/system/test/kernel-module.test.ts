import { describe, expect, test } from 'bun:test'

import type {
  CapabilityToken,
  KernelModuleActivateContext,
} from '@velaros-ai/core/kernel/abi'

import {
  createSystemKernelModule,
  SystemCapability,
  type SystemCapabilityService,
  type SystemToolContext,
} from '../src'

function captureService(
  capture: (tokenId: string, service: object) => void,
): KernelModuleActivateContext {
  return {
    registerService<TService extends object>(
      token: CapabilityToken<TService>,
      service: TService,
    ) {
      capture(token.id, service)
      return { dispose() {} }
    },
  } as unknown as KernelModuleActivateContext
}

describe('System Kernel module', () => {
  test('registers the precise canonical tool collection', async () => {
    let service: SystemCapabilityService | undefined
    const module = createSystemKernelModule()
    await module.activate(captureService((tokenId, registered) => {
      expect(tokenId).toBe(SystemCapability.id)
      service = registered as SystemCapabilityService
    }))

    expect(module.manifest.id).toBe('velaros.system')
    expect(Object.keys(service?.tools ?? {})).toEqual([
      'system:read',
      'system:write',
      'system:edit',
      'system:list',
      'system:search',
      'system:run',
      'system:refresh-environment',
      'system:processes',
      'system:list-tasks',
      'system:terminate-task',
      'system:open',
    ])
    expect(service?.getOperationMetadata('system:list-tasks')).toBeUndefined()
    expect(module.manifest.permissions).not.toContain('*')
  })

  test('uses strict schemas before resolving a host context', async () => {
    let service: SystemCapabilityService | undefined
    let resolverCalls = 0
    const module = createSystemKernelModule({
      resolveContext: (_scope, signal) => {
        resolverCalls += 1
        return {
          abortSignal: signal,
          system: { listBackgroundTasks: async () => [] },
        } as unknown as SystemToolContext
      },
    })
    await module.activate(captureService((_tokenId, registered) => {
      service = registered as SystemCapabilityService
    }))

    await expect(service?.invoke(
      'system:list-tasks',
      undefined,
      { unexpected: true },
      new AbortController().signal,
    )).rejects.toThrow('System capability input is invalid')
    expect(resolverCalls).toBe(0)
  })
})
