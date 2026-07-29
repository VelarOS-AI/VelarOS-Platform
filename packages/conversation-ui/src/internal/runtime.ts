export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

export function isBlank(value: string): boolean {
  return value.trim().length === 0
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

export function isEmpty(value: string | readonly unknown[]): boolean {
  return value.length === 0
}

export function isFalse(value: unknown): value is false {
  return value === false
}

export function isTrue(value: unknown): value is true {
  return value === true
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isFunction(value: unknown): value is Function {
  return typeof value === 'function'
}

export function isNotNull<T>(value: Nullable<T>): value is T {
  return value !== null
}

export function isNull(value: unknown): value is null {
  return value === null
}

export function isUndefined(value: unknown): value is undefined {
  return value === undefined
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number'
}

export function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && value > 0
}

export function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !Array.isArray(value)
}

export const isPlainObject = isRecord

export function isPresent<T>(value: T): value is NonNullable<T> {
  return value != null
}

export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

export function numberOrNull(value: unknown): Nullable<number> {
  return isNumber(value) ? value : null
}

export function first<T>(value: readonly T[]): T | undefined {
  return value[0]
}

export function last<T>(value: readonly T[]): T | undefined {
  return value[value.length - 1]
}

type TypeGuard<T> = (value: unknown) => value is T

export function optionalWhen<T>(guard: TypeGuard<T>, value: unknown): T | undefined
export function optionalWhen<T, F>(
  guard: TypeGuard<T>,
  value: unknown,
  fallback: F
): T | F
export function optionalWhen<C, T>(condition: C, value: T): T | undefined
export function optionalWhen<C, T, F>(condition: C, value: T, fallback: F): T | F
export function optionalWhen<T, F = undefined>(
  condition: unknown | TypeGuard<T>,
  value: unknown,
  fallback?: F
): T | F | undefined {
  if (typeof condition === 'function') return condition(value) ? (value as T) : fallback
  return condition ? (value as T) : fallback
}

export function optionalWhenLazy<T>(condition: unknown, value: () => T): T | undefined {
  return condition ? value() : undefined
}

export function toNullable<T>(value: LooseOptional<T>): Nullable<T> {
  return value ?? null
}

export function toOptional<T>(value: LooseOptional<T>): T | undefined {
  return value ?? undefined
}

export function trimmedStringOrEmpty(value: unknown): string {
  return isString(value) ? value.trim() : ''
}

export function truncate(value: string, maxLength: number, ellipsis = '…'): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}${ellipsis}`
}

export function stringifyPretty(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

interface UiLog {
  debug(message: string, context?: unknown): void
  warn(message: string, context?: unknown): void
  error(message: string, context?: unknown): void
}

export const Log = {
  tag(tag: string): UiLog {
    return {
      debug: (message, context) => console.info(`[${tag}] ${message}`, context),
      warn: (message, context) => console.warn(`[${tag}] ${message}`, context),
      error: (message, context) => console.error(`[${tag}] ${message}`, context),
    }
  },
}
