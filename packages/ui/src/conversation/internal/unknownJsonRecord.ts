import { optionalWhen } from './runtime'
import {
  isArray,
  isBlank,
  isBoolean,
  isFiniteNumber,
  isRecord,
  isString,
} from './runtime'

export { isRecord }
export { isRecord as isPlainObject }

export function asRecord(value: unknown): Nullable<Record<string, unknown>> {
  return isRecord(value) ? value : null
}

export const readRecord = asRecord

export function readString(
  record: LooseOptional<Record<string, unknown>>,
  key: string
): Nullable<string> {
  const value = record?.[key]
  if (!isString(value)) return null
  const trimmed = value.trim()
  return isBlank(trimmed) ? null : trimmed
}

export function readStringPreserveOuterWhitespace(
  record: LooseOptional<Record<string, unknown>>,
  key: string
): Nullable<string> {
  const value = record?.[key]
  return isString(value) && !isBlank(value) ? value : null
}

export function readStringScalar(value: unknown): Nullable<string> {
  if (!isString(value)) return null
  const trimmed = value.trim()
  return isBlank(trimmed) ? null : trimmed
}

export function readFirstString(...values: unknown[]): Nullable<string> {
  for (const value of values) {
    const stringValue = readStringScalar(value)
    if (stringValue) return stringValue
  }
  return null
}

export function readNumber(
  record: LooseOptional<Record<string, unknown>>,
  key: string
): Nullable<number> {
  const value = record?.[key]
  return isFiniteNumber(value) ? value : null
}

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
  const value = record?.[key]
  return isArray(value)
    ? value.filter(isString).map((entry) => entry.trim()).filter((entry) => !isBlank(entry))
    : []
}

export function readRecordsArray(
  record: LooseOptional<Record<string, unknown>>,
  key: string
): Array<Record<string, unknown>> {
  const value = record?.[key]
  return isArray(value) ? value.filter(isRecord) : []
}
