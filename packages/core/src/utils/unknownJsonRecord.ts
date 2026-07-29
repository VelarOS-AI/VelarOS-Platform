/**
 * 将 JSON 载荷收敛为普通 record，并安全读取原始字段。
 */
import { isRecord } from '../typeGuards'
import { isArray,isBoolean, isFiniteNumber, isString } from '../typeGuards.js'

import { optionalWhen } from './optionalWhen.js'
import { isBlank } from './string.js'

/** 非 null 的纯对象（不含数组），形如 `{ ... }` 时为 true。 */
export { isPlainObject, isRecord } from '../typeGuards'

export function asRecord(value: unknown): Nullable<Record<string, unknown>> {
  return isRecord(value) ? value : null
}

/** 别名，语义同 {@link asRecord}。 */
export { asRecord as readRecord }

/** 读取裁剪后的非空字符串。 */
export function readString(
  record: LooseOptional<Record<string, unknown>>,
  key: string
): Nullable<string> {
  if (!record || !isString(record[key])) return null

  const value = String(record[key]).trim()
  return isBlank(value) ? null : value
}

/**
 * 依据裁剪后的内容判断是否非空字符串；保留返回值两侧的原始空白。
 */
export function readStringPreserveOuterWhitespace(
  record: LooseOptional<Record<string, unknown>>,
  key: string
): Nullable<string> {
  if (!record || !isString(record[key])) return null

  const value = String(record[key])
  return isBlank(value.trim()) ? null : value
}

/** 读取 JSON 字符串叶子：trim，并用 `isBlank` 丢弃空白。 */
export function readStringScalar(value: unknown): Nullable<string> {
  if (!isString(value)) return null
  const trimmed = value.trim()
  return isBlank(trimmed) ? null : trimmed
}

/** 在多个 JSON 字符串叶子中读取第一个裁剪后的非空字符串。 */
export function readFirstString(...values: unknown[]): Nullable<string> {
  for (const value of values) {
    const text = readStringScalar(value)
    if (text) return text
  }

  return null
}

/** 非 string → `''`；string → trim（可能为空串）。 */
export { trimmedStringOrEmpty as coerceTrimmedString } from '../typeGuards'

export function readNumber(
  record: LooseOptional<Record<string, unknown>>,
  key: string
): Nullable<number> {
  const value = record?.[key]
  return isFiniteNumber(value) ? value : null
}

/** 读取有限数字叶子。 */
export function readNumberScalar(value: unknown): Nullable<number> {
  return isFiniteNumber(value) ? value : null
}

export function readBoolean(
  record: LooseOptional<Record<string, unknown>>,
  key: string
): Nullable<boolean> {
  const value = record?.[key]
  return isBoolean(value) ? value : null
}

export function readBooleanScalar(value: unknown): Nullable<boolean> {
  return isBoolean(value) ? value : null
}

export function peekLooseString(
  record: LooseOptional<Record<string, unknown>>,
  key: string
): string | undefined {
  const value = record?.[key]
  return optionalWhen(isString, value)
}

export function peekLooseBoolean(
  record: LooseOptional<Record<string, unknown>>,
  key: string
): boolean | undefined {
  const value = record?.[key]
  return optionalWhen(isBoolean, value)
}

export function readStringArray(
  record: LooseOptional<Record<string, unknown>>,
  key: string
): string[] {
  if (!record || !isArray(record[key])) return []

  return record[key]
    .filter((value): value is string => isString(value))
    .map((value) => value.trim())
    .filter((value) => !isBlank(value))
}

/** 每个元素若为 string 则保留（不做 trim / 空白过滤）。 */
export function normalizeUnknownStringArray(value: unknown): string[] {
  return isArray(value) ? value.filter((entry): entry is string => isString(entry)) : []
}

export function readRecordsArray(
  record: LooseOptional<Record<string, unknown>>,
  key: string
): Array<Record<string, unknown>> {
  if (!record || !isArray(record[key])) return []

  return record[key].flatMap((item) => {
    const itemRecord = asRecord(item)
    return itemRecord ? [itemRecord] : []
  })
}
