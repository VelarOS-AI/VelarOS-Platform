/** 五个操作的入参核对：类型挡不住的形状、范围与写法，都在做事之前拒绝，一步都不做。 */

import { describe, expect, test } from 'bun:test'

import { computerDesk, failureOf, SnapshotId } from '../spec/support'

describe('入参核对', () => {
  test('坐标要整数：小数、字符串、缺了都拒', async () => {
    const desk = computerDesk()
    for (const input of [{ x: 1.5, y: 2, snapshotId: SnapshotId }, { x: '10', y: 2, snapshotId: SnapshotId }, { y: 2, snapshotId: SnapshotId }]) {
      const failure = await failureOf(desk.call('click', input))
      expect(failure.code, JSON.stringify(input)).toBe('VALIDATION')
      expect(failure.message, JSON.stringify(input)).toContain('整数')
    }
    expect(desk.availabilityChecks()).toBe(0)
  })

  test('按截图的坐标不能为负，全局坐标可以', async () => {
    const desk = computerDesk()
    expect((await failureOf(desk.call('move', { x: -1, y: 2, snapshotId: SnapshotId }))).code).toBe('VALIDATION')
    expect(await desk.call('move', { x: -1, y: 2, coordinateSpace: 'global' })).toMatchObject({ x: -1, y: 2, coordinateSpace: 'global' })
  })

  test('snapshotId 要原样用截图交回的：改过、拼出来的样子直接拒，不交给 helper', async () => {
    const desk = computerDesk()
    for (const snapshotId of ['short', 'has space inside', 'x'.repeat(200), 42]) {
      expect((await failureOf(desk.call('click', { x: 1, y: 2, snapshotId }))).code, String(snapshotId)).toBe('VALIDATION')
    }
    expect(desk.clicks).toEqual([])
  })

  test('坐标空间只认 primary-display 与 global', async () => {
    const desk = computerDesk()
    const failure = await failureOf(desk.call('move', { x: 1, y: 2, coordinateSpace: 'screen' }))
    expect(failure.code).toBe('VALIDATION')
    expect(failure.message).toContain('coordinateSpace')
    expect(await desk.call('move', { x: 1, y: 2, snapshotId: SnapshotId, coordinateSpace: 'primary-display' })).toMatchObject({ coordinateSpace: 'primary-display' })
  })

  test('按键只认 left、right、middle；连击次数要 1 到上限的整数', async () => {
    const desk = computerDesk()
    expect((await failureOf(desk.call('click', { x: 1, y: 2, snapshotId: SnapshotId, button: 'back' }))).code).toBe('VALIDATION')
    expect((await failureOf(desk.call('click', { x: 1, y: 2, snapshotId: SnapshotId, count: 0 }))).code).toBe('VALIDATION')
    expect(await desk.call('click', { x: 1, y: 2, snapshotId: SnapshotId, button: 'right' })).toMatchObject({ button: 'right', count: 1 })
  })

  test('输入的文字不能是空的；按键串不能是空白', async () => {
    const desk = computerDesk()
    expect((await failureOf(desk.call('typeText', { text: '' }))).code).toBe('VALIDATION')
    expect((await failureOf(desk.call('key', { keys: '   ' }))).code).toBe('VALIDATION')
    expect(await desk.call('typeText', { text: '中文 ok' })).toEqual({ typed: 5 })
    expect(await desk.call('key', { keys: 'cmd+shift+t' })).toEqual({ pressed: ['cmd', 'shift', 't'] })
    expect(desk.typed).toEqual(['中文 ok'])
    expect(desk.pressed).toEqual(['cmd+shift+t'])
  })
})
