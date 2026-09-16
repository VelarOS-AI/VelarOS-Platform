import { isEmpty, isNotNull, isNumber, isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { MemorySqliteDatabaseV2 } from '../../types/tree-v2/authority'
import type { MemorySealedContentV2 } from '../../types/tree-v2/storage'

/**
 * 记忆树 v2 内部共用的入参校验、纯对象判定、排序比较与 blob 登记。
 *
 * 这些判据原来在十来个 v2 文件里各抄一份（`assert*` 5 份、`isStrictRecord*` 3 份、
 * 逐码元比较 3 份、`registerBlob*` 4 份），文字与边界条件已经开始漂移；收成这一处单源。
 */

/** 断言是非空字符串，否则抛 VALIDATION；label 会原样进错误文字。 */
export function assertNonEmptyStringV2(value: unknown, label: string): asserts value is string {
  if (!isString(value) || isEmpty(value)) {
    throw new AppError('VALIDATION', `${label} 不得为空。`)
  }
}

/** 断言是字符串（允许空串），否则抛 VALIDATION。 */
export function assertStringV2(value: unknown, label: string): asserts value is string {
  if (!isString(value)) {
    throw new AppError('VALIDATION', `${label} 必须是字符串。`)
  }
}

/** 断言是非负安全整数（时间戳、序号、计数），否则抛 VALIDATION。 */
export function assertNonNegativeSafeIntegerV2(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError('VALIDATION', `${label} 必须是非负安全整数。`)
  }
}

/** 断言是正安全整数（代号、版本、批量），否则抛 VALIDATION。 */
export function assertPositiveSafeIntegerV2(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AppError('VALIDATION', `${label} 必须是正安全整数。`)
  }
}

/** 判断是不是纯对象（原型只能是 Object.prototype 或 null）：挡住原型污染与类实例。 */
export function isPlainRecordV2(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || !isNotNull(prototype)
}

/** 判断是不是「键集恰好等于 expectedKeys」的纯对象：严格解析用它拒未知字段与缺字段。 */
export function isStrictRecordV2(
  value: unknown,
  expectedKeys: readonly string[]
): value is Record<string, unknown> {
  if (!isPlainRecordV2(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

/** 逐 UTF-16 码元比较两个字符串：排序必须与语言环境无关，哈希才能跨机器一致。 */
export function compareCodeUnitV2(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

/** 读一个返回安全整数的 pragma；返回别的东西就是库被动过，抛 INVARIANT。 */
export function readIntegerPragmaV2(database: MemorySqliteDatabaseV2, pragma: string): number {
  const value = database.pragma(pragma, { simple: true })
  if (!isNumber(value) || !Number.isSafeInteger(value)) {
    throw new AppError('INVARIANT', 'SQLite pragma 未返回安全整数。', undefined, { pragma, value })
  }
  return value
}

/** 把封存好的密文正文登记进权威库的 blob 账本（状态 active）。 */
export function registerMemoryContentBlobV2(
  database: MemorySqliteDatabaseV2,
  sealed: MemorySealedContentV2,
  createdAt: number
): void {
  database
    .prepare(
      `INSERT INTO memory_content_blobs(blob_id, byte_length, state, created_at)
       VALUES (?, ?, 'active', ?)`
    )
    .run(sealed.blobId, sealed.byteLength, createdAt)
}
