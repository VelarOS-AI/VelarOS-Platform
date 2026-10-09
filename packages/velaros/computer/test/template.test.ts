/**
 * 代码模版是给模型看的日常用法示例：只过类型检查不够，结果取错一个键、写法跑不通，模型照着写就跟着错。
 * 仓库里没有真桌面，所以在假桌面上把每个函数经真的代码面会话调一遍（和模型交程序是同一条路），
 * 看它交回的是不是它说的那个样子、交给运行时的是不是它说的那几个动作。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { computerDesk, Display, runModelProgram, SnapshotId } from '../spec/support'

/** 模版原文：程序就是它，后面接上这次要调的那几个函数。 */
const Template = readFileSync(resolve(import.meta.dir, '../template.js'), 'utf8')

describe('代码模版', () => {
  test('每个函数照写法跑通：截图交给模型看、按截图坐标动手、快捷键、截图过期时重截', async () => {
    const desk = computerDesk()
    const { result, attachments } = await runModelProgram(
      desk,
      `${Template}
export const looked = await look()
export const filled = await fillField(looked.snapshotId, 640, 400, 'hello')
export const opened = await openThenMenu(looked.snapshotId, 200, 300)
export const hovered = await hover(looked.snapshotId, 10, 20)
export const copied = await selectAllAndCopy('cmd')
export const retaken = await clickOrRetake('screen_old_snapshot_00', 640, 400)
export const status = await whyUnavailable()
`
    )
    expect(result.failed).toBeUndefined()
    const values = result.value as Record<string, any>
    expect(values.looked).toEqual({
      snapshotId: SnapshotId,
      size: `${Display.width}×${Display.height}`,
    })
    expect(values.filled).toEqual({ pressed: ['enter'] })
    expect(values.opened.opened).toMatchObject({ x: 200, y: 300, button: 'left', count: 2 })
    expect(values.opened.menu).toMatchObject({ x: 200, y: 300, button: 'right', count: 1 })
    expect(values.hovered).toMatchObject({
      x: 10,
      y: 20,
      globalX: Display.originX + 10,
      globalY: Display.originY + 20,
      snapshotId: SnapshotId,
    })
    expect(values.copied).toEqual({ pressed: ['cmd', 'c'] })
    expect(values.retaken.failed).toContain('过期')
    expect(values.retaken.snapshotId).toBe(SnapshotId)
    expect(values.status).toBe('可以用')
    // 交给运行时的就是模版说的那几个动作，按顺序。
    expect(
      desk.clicks.map(({ x, y, options }) => [x, y, options?.button ?? 'left', options?.count ?? 1])
    ).toEqual([
      [640, 400, 'left', 1],
      [200, 300, 'left', 2],
      [200, 300, 'right', 1],
    ])
    expect(desk.moves).toEqual([
      { x: 10, y: 20, options: { coordinateSpace: 'primary-display', snapshotId: SnapshotId } },
    ])
    expect(desk.typed).toEqual(['hello'])
    expect(desk.pressed).toEqual(['enter', 'cmd+a', 'cmd+c'])
    // look、重截、whyUnavailable 各截一次：三张图跟在结果后面交给模型。
    expect(attachments).toHaveLength(3)
  }, 60_000)

  test('桌面控制不可用时 whyUnavailable 交回的是给用户看的原因', async () => {
    const desk = computerDesk({
      available: { available: false, reason: 'helper-missing', detail: null },
    })
    const { result } = await runModelProgram(
      desk,
      `${Template}
export default await whyUnavailable()
`
    )
    expect(result.failed).toBeUndefined()
    expect(result.value).toContain('宿主应用')
    expect(result.value).toContain('不要')
  }, 60_000)
})
