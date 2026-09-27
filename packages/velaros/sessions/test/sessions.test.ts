/**
 * 会话之间交活、传话的实现细节测试：对外承诺在 spec/acceptance.test.ts，这里补纯函数的边角——
 * 哪些写法算绝对路径（照宿主可能跑的每个平台）、网址的规范写法、入参核对的顺序与说明，以及等宿主时撒手不漏接后来的失败。
 */

import { describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { SessionsErrorCodes } from '../contract/constants'
import { untilAborted } from '../utils/abort'
import { isAbsolutePath, webAddress } from '../utils/addresses'
import { askRequest, tellRequest } from '../utils/input'

/** 跑一段会抛错的核对，交出码与说明。 */
function failureOf(run: () => unknown): { code: string; message: string } {
  try {
    run()
  } catch (error) {
    const failure = AppError.from(error)
    return { code: failure.code, message: failure.message }
  }
  return { code: '', message: '' }
}

describe('绝对路径', () => {
  test('macOS、Linux 的 / 开头，Windows 的盘符加斜杠与网络路径都算', () => {
    for (const path of [
      '/',
      '/home/me/shop',
      '//server/share/shop',
      'C:\\work\\shop',
      'c:/work/shop',
      'Z:\\',
      '\\\\fileserver\\share',
      '\\\\fileserver\\share\\shop',
    ])
      expect({ path, absolute: isAbsolutePath(path) }).toEqual({ path, absolute: true })
  })

  test('相对路径、~、只写盘符、单个反斜杠开头、只有服务器没有共享的都不算', () => {
    for (const path of [
      '',
      'shop',
      './shop',
      '../shop',
      '~/shop',
      '~',
      'C:',
      'C:work',
      '\\work',
      '\\\\fileserver',
      '\\\\fileserver\\',
      'file:///home/me',
    ])
      expect({ path, absolute: isAbsolutePath(path) }).toEqual({ path, absolute: false })
  })
})

describe('网址', () => {
  test('只认 http 与 https，交回规范写法', () => {
    expect(webAddress('https://WWW.Example.com')).toBe('https://www.example.com/')
    expect(webAddress('http://localhost:3000/a b')).toBe('http://localhost:3000/a%20b')
    expect(webAddress('https://example.com/path?q=1#top')).toBe('https://example.com/path?q=1#top')
    for (const value of ['example.com', 'ftp://example.com', 'javascript:alert(1)', 'https://', ''])
      expect({ value, address: webAddress(value) }).toEqual({ value, address: null })
  })
})

describe('入参核对的顺序与说明', () => {
  test('先看 task 再看交给谁：两样都没有时报的是 task', () => {
    expect(failureOf(() => askRequest({})).code).toBe(SessionsErrorCodes.taskEmpty)
    expect(failureOf(() => tellRequest({})).code).toBe(SessionsErrorCodes.messageEmpty)
  })

  test('to 与 workspace 都给了先报冲突，不管 workspace 认不认得', () => {
    expect(failureOf(() => askRequest({ to: 'a', workspace: 'cloud', task: 'x' })).code).toBe(
      SessionsErrorCodes.targetConflict
    )
  })

  test('工作区不认得先报，不管 root、site 对不对', () => {
    expect(
      failureOf(() => askRequest({ workspace: 'Browser', site: 'nope', task: 'x' })).message
    ).toContain('这里是 Browser')
  })

  test('说明点名字段并给出写法', () => {
    expect(failureOf(() => askRequest({ workspace: 'project', task: 'x' })).message).toContain(
      '/home/me/shop'
    )
    expect(
      failureOf(() => askRequest({ workspace: 'browser', site: 'jd.com', task: 'x' })).message
    ).toContain('https://www.example.com')
    expect(failureOf(() => askRequest({ to: 'a', task: 'x', timeout: 5 })).message).toContain(
      '只收 to、workspace、root、site、task'
    )
    expect(failureOf(() => tellRequest({ to: 'a', message: 'x', wait: true })).message).toContain(
      '只收 to、message'
    )
  })

  test('task、message 原样交出，前后的空白与换行都不动', () => {
    expect(askRequest({ to: 'a', task: '\n  第一步\n  第二步\n' })).toStrictEqual({
      to: 'a',
      task: '\n  第一步\n  第二步\n',
    })
    expect(tellRequest({ to: 'a', message: ' 注意 ' })).toStrictEqual({
      to: 'a',
      message: ' 注意 ',
    })
  })
})

describe('等宿主时撒手', () => {
  test('先到的赢；被撒手的那件事后来失败也没人漏接', async () => {
    expect(await untilAborted(Promise.resolve('ok'), new AbortController().signal)).toBe('ok')
    const controller = new AbortController()
    let fail = (_: unknown): void => {}
    const work = new Promise<string>((_, reject) => {
      fail = reject
    })
    const pending = untilAborted(work, controller.signal)
    controller.abort(new AppError('ABORTED', '撒手'))
    expect(await pending.catch((error: unknown) => AppError.from(error).message)).toBe('撒手')
    fail(new AppError('NETWORK', '后来才失败'))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
