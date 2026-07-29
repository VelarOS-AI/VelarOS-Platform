import { describe, expect, test } from 'bun:test'

import type {
  CapabilityToken,
  KernelModuleActivateContext,
} from '@velaros-ai/kernel-sdk'

import {
  createSystemToolsKernelModule,
  type SystemToolContext,
  SystemToolsCapability,
  type SystemToolsCapabilityService,
} from '../src'

function createCaptureContext(
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

describe('system tools kernel module', () => {
  test('registers immutable collections and defaults callable tools to unavailable', async () => {
    let service: SystemToolsCapabilityService | undefined
    const module = createSystemToolsKernelModule()

    await module.activate(
      createCaptureContext((tokenId, registered) => {
        expect(tokenId).toBe(SystemToolsCapability.id)
        service = registered as SystemToolsCapabilityService
      }),
    )

    expect(Object.isFrozen(service)).toBe(true)
    expect(Object.isFrozen(service?.tools)).toBe(true)
    expect(Object.keys(service?.tools ?? {})).not.toHaveLength(0)
    expect(service?.getOperationMetadata('list_background_tasks'))
      .toBeUndefined()
    expect(module.manifest.permissions).not.toContain('*')
  })

  test('uses tool contracts for operation permissions and strict input', async () => {
    let service: SystemToolsCapabilityService | undefined
    let resolverCalls = 0
    const module = createSystemToolsKernelModule({
      resolveContext: async (_scope, signal) => {
        resolverCalls += 1
        return {
          abortSignal: signal,
          system: {
            listBackgroundTasks: async () => [
              { id: 'task-1', status: 'running' },
            ],
          },
        } as unknown as SystemToolContext
      },
    })
    await module.activate(
      createCaptureContext((_tokenId, registered) => {
        service = registered as SystemToolsCapabilityService
      }),
    )

    expect(
      service?.getOperationMetadata('list_background_tasks')?.permissions,
    ).toEqual([])
    expect(await service?.invoke(
      'list_background_tasks',
      undefined,
      { onlyRunning: true },
      new AbortController().signal,
    )).toMatchObject({ count: 1 })
    const declaredPermissions = new Set(module.manifest.permissions)
    const callableTools = {
      ...service?.extensionTools,
      ...service?.tools,
    }
    expect(
      Object.values(callableTools).flatMap((tool) =>
        (service?.getOperationMetadata(tool.name ?? '')?.permissions ?? [])
          .filter((permission) => !declaredPermissions.has(permission))),
    ).toEqual([])
    expect(resolverCalls).toBe(1)
    await expect(service?.invoke(
      'list_background_tasks',
      undefined,
      { unexpected: true },
      new AbortController().signal,
    )).rejects.toThrow('System capability input is invalid')
    expect(resolverCalls).toBe(1)
  })
})
