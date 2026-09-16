import { describe, expect, test } from 'bun:test'

import type {
  CapabilityToken,
  KernelModuleActivateContext,
} from '@velaros-ai/kernel/contracts/abi'

import { ComputerOperationMetadata, ComputerToolOperations } from '../../src/contracts'
import {
  ComputerCapability,
  type ComputerClickOptions,
  ComputerKernelModuleVersion,
  type ComputerRuntimeCapabilityService,
  type ComputerRuntimePort,
  createComputerKernelModule,
} from '../../src/runtime'
import { computerTools } from '../../src/tools'

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
    const clicks: Array<{ x: number; y: number; options?: ComputerClickOptions }> = []
    const moves: Array<{ x: number; y: number }> = []
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
        snapshotId: 'screen_test_snapshot_01',
        width: 100,
        height: 80,
        displayWidth: 100,
        displayHeight: 80,
        displayId: 1,
        originX: 0,
        originY: 0,
        scaleFactor: 1,
      }),
      mouseMove: async (x: number, y: number) => {
        moves.push({ x, y })
        return { x, y }
      },
      leftClick: async (x: number, y: number, options?: ComputerClickOptions) => {
        clicks.push({ x, y, options })
        return { x, y, button: options?.button ?? 'left', count: options?.count ?? 1 }
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
    for (const [name, metadata] of Object.entries(ComputerOperationMetadata)) {
      expect(service?.getOperationMetadata(name)).toEqual(metadata)
      expect(Object.isFrozen(metadata.permissions)).toBe(true)
    }
    expect(Object.keys(ComputerToolOperations).sort()).toEqual(Object.keys(computerTools).sort())
    for (const operation of Object.values(ComputerToolOperations)) {
      expect(ComputerOperationMetadata[operation].permissions).toContain('process:exec')
    }
    expect(await service?.invoke(
      'screenshot',
      undefined,
      {},
      new AbortController().signal,
    )).toMatchObject({ width: 100, height: 80 })
    await service?.invoke(
      'mouse_move',
      undefined,
      { x: -1, y: 2 },
      new AbortController().signal,
    )
    expect(moves).toEqual([{ x: -1, y: 2 }])
    expect(() =>
      service?.invoke(
        'mouse_move',
        undefined,
        { x: Number.POSITIVE_INFINITY, y: 2 },
        new AbortController().signal,
      )).toThrow('Computer capability input is invalid')
    expect(() =>
      service?.invoke(
        'left_click',
        undefined,
        { x: 10, y: 20, coordinateSpace: 'primary-display' },
        new AbortController().signal,
      )).toThrow('Computer capability input is invalid')
    expect(() =>
      service?.invoke(
        'left_click',
        undefined,
        {
          x: -10,
          y: 20,
          coordinateSpace: 'primary-display',
          snapshotId: 'screen_test_snapshot_01',
        },
        new AbortController().signal,
      )).toThrow('Computer capability input is invalid')
    expect(() =>
      service?.invoke(
        'left_click',
        undefined,
        {
          x: 10,
          y: 20,
          coordinateSpace: 'global',
          snapshotId: 'screen_test_snapshot_01',
        },
        new AbortController().signal,
      )).toThrow('Computer capability input is invalid')
    await service?.invoke(
      'left_click',
      undefined,
      {
        x: 10,
        y: 20,
        coordinateSpace: 'primary-display',
        snapshotId: 'screen_test_snapshot_01',
      },
      new AbortController().signal,
    )
    await service?.invoke(
      'left_click',
      undefined,
      { x: -30, y: 40 },
      new AbortController().signal,
    )
    expect(clicks).toEqual([
      {
        x: 10,
        y: 20,
        options: {
          button: undefined,
          count: undefined,
          coordinateSpace: 'primary-display',
          snapshotId: 'screen_test_snapshot_01',
        },
      },
      {
        x: -30,
        y: 40,
        options: {
          button: undefined,
          count: undefined,
          coordinateSpace: 'global',
        },
      },
    ])
    expect(module.manifest.permissions).toEqual([
      'process:exec',
      'screen:capture',
      'input:control',
    ])
    expect(module.manifest.version).toBe(ComputerKernelModuleVersion)
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

  test('accepts the move tool payload and converts primary-display coordinates', async () => {
    const moves: Array<{ x: number; y: number }> = []
    let screenSizeCalls = 0
    let service: ComputerRuntimeCapabilityService | undefined
    const runtime = {
      isReady: () => true,
      ensureAvailable: async () => ({
        available: true,
        reason: 'available' as const,
        detail: null,
      }),
      // 主屏原点为负是多显示器的常态：工具的 x、y 是截图局部坐标，运行时收的是全局坐标。
      screenSize: async () => {
        screenSizeCalls += 1
        return {
          displayId: 7,
          width: 1_500,
          height: 1_000,
          scaleFactor: 2,
          originX: -1_800,
          originY: 120,
        }
      },
      screenshot: async () => {
        throw new Error('not called')
      },
      mouseMove: async (x: number, y: number) => {
        moves.push({ x, y })
        return { x, y }
      },
      leftClick: async (x: number, y: number) => ({ x, y, button: 'left', count: 1 }),
      typeText: async () => {
        throw new Error('not called')
      },
      key: async () => {
        throw new Error('not called')
      },
      dispose: () => undefined,
    } satisfies ComputerRuntimePort
    const module = createComputerKernelModule({ runtime })
    await module.activate(
      createCaptureContext((_tokenId, registered) => {
        service = registered as ComputerRuntimeCapabilityService
      }),
    )

    // 工具 schema 会给 coordinateSpace 填上缺省值；按工具名路由的宿主原样把它交给内核操作。
    const toolPayload = computerTools['computer:move'].schema.parse({ x: 120, y: 40 })
    expect(toolPayload).toEqual({ x: 120, y: 40, coordinateSpace: 'primary-display' })
    await service?.invoke(
      ComputerToolOperations['computer:move'],
      undefined,
      toolPayload,
      new AbortController().signal,
    )
    expect(moves).toEqual([{ x: -1_680, y: 160 }])
    expect(screenSizeCalls).toBe(1)

    // 省略 coordinateSpace 仍是全局坐标，直接持有运行时的既有调用方不受影响。
    await service?.invoke('mouse_move', undefined, { x: -30, y: 40 }, new AbortController().signal)
    expect(moves.at(-1)).toEqual({ x: -30, y: 40 })
    expect(screenSizeCalls).toBe(1)

    await expect(
      service?.invoke(
        'mouse_move',
        undefined,
        { x: 1_500, y: 40, coordinateSpace: 'primary-display' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(() =>
      service?.invoke(
        'mouse_move',
        undefined,
        { x: -1, y: 40, coordinateSpace: 'primary-display' },
        new AbortController().signal,
      )).toThrow('Computer capability input is invalid')
  })
})
