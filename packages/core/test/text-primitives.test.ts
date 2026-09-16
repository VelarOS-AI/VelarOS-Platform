import { describe, expect, test } from 'bun:test'

import { AppError } from '../src/error'
import { readErrnoCode } from '../src/utils/errors'
import { stableStringify } from '../src/utils/json'
import { clampToCodePointBoundary, takeTail, truncate } from '../src/utils/string'

/** 是否含孤立代理项（`String.prototype.isWellFormed` 要 ES2024 的 lib，这里就地判定）。 */
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

describe('truncate 与代理对', () => {
  test('切口落在代理对中间时整对丢掉，不留孤立代理项', () => {
    const truncated = truncate('ab😀cd', 3)
    expect(truncated).toBe('ab…')
    expect(hasLoneSurrogate(truncated)).toBe(false)
  })

  test('切口正好在代理对之后时整对留下', () => {
    expect(truncate('ab😀cd', 4)).toBe('ab😀…')
  })

  test('不超长就原样返回，超长的省略号可换', () => {
    expect(truncate('abc', 3)).toBe('abc')
    expect(truncate('abcd', 3, '...')).toBe('abc...')
  })

  test('上限为零时只剩省略号', () => {
    expect(truncate('😀', 0)).toBe('…')
  })
})

describe('clampToCodePointBoundary', () => {
  test('只在切口把代理对劈开时才挪，其余原样返回', () => {
    const text = 'a😀b'
    expect(clampToCodePointBoundary(text, 2)).toBe(1)
    expect(clampToCodePointBoundary(text, 2, 'forward')).toBe(3)
    expect(clampToCodePointBoundary(text, 1)).toBe(1)
    expect(clampToCodePointBoundary(text, 3)).toBe(3)
  })

  test('越界的下标夹回两端', () => {
    expect(clampToCodePointBoundary('a😀b', -5)).toBe(0)
    expect(clampToCodePointBoundary('a😀b', 99)).toBe(4)
  })
})

describe('takeTail', () => {
  test('取尾巴时把被劈开的半个代理项丢掉', () => {
    const tail = takeTail('ab😀cd', 3)
    expect(tail).toBe('cd')
    expect(hasLoneSurrogate(tail)).toBe(false)
  })

  test('整对完整时原样保留', () => {
    expect(takeTail('ab😀cd', 4)).toBe('😀cd')
    expect(takeTail('abc', 10)).toBe('abc')
    expect(takeTail('abc', 0)).toBe('')
  })
})

describe('AppError 的字符串化截断', () => {
  test('截断后的消息不含孤立代理项', () => {
    const message = AppError.getMessage({ detail: '😀'.repeat(600) })

    expect(message.length).toBeLessThanOrEqual(1_000)
    expect(hasLoneSurrogate(message)).toBe(false)
    expect(message.endsWith('…')).toBe(true)
  })

  test('凭据类字段照旧打码', () => {
    expect(AppError.getMessage({ apiKey: 'sk-secret', other: 1 })).toContain('[redacted]')
  })

  test('UNAVAILABLE 是一个可用的错误码', () => {
    expect(new AppError('UNAVAILABLE', '语言服务没就绪').code).toBe('UNAVAILABLE')
  })
})

describe('readErrnoCode', () => {
  test('读出系统错误的 code 字段', () => {
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' })

    expect(readErrnoCode(error)).toBe('ENOENT')
    expect(readErrnoCode({ code: 'EACCES' })).toBe('EACCES')
  })

  test('认不出的值一律 null', () => {
    expect(readErrnoCode(new Error('plain'))).toBeNull()
    expect(readErrnoCode({ code: 12 })).toBeNull()
    expect(readErrnoCode(null)).toBeNull()
    expect(readErrnoCode('ENOENT')).toBeNull()
  })
})

describe('stableStringify', () => {
  test('键序与写入顺序无关，按码元序排', () => {
    expect(stableStringify({ b: 1, a: 2, A: 3 })).toBe(stableStringify({ a: 2, A: 3, b: 1 }))
    expect(stableStringify({ b: 1, a: 2, A: 3 })).toBe('{"A":3,"a":2,"b":1}')
  })

  test('嵌套结构与数组同样稳定，数组顺序保持不变', () => {
    expect(stableStringify({ list: [{ y: 1, x: 2 }] })).toBe('{"list":[{"x":2,"y":1}]}')
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]')
  })

  test('undefined 字段略去、Date 取 ISO 文本、遇环写占位', () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}')
    expect(stableStringify({ at: new Date('2026-09-16T00:00:00.000Z') })).toBe(
      '{"at":"2026-09-16T00:00:00.000Z"}',
    )

    const cyclic: Record<string, unknown> = { name: 'root' }
    cyclic.self = cyclic
    expect(stableStringify(cyclic)).toBe('{"name":"root","self":"[circular]"}')
  })

  test('顶层 undefined 退化成 null 文本，不抛错', () => {
    expect(stableStringify(undefined)).toBe('null')
  })
})
