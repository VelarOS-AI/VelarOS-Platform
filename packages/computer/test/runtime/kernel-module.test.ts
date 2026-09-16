import { describe, expect, test } from 'bun:test'

import type {
  KernelModuleActivateContext,
} from '@velaros-ai/kernel'
import type {
  CapabilityToken,
} from '@velaros-ai/kernel/contracts'

import { ComputerOperationMetadata } from '../../src/contracts'
import {
  ComputerCapability,
  type ComputerCapabilityService,
  type ComputerClickOptions,
  ComputerKernelModuleVersion,
  type ComputerMoveOptions,
  type ComputerRuntimePort,
  createComputerKernelModule,
} from '../../src/index'
import { computerTools } from '../../src/index'

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
  const moves: Array<{ x: number; y: number; options?: ComputerMoveOptions }> = []
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
    mouseMove: async (x: number, y: number, options?: ComputerMoveOptions) => {
      moves.push({ x, y, options })
      return { x, y }
    },
    click: async (x: number, y: number, options?: ComputerClickOptions) => {
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

    expect(Object.keys(ComputerOperationMetadata).sort()).toEqual(Object.keys(computerTools).sort())
    for (const toolName of Object.keys(ComputerOperationMetadata) as Array<
      keyof typeof ComputerOperationMetadata
    >) {
      // 操作名就是工具名，合同表里的元数据是同一份事实的只读副本。
      const metadata = service?.getOperationMetadata(toolName)
      expect(metadata?.permissions).toEqual([...computerTools[toolName].permissions])
      expect(metadata).toEqual({ ...ComputerOperationMetadata[toolName] })
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

  test('工具形状的 move 经内核调用成功，主屏坐标连同截图绑定一起下发', async () => {
    const harness = createRuntime()
    const { service } = await activate({ runtime: harness.runtime })

    // 工具 schema 会给 coordinateSpace 填上缺省值；按工具名路由的宿主原样把它交给内核操作。
    const toolPayload = computerTools['computer:move'].schema.parse({
      x: 120,
      y: 40,
      snapshotId: 'screen_test_snapshot_01',
    })
    expect(toolPayload).toEqual({
      x: 120,
      y: 40,
      coordinateSpace: 'primary-display',
      snapshotId: 'screen_test_snapshot_01',
    })
    await service?.invoke(
      'computer:move',
      undefined,
      toolPayload,
      new AbortController().signal,
    )
    // 换算归 helper：本包把截图内坐标与绑定原样交下去，自己不再按屏幕几何算一遍。
    expect(harness.moves).toEqual([
      {
        x: 120,
        y: 40,
        options: { coordinateSpace: 'primary-display', snapshotId: 'screen_test_snapshot_01' },
      },
    ])

    await service?.invoke(
      'computer:move',
      undefined,
      { x: -30, y: 40, coordinateSpace: 'global' },
      new AbortController().signal,
    )
    expect(harness.moves.at(-1)).toEqual({
      x: -30,
      y: 40,
      options: { coordinateSpace: 'global' },
    })

    // 主屏坐标缺 snapshotId 在 wire 面就被拒，不会走到运行时。
    await expect(
      service?.invoke(
        'computer:move',
        undefined,
        { x: 120, y: 40 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(
      service?.invoke(
        'computer:move',
        undefined,
        { x: -1, y: 40, snapshotId: 'screen_test_snapshot_01' },
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
          screenshot: async () => harness.runtime.screenshot(),
          mouseMove: async (x: number, y: number, options?: ComputerMoveOptions) =>
            harness.runtime.mouseMove(x, y, options),
          click: async (x: number, y: number, options?: ComputerClickOptions) =>
            harness.runtime.click(x, y, options),
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
