import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { ProjectOperationContext } from '../contract/requires'
import { readReceipt, saveReceipt } from '../utils/agent/file-refs'

const collisionRoot =
  process.platform === 'win32' ? 'C:\\reference-collisions' : '/reference-collisions'
const collisionValues = process.platform === 'win32' ? [86432, 110733] : [82383, 159355]

function context(sessionId: string, root = collisionRoot): ProjectOperationContext {
  return {
    sessionId,
    project: { getRootPath: () => root },
  } as ProjectOperationContext
}

describe('项目短引用', () => {
  test('两个完整 SHA256 的前 8 位碰撞仍分别定位原回执，旧完整引用精确解析', () => {
    const ctx = context('collision-receipts')
    // 固定绝对根，分别保留 Windows 与 POSIX 的真实 SHA256 前缀碰撞。
    const values = collisionValues
    const hashes: string[] = []
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
            root: resolve(ctx.project.getRootPath()),
            value,
          })
        )
        .digest('hex')
      hashes.push(hash)
      expect(readReceipt(ctx, 'change', `change:${hash}`)).toBe(value)
    }
    expect(hashes[0]!.slice(0, 8)).toBe(hashes[1]!.slice(0, 8))
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
    const expired = saveReceipt(ctx, 'change', collisionValues[0])
    for (let index = 0; index < 40; index++)
      saveReceipt(context(`eviction-${index}`), 'change', index)
    const replacement = saveReceipt(ctx, 'change', collisionValues[1])
    expect(replacement).not.toBe(expired)
    expect(() => readReceipt(ctx, 'change', expired)).toThrow()
    expect(readReceipt(ctx, 'change', replacement)).toBe(collisionValues[1])
  })
})
