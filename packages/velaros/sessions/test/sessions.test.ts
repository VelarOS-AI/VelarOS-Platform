import { describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { SessionsErrorCodes } from '../contract/constants'
import { untilAborted } from '../utils/abort'
import { askRequest, tellRequest } from '../utils/input'

describe('现有会话输入', () => {
  test('目标去除首尾空白，正文保留完整字节', () => {
    expect(askRequest({ to: ' peer ', task: '\n  第一步\n  第二步\n' })).toStrictEqual({
      to: 'peer',
      task: '\n  第一步\n  第二步\n',
    })
    expect(tellRequest({ to: ' peer ', message: ' 注意 ' })).toStrictEqual({
      to: 'peer',
      message: ' 注意 ',
    })
  })

  test('已退役的工作区字段直接失败，不读取或创建目标', () => {
    for (const field of ['workspace', 'root', 'site']) {
      expect(() => askRequest({ to: 'peer', task: '核验', [field]: 'unused' })).toThrow(
        '只收 to、task'
      )
    }
    expect(() => askRequest({ task: '核验' })).toThrow('to 要是 list')
    expect(() => askRequest({})).toThrow('task 是空的')
    expect(() => tellRequest({})).toThrow('message 是空的')
    expect(() => askRequest({ to: 42, task: '核验' })).toThrow('to 要是字符串')
    expect(SessionsErrorCodes.targetMissing).toBe('SESSIONS_TARGET_MISSING')
  })
})

describe('取消等待', () => {
  test('取消后不再等待宿主，迟到拒绝仍被观察', async () => {
    expect(await untilAborted(Promise.resolve('ok'), new AbortController().signal)).toBe('ok')
    const controller = new AbortController()
    let fail = (_: unknown): void => {}
    const work = new Promise<string>((_, reject) => {
      fail = reject
    })
    const pending = untilAborted(work, controller.signal)
    controller.abort(new AppError('ABORTED', '停止等待'))
    expect(await pending.catch((error: unknown) => AppError.from(error).message)).toBe('停止等待')
    fail(new AppError('NETWORK', '宿主迟到的失败'))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
