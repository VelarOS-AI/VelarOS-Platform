import { describe, expect, test } from 'bun:test'

import { shortReferenceId } from '../src/utils/shortReferenceId'

describe('短引用签发', () => {
  test('跳过真实碰撞，只返回未占用的 8 位身份', () => {
    const claimed = new Set(['deadbeef', 'cafebabe'])
    const ids = ['deadbeef', 'cafebabe', '01234567']
    expect(
      shortReferenceId(
        (id) => claimed.has(id),
        (attempt) => ids[attempt]!
      )
    ).toBe('01234567')
  })
  test('连续冲突有界失败，非法候选不能降级为长引用', () => {
    expect(() =>
      shortReferenceId(
        () => true,
        () => 'deadbeef'
      )
    ).toThrow('短引用连续冲突')
    expect(() =>
      shortReferenceId(
        () => false,
        () => 'not-a-reference'
      )
    ).toThrow('8 位十六进制')
  })
})
