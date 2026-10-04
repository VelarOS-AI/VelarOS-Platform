import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import type { ProjectOperationContext } from '../contract/requires'
import { readReceipt, saveReceipt } from '../utils/agent/file-refs'

function context(sessionId: string, root = '/reference-collisions'): ProjectOperationContext {
  return {
    sessionId,
    project: { getRootPath: () => root },
  } as ProjectOperationContext
}

describe('项目短引用', () => {
  test('两个完整 SHA256 的前 8 位碰撞仍分别定位原回执，旧完整引用精确解析', () => {
    const ctx = context('collision-receipts')
    // 下列两份合法回执的 SHA256 前缀都是 adf7de9b。
    const values = [82383, 159355]
    const refs = values.map((value) => saveReceipt(ctx, 'change', value))
    expect(refs[0]).toMatch(/^change:[a-f0-9]{8}$/)
    expect(refs[1]).toMatch(/^change:[a-f0-9]{8}$/)
    expect(refs[0]).not.toBe(refs[1])
    for (const [index, value] of values.entries()) {
      expect(readReceipt(ctx, 'change', refs[index]!)).toBe(value)
      const hash = createHash('sha256')
        .update(
          JSON.stringify({
            kind: 'project-receipt',
            version: 1,
            receipt: 'change',
            root: '/reference-collisions',
            value,
          })
        )
        .digest('hex')
      expect(readReceipt(ctx, 'change', `change:${hash}`)).toBe(value)
    }
    expect(saveReceipt(ctx, 'change', values[0])).toBe(refs[0])
  })

  test('跨会话、项目、类型和手写引用都不能命中回执', () => {
    const ctx = context('scoped-receipt')
    const ref = saveReceipt(ctx, 'change', { transactionId: 'internal-id' })
    expect(() => readReceipt(context('other-session'), 'change', ref)).toThrow()
    expect(() => readReceipt(context('scoped-receipt', '/other-project'), 'change', ref)).toThrow()
    expect(() => readReceipt(ctx, 'change', ref.replace('change:', 'view:'))).toThrow()
    expect(() => readReceipt(ctx, 'change', 'change:012345678')).toThrow()
  })

  test('整份会话淘汰后，碰撞记录不能拿走已失效引用', () => {
    const ctx = context('expired-collision')
    const expired = saveReceipt(ctx, 'change', 82383)
    for (let index = 0; index < 40; index++)
      saveReceipt(context(`eviction-${index}`), 'change', index)
    const replacement = saveReceipt(ctx, 'change', 159355)
    expect(replacement).not.toBe(expired)
    expect(() => readReceipt(ctx, 'change', expired)).toThrow()
    expect(readReceipt(ctx, 'change', replacement)).toBe(159355)
  })
})
