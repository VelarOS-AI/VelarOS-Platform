/**
 * 桌面控制的不变量验收：`spec/invariants.md` 里每一条「测试」档的检验器。
 * 用例名以 INV-<编号> 开头，`check:module-ownership` 按这个前缀核对登记表与实现对得上。
 */
import { describe, expect, test } from 'bun:test'

import type {
  KernelModuleActivateContext,
} from '@velaros-ai/kernel'
import type {
  CapabilityToken,
} from '@velaros-ai/kernel/contracts'

import {
  ComputerCapability,
  type ComputerCapabilityService,
  type ComputerClickOptions,
  ComputerErrorCodes,
  type ComputerMoveOptions,
  ComputerOperationMetadata,
  type ComputerRuntimePort,
  ComputerToolNames,
  computerTools,
  createComputerHelperLocator,
  createComputerKernelModule,
  createComputerRuntime,
} from '../src/index'

const SnapshotId = 'screen_spec_snapshot_01'

/** 假运行时：把每次移动与点击原样记下来，屏幕原点为负是多显示器的常态。 */
function createRuntimeStub() {
  const moves: Array<{ x: number; y: number; options?: ComputerMoveOptions }> = []
  const clicks: Array<{ x: number; y: number; options?: ComputerClickOptions }> = []
  const runtime = {
    isReady: () => true,
    ensureAvailable: async () => ({ available: true, reason: 'available' as const, detail: null }),
    screenSize: async () => ({
      displayId: 7,
      width: 1_500,
      height: 1_000,
      scaleFactor: 2,
      originX: -1_800,
      originY: 120,
    }),
    screenshot: async () => ({
      base64: 'image',
      format: 'jpeg' as const,
      snapshotId: SnapshotId,
      width: 100,
      height: 80,
      displayWidth: 100,
      displayHeight: 80,
      displayId: 7,
      originX: -1_800,
      originY: 120,
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
    typeText: async (text: string) => ({ typed: text.length }),
    key: async (keys: string) => ({ pressed: [keys] }),
    dispose: () => {},
  } satisfies ComputerRuntimePort
  return { clicks, moves, runtime }
}

/** 把内核模块激活起来，拿到它登记的能力服务。 */
async function activate(runtime: ComputerRuntimePort) {
  const module = createComputerKernelModule({ runtime })
  let service: ComputerCapabilityService | undefined
  const context = {
    registerService<TService extends object>(
      token: CapabilityToken<TService>,
      registered: TService,
    ) {
      expect(token.id).toBe(ComputerCapability.id)
      service = registered as unknown as ComputerCapabilityService
      return { dispose() {} }
    },
  } as unknown as KernelModuleActivateContext
  const lifecycle = await module.activate(context)
  return { lifecycle, module, service }
}

describe('桌面控制不变量验收', () => {
  test('INV-1 ensureAvailable 永不抛，环境问题一律是结构化结果', async () => {
    const runtime = createComputerRuntime({ resolveHelper: () => null })

    try {
      const availability = await runtime.ensureAvailable()

      expect(availability.available).toBe(false)
      expect(availability.reason).toBe('helper-missing')
      expect(availability.detail).toContain('桌面控制')
    } finally {
      runtime.dispose()
    }
  })

  test('INV-2 主屏坐标的移动与点击必须带同一次截图的 snapshotId', () => {
    for (const toolName of ['computer:move', 'computer:click'] as const) {
      expect(() => computerTools[toolName].schema.parse({ x: 100, y: 50 })).toThrow()
      const parsed = computerTools[toolName].schema.parse({
        x: 100,
        y: 50,
        snapshotId: SnapshotId,
      })
      expect(parsed).toMatchObject({ coordinateSpace: 'primary-display', snapshotId: SnapshotId })
    }
  })

  test('INV-3 显式全局坐标不许带 snapshotId', () => {
    for (const toolName of ['computer:move', 'computer:click'] as const) {
      expect(() =>
        computerTools[toolName].schema.parse({
          x: -100,
          y: 50,
          coordinateSpace: 'global',
          snapshotId: SnapshotId,
        })
      ).toThrow()
      expect(
        computerTools[toolName].schema.parse({ x: -100, y: 50, coordinateSpace: 'global' })
      ).toMatchObject({ coordinateSpace: 'global' })
    }
  })

  test('INV-4 坐标换算只在 helper 里发生一次，本包原样下发', async () => {
    const harness = createRuntimeStub()
    const { service } = await activate(harness.runtime)
    const signal = new AbortController().signal

    await service?.invoke(
      'computer:move',
      undefined,
      computerTools['computer:move'].schema.parse({ x: 12, y: 34, snapshotId: SnapshotId }),
      signal,
    )
    await service?.invoke(
      'computer:click',
      undefined,
      computerTools['computer:click'].schema.parse({ x: 56, y: 78, snapshotId: SnapshotId }),
      signal,
    )

    // 原点是 (-1800, 120)：本包若自己换算，落到运行时的就不是模型给的那组数了。
    expect(harness.moves).toEqual([
      { x: 12, y: 34, options: { coordinateSpace: 'primary-display', snapshotId: SnapshotId } },
    ])
    expect(harness.clicks).toEqual([
      {
        x: 56,
        y: 78,
        options: {
          button: undefined,
          count: undefined,
          coordinateSpace: 'primary-display',
          snapshotId: SnapshotId,
        },
      },
    ])
  })

  test('INV-5 内核操作名就是工具名，入参用工具自己的 schema 严格解析', async () => {
    const harness = createRuntimeStub()
    const { service } = await activate(harness.runtime)

    expect(Object.keys(ComputerOperationMetadata).sort()).toEqual(Object.keys(computerTools).sort())
    for (const toolName of Object.keys(computerTools) as Array<keyof typeof computerTools>) {
      expect(service?.getOperationMetadata(toolName)?.permissions).toEqual([
        ...computerTools[toolName].permissions,
      ])
    }

    await expect(
      service?.invoke(
        'computer:key',
        undefined,
        { keys: 'enter', unexpected: true },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  test('INV-6 模型面只发布桌面控制真正需要的动作', () => {
    expect(Object.keys(computerTools).sort()).toEqual(
      [...Object.values(ComputerToolNames)].sort(),
    )
    expect(Object.keys(computerTools)).not.toContain('computer:screen_size')
  })

  test('INV-7 释放之后的运行时不再有任何状态迁移', async () => {
    const runtime = createComputerRuntime({ resolveHelper: () => null })
    runtime.dispose()

    expect(runtime.isReady()).toBe(false)
    await expect(runtime.screenshot()).rejects.toMatchObject({
      code: ComputerErrorCodes.sidecarDisposed,
    })
    await expect(runtime.key('enter')).rejects.toMatchObject({
      code: ComputerErrorCodes.sidecarDisposed,
    })
  })

  test('INV-8 helper 定位只认自包含 venv，找不到就判未安装', () => {
    // 资源根指向一个不存在的目录：没有平台包、没有 venv，一定判未安装。
    const locator = createComputerHelperLocator({ resourceRoots: ['/velaros-spec/nowhere'] })

    expect(locator.resolve()).toBeNull()
    expect(locator.resolveIgnoringDisabled()).toBeNull()

    // 停用开关只影响「现在能不能用」，不影响「物理上装了没有」这一问。
    const disabled = createComputerHelperLocator({
      resourceRoots: ['/velaros-spec/nowhere'],
      resources: { extraResourceRoots: () => [], isDisabled: () => true },
    })
    expect(disabled.resolve()).toBeNull()
    expect(locator.bundledSourceRoot().length).toBeGreaterThan(0)
  })
})
