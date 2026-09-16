import { describe, expect, test } from 'bun:test'

import type {
  CapabilityToken,
  KernelModuleActivateContext,
} from '@velaros-ai/kernel/contracts/abi'

import {
  ComputerOperationMetadata,
  ComputerToolOperations,
} from '../../src/exports/contracts'
import {
  ComputerCapability,
  type ComputerCapabilityService,
  type ComputerClickOptions,
  ComputerKernelModuleVersion,
  type ComputerRuntimePort,
  createComputerKernelModule,
} from '../../src/exports/runtime'
import { computerTools } from '../../src/exports/tools'

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

/** 假运行时：记下每次移动与点击，屏幕原点为负是多显示器的常态。 */
function createRuntime() {
  const clicks: Array<{ x: number; y: number; options?: ComputerClickOptions }> = []
  const moves: Array<{ x: number; y: number }> = []
  let screenSizeCalls = 0
  let disposed = false
  const runtime = {
    isReady: () => true,
    ensureAvailable: async () => ({
      available: true,
      reason: 'available' as const,
      detail: null,
    }),
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
  return { clicks, moves, runtime, readDisposed: () => disposed, readScreenSizeCalls: () => screenSizeCalls }
}

async function activate(options: Parameters<typeof createComputerKernelModule>[0]) {
  const module = createComputerKernelModule(options)
  let service: ComputerCapabilityService | undefined
  const lifecycle = await module.activate(
    createCaptureContext((tokenId, registered) => {
      expect(tokenId).toBe(ComputerCapability.id)
      service = registered as ComputerCapabilityService
    }),
  )
  return { lifecycle, module, service }
}

describe('computer kernel module', () => {
  test('按工具名登记操作，权限与理由来自工具定义', async () => {
    const harness = createRuntime()
    const { module, service } = await activate({ runtime: harness.runtime })

    expect(Object.keys(ComputerToolOperations).sort()).toEqual(Object.keys(computerTools).sort())
    for (const [toolName, operation] of Object.entries(ComputerToolOperations)) {
      // D2 之后操作名就是工具名，合同表里的映射是恒等的。
      expect(operation).toBe(toolName)
      const metadata = service?.getOperationMetadata(operation)
      expect(metadata?.permissions).toEqual([...computerTools[toolName].permissions])
      expect(metadata).toEqual({ ...ComputerOperationMetadata[operation] })
    }
    // 拉起 helper 子进程的权限声明在模块清单上，不再逐操作重复。
    expect(module.manifest.permissions).toEqual([
      'process:exec',
      'screen:capture',
      'input:control',
    ])
    expect(module.manifest.version).toBe(ComputerKernelModuleVersion)
    expect(service?.tools['computer:click'].name).toBe('computer:click')
  })

  test('内核入参就是工具 schema：未知字段拒绝，截图绑定不缺', async () => {
    const harness = createRuntime()
    const { service } = await activate({ runtime: harness.runtime })

    await expect(service?.invoke(
      'computer:click',
      undefined,
      { x: 10, y: 20, coordinateSpace: 'primary-display' },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(service?.invoke(
      'computer:click',
      undefined,
      {
        x: 10,
        y: 20,
        coordinateSpace: 'global',
        snapshotId: 'screen_test_snapshot_01',
      },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(service?.invoke(
      'computer:click',
      undefined,
      { x: 10, y: 20, snapshotId: 'screen_test_snapshot_01', unexpected: true },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'VALIDATION' })

    await service?.invoke(
      'computer:click',
      undefined,
      { x: 10, y: 20, snapshotId: 'screen_test_snapshot_01' },
      new AbortController().signal,
    )
    await service?.invoke(
      'computer:click',
      undefined,
      { x: -30, y: 40, coordinateSpace: 'global' },
      new AbortController().signal,
    )
    expect(harness.clicks).toEqual([
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
  })

  test('工具形状的 move 经内核调用成功，并换算主屏坐标', async () => {
    const harness = createRuntime()
    const { service } = await activate({ runtime: harness.runtime })

    // 工具 schema 会给 coordinateSpace 填上缺省值；按工具名路由的宿主原样把它交给内核操作。
    const toolPayload = computerTools['computer:move'].schema.parse({ x: 120, y: 40 })
    expect(toolPayload).toEqual({ x: 120, y: 40, coordinateSpace: 'primary-display' })
    await service?.invoke(
      ComputerToolOperations['computer:move'],
      undefined,
      toolPayload,
      new AbortController().signal,
    )
    expect(harness.moves).toEqual([{ x: -1_680, y: 160 }])

    await service?.invoke(
      'computer:move',
      undefined,
      { x: -30, y: 40, coordinateSpace: 'global' },
      new AbortController().signal,
    )
    expect(harness.moves.at(-1)).toEqual({ x: -30, y: 40 })

    await expect(
      service?.invoke(
        'computer:move',
        undefined,
        { x: 1_500, y: 40 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(
      service?.invoke(
        'computer:move',
        undefined,
        { x: -1, y: 40 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  test('截图经内核返回模型可见图片，注入的运行时默认不被释放', async () => {
    const harness = createRuntime()
    const { lifecycle, service } = await activate({ runtime: harness.runtime })

    expect(await service?.invoke(
      'computer:screenshot',
      undefined,
      {},
      new AbortController().signal,
    )).toMatchObject({
      width: 100,
      height: 80,
      modelImage: { data: 'image', mediaType: 'image/jpeg' },
    })

    await lifecycle?.dispose?.()
    expect(harness.readDisposed()).toBe(false)

    const owned = await activate({ runtime: harness.runtime, disposeInjectedRuntime: true })
    await owned.lifecycle?.dispose?.()
    expect(harness.readDisposed()).toBe(true)
  })

  test('宿主给了上下文解析器就用宿主的端口', async () => {
    const harness = createRuntime()
    const typed: string[] = []
    const { service } = await activate({
      runtime: harness.runtime,
      resolveContext: (_scope, signal) => ({
        abortSignal: signal,
        computer: {
          ensureAvailable: async () => ({ available: true, reason: 'available' as const, detail: null }),
          screenSize: async () => harness.runtime.screenSize(),
          screenshot: async () => harness.runtime.screenshot(),
          mouseMove: async (x: number, y: number) => harness.runtime.mouseMove(x, y),
          click: async (x: number, y: number, options?: ComputerClickOptions) =>
            harness.runtime.leftClick(x, y, options),
          typeText: async (text: string) => {
            typed.push(text)
            return { typed: text.length }
          },
          key: async () => ({ pressed: [] }),
        },
      }),
    })

    expect(await service?.invoke(
      'computer:type',
      undefined,
      { text: 'hello' },
      new AbortController().signal,
    )).toEqual({ typed: 5 })
    expect(typed).toEqual(['hello'])
  })
})
