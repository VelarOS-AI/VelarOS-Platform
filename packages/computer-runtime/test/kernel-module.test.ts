import { describe, expect, test } from 'bun:test'

import type {
  CapabilityToken,
  KernelModuleActivateContext,
} from '@velaros-ai/core/kernel/abi'

import {
  ComputerCapability,
  type ComputerRuntimeCapabilityService,
  type ComputerRuntimePort,
  createComputerKernelModule,
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

describe('computer kernel module', () => {
  test('maps callable operations to precise permissions and strict input', async () => {
    let disposed = false
    let service: ComputerRuntimeCapabilityService | undefined
    const runtime = {
      isReady: () => false,
      ensureAvailable: async () => ({
        available: false,
        reason: 'helper-missing',
        detail: 'missing',
      }),
      screenSize: async () => {
        throw new Error('not called')
      },
      screenshot: async () => ({
        base64: 'image',
        format: 'jpeg' as const,
        width: 100,
        height: 80,
        displayWidth: 100,
        displayHeight: 80,
        displayId: 1,
        originX: 0,
        originY: 0,
        scaleFactor: 1,
      }),
      mouseMove: async (x: number, y: number) => ({ x, y }),
      leftClick: async () => {
        throw new Error('not called')
      },
      typeText: async () => {
        throw new Error('not called')
      },
      key: async () => {
        throw new Error('not called')
      },
      dispose: () => {
        disposed = true
      },
    } satisfies ComputerRuntimePort
    const module = createComputerKernelModule({ runtime })
    const lifecycle = await module.activate(
      createCaptureContext((tokenId, registered) => {
        expect(tokenId).toBe(ComputerCapability.id)
        service = registered as ComputerRuntimeCapabilityService
      }),
    )

    expect(service?.getOperationMetadata('screenshot')?.permissions).toEqual([
      'process:exec',
      'screen:capture',
    ])
    expect(service?.getOperationMetadata('mouse_move')?.permissions).toEqual([
      'process:exec',
      'input:control',
    ])
    expect(await service?.invoke(
      'screenshot',
      undefined,
      {},
      new AbortController().signal,
    )).toMatchObject({ width: 100, height: 80 })
    expect(() =>
      service?.invoke(
        'mouse_move',
        undefined,
        { x: -1, y: 2 },
        new AbortController().signal,
      )).toThrow('Computer capability input is invalid')
    expect(module.manifest.permissions).toEqual([
      'process:exec',
      'screen:capture',
      'input:control',
    ])
    await lifecycle?.dispose?.()
    expect(disposed).toBe(false)

    const ownedModule = createComputerKernelModule({
      runtime,
      disposeInjectedRuntime: true,
    })
    const ownedLifecycle = await ownedModule.activate(
      createCaptureContext(() => undefined),
    )
    await ownedLifecycle?.dispose?.()
    expect(disposed).toBe(true)
  })
})
