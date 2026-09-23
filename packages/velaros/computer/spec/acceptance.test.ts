/**
 * 桌面控制的不变量验收：`spec/invariants.md` 里每一条「测试」档的检验器。
 * 用例名以 INV-<编号> 开头，`check:module-ownership` 按这个前缀核对登记表与实现对得上。
 * 操作一律经代码面的能力端口调（和模型的程序是同一条路），断言程序看得到的 code 与 message。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  ComputerErrorCodes,
  ComputerInputLimits,
  createComputerHelperLocator,
  createComputerRuntime,
  VelarComputerModule,
} from '../index'

import {
  checkModelProgram,
  ComputerDeclarations,
  computerDesk,
  Display,
  failureOf,
  runModelProgram,
  SnapshotId,
} from './support'

describe('运行时', () => {
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
    // 随单元发布的 helper 资产就在 velaros 包里的 computer/runtime 下。
    expect(locator.bundledSourceRoot()).toBe(resolve(import.meta.dir, '../runtime'))
  })
})

describe('坐标', () => {
  test('INV-2 按截图坐标的移动与点击必须带同一次截图的 snapshotId：缺了在做事之前就拒', async () => {
    const desk = computerDesk()
    for (const operation of ['move', 'click']) {
      const failure = await failureOf(desk.call(operation, { x: 100, y: 50 }))
      expect(failure.code, operation).toBe('VALIDATION')
      expect(failure.message, operation).toContain('snapshotId')
    }
    // 一步都没做：没去问可用性（不拉起 helper），也没动指针。
    expect(desk.availabilityChecks()).toBe(0)
    expect(desk.moves).toEqual([])
    expect(desk.clicks).toEqual([])
  })

  test('INV-3 显式全局坐标不许带 snapshotId；不带就照全局坐标下发', async () => {
    const desk = computerDesk()
    for (const operation of ['move', 'click']) {
      const failure = await failureOf(
        desk.call(operation, { x: -100, y: 50, coordinateSpace: 'global', snapshotId: SnapshotId })
      )
      expect(failure.code, operation).toBe('VALIDATION')
    }
    expect(await desk.call('move', { x: -100, y: 50, coordinateSpace: 'global' })).toMatchObject({
      x: -100,
      y: 50,
      coordinateSpace: 'global',
      globalX: -100,
      globalY: 50,
    })
    expect(desk.moves).toEqual([{ x: -100, y: 50, options: { coordinateSpace: 'global' } }])
  })

  test('INV-4 坐标换算只在 helper 里发生一次：截图内坐标与绑定原样下发，回执投影回模型给的那套', async () => {
    const desk = computerDesk()
    const moved = await desk.call('move', { x: 12, y: 34, snapshotId: SnapshotId })
    const clicked = await desk.call('click', { x: 56, y: 78, snapshotId: SnapshotId, count: 2 })
    // 原点是 (-1920, 120)：本单元若自己换算，落到运行时的就不是模型给的那组数了。
    expect(desk.moves).toEqual([
      { x: 12, y: 34, options: { coordinateSpace: 'primary-display', snapshotId: SnapshotId } },
    ])
    expect(desk.clicks).toEqual([
      {
        x: 56,
        y: 78,
        options: {
          button: undefined,
          count: 2,
          coordinateSpace: 'primary-display',
          snapshotId: SnapshotId,
        },
      },
    ])
    expect(moved).toEqual({
      x: 12,
      y: 34,
      coordinateSpace: 'primary-display',
      globalX: Display.originX + 12,
      globalY: Display.originY + 34,
      displayId: Display.displayId,
      snapshotId: SnapshotId,
    })
    expect(clicked).toMatchObject({
      x: 56,
      y: 78,
      button: 'left',
      count: 2,
      globalX: Display.originX + 56,
      globalY: Display.originY + 78,
    })
    // helper 认为截图过期就拒：失败照实交给程序，指针不动。
    const stale = computerDesk({ acceptedSnapshotId: 'screen_newer_snapshot_02' })
    expect(
      (await failureOf(stale.call('click', { x: 56, y: 78, snapshotId: SnapshotId }))).message
    ).toContain('过期')
    expect(stale.clicks).toEqual([])
  })
})

describe('模型面', () => {
  test('INV-6 模型面只发布桌面控制真正需要的五个动作', () => {
    expect([...VelarComputerModule.methods].sort()).toEqual([
      'click',
      'key',
      'move',
      'screenshot',
      'typeText',
    ])
    expect(ComputerDeclarations).not.toContain('screenSize')
  })

  test('INV-11 声明从源码生成、只放出五个操作；随包发布的与生成物同一份；模型写的程序照声明调到真实操作', async () => {
    expect(VelarComputerModule.specifier).toBe('velaros:computer')
    expect(VelarComputerModule.declarations).toBe(ComputerDeclarations)
    // 放出的方法就是空间挂上的那些操作。
    expect([...VelarComputerModule.methods].sort()).toEqual(
      [...(computerDesk().capabilities.listOperations().computer ?? [])].sort()
    )
    // 宿主的上下文与空间端口不进模型面。
    expect(ComputerDeclarations).not.toContain('ComputerOperationContext')
    expect(ComputerDeclarations).not.toContain('ComputerSpacePort')
    const desk = computerDesk()
    const { result } = await runModelProgram(
      desk,
      `import { click, screenshot, typeText } from 'velaros:computer'
const shot = await screenshot()
await click({ x: 10, y: 20, snapshotId: shot.snapshotId })
export default await typeText({ text: 'hi' })`
    )
    expect(result.failed).toBeUndefined()
    expect(result.value).toEqual({ typed: 2 })
    expect(desk.clicks).toEqual([
      {
        x: 10,
        y: 20,
        options: {
          button: undefined,
          count: undefined,
          coordinateSpace: 'primary-display',
          snapshotId: SnapshotId,
        },
      },
    ])
    expect(desk.typed).toEqual(['hi'])
  }, 60_000)

  test('INV-12 截图经交图通道交给模型，返回值里只有几何与 snapshotId；没有交图通道时整个不可用、不拉起 helper', async () => {
    const desk = computerDesk()
    const shot = await desk.call('screenshot')
    expect(shot).toEqual({
      snapshotId: SnapshotId,
      width: Display.width,
      height: Display.height,
      displayWidth: Display.width,
      displayHeight: Display.height,
      displayId: Display.displayId,
      originX: Display.originX,
      originY: Display.originY,
      scaleFactor: Display.scaleFactor,
    })
    expect(JSON.stringify(shot)).not.toContain(Buffer.from('desktop-pixels').toString('base64'))
    expect(desk.images).toEqual([
      expect.objectContaining({
        type: 'image-data',
        mediaType: 'image/jpeg',
        data: Buffer.from('desktop-pixels').toString('base64'),
      }),
    ])
    expect(JSON.stringify(desk.images[0])).toContain(SnapshotId)
    const blind = computerDesk({ attach: false })
    const failure = await failureOf(blind.call('screenshot'))
    expect(failure.code).toBe('PLATFORM')
    expect(blind.availabilityChecks()).toBe(0)
  })

  test('INV-13 不可用时每个动作都在做事之前拒绝：按原因引导用户，明说不要自己装依赖', async () => {
    const permission = computerDesk({
      available: { available: false, reason: 'permission-missing', detail: null },
    })
    const denied = await failureOf(permission.call('screenshot'))
    expect(denied.code).toBe('PERMISSION')
    expect(denied.message).toContain('辅助功能')
    const missing = computerDesk({
      available: { available: false, reason: 'helper-missing', detail: null },
    })
    for (const [operation, input] of [
      ['click', { x: 1, y: 2, snapshotId: SnapshotId }],
      ['typeText', { text: 'x' }],
      ['key', { keys: 'enter' }],
    ] as const) {
      const failure = await failureOf(missing.call(operation, input))
      expect(failure.code, operation).toBe('PERMISSION')
      expect(failure.message, operation).toContain('插件市场')
      expect(failure.message, operation).toContain('不要')
    }
    expect(missing.clicks).toEqual([])
    expect(missing.typed).toEqual([])
    expect(missing.pressed).toEqual([])
  })

  test('INV-14 声明里写给模型的上限就是常量表里的数；超出上限的入参在做事之前拒绝', async () => {
    for (const phrase of [
      `绝对值不超过 ${ComputerInputLimits.coordinateBound}`,
      `最多 ${ComputerInputLimits.clickCount}`,
      `一次最多 ${ComputerInputLimits.typeTextChars} 个字符`,
      `最多 ${ComputerInputLimits.keyChordChars} 个字符`,
    ])
      expect(ComputerDeclarations, phrase).toContain(phrase)
    const desk = computerDesk()
    for (const [operation, input] of [
      ['move', { x: ComputerInputLimits.coordinateBound + 1, y: 0, coordinateSpace: 'global' }],
      ['click', { x: 1, y: 2, snapshotId: SnapshotId, count: ComputerInputLimits.clickCount + 1 }],
      ['typeText', { text: 'x'.repeat(ComputerInputLimits.typeTextChars + 1) }],
      ['key', { keys: 'a'.repeat(ComputerInputLimits.keyChordChars + 1) }],
    ] as const) {
      expect((await failureOf(desk.call(operation, input))).code, operation).toBe('VALIDATION')
    }
    expect(desk.availabilityChecks()).toBe(0)
  })

  test('INV-15 代码模版整份照生成的声明过类型检查，import 只写一次；它不嵌进声明，随模型面发布的就是这份文件', () => {
    const template = readFileSync(resolve(import.meta.dir, '../template.js'), 'utf8')
    expect(checkModelProgram(template)).toEqual([])
    expect(template.match(/^import /gmu)).toHaveLength(1)
    expect(VelarComputerModule.template).toBe(template.trim())
    expect(ComputerDeclarations).not.toContain('的代码模版')
  })
})
