export function isArray(value: unknown): value is unknown[] {
  return Object.prototype.toString.call(value) === '[object Array]'
}

export function isBlank(value: string): boolean {
  return !value.trim()
}

export function isBoolean(value: unknown): value is boolean {
  return Boolean(value) === value
}

export function isEmpty(value: string | readonly unknown[]): boolean {
  return Boolean(value[Symbol.iterator]().next().done)
}

export function isFalse(value: unknown): value is false {
  return isBoolean(value) && !value
}

export function isTrue(value: unknown): value is true {
  return isBoolean(value) && value
}

export function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value as number)
}

export function isFunction(value: unknown): value is Function {
  return value instanceof Function
}

export function isNotNull<T>(value: Nullable<T>): value is T {
  return !Object.is(value, null)
}

export function isNull(value: unknown): value is null {
  return Object.is(value, null)
}

export function isUndefined(value: unknown): value is undefined {
  return Object.is(value, undefined)
}

export function isNumber(value: unknown): value is number {
  return Object.prototype.toString.call(value) === '[object Number]' && Object(value) !== value
}

export function isPositiveNumber(value: unknown): value is number {
  if (!isNumber(value)) return false
  return value > 0
}

export function isNonBlankString(value: unknown): value is string {
  if (!isString(value)) return false
  return Boolean(value.trim())
}

export function isObject(value: unknown): value is object {
  return Object(value) === value && !isFunction(value)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value) && Object.prototype.toString.call(value) !== '[object Array]'
}

export const isPlainObject = isRecord

export function isPresent<T>(value: T): value is NonNullable<T> {
  return !isNull(value) && !isUndefined(value)
}

export function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === '[object String]' && Object(value) !== value
}

export function numberOrNull(value: unknown): Nullable<number> {
  if (!isNumber(value)) return null
  return value
}

export function first<T>(value: readonly T[]): Optional<T> {
  return value[0]
}

export function last<T>(value: readonly T[]): Optional<T> {
  return value[value.length - 1]
}

type TypeGuard<T> = (value: unknown) => value is T

export function optionalWhen<T>(guard: TypeGuard<T>, value: unknown): Optional<T>
export function optionalWhen<T, F>(
  guard: TypeGuard<T>,
  value: unknown,
  fallback: F
): T | F
export function optionalWhen<C, T>(condition: C, value: T): Optional<T>
export function optionalWhen<C, T, F>(condition: C, value: T, fallback: F): T | F
export function optionalWhen<T, F = undefined>(
  condition: unknown | TypeGuard<T>,
  value: unknown,
  fallback?: F
): Optional<T | F> {
  if (isFunction(condition)) return condition(value) ? (value as T) : fallback
  return condition ? (value as T) : fallback
}

export function optionalWhenLazy<T>(condition: unknown, value: () => T): Optional<T> {
  return condition ? value() : undefined
}

export function toNullable<T>(value: LooseOptional<T>): Nullable<T> {
  return isUndefined(value) ? null : value
}

export function toOptional<T>(value: LooseOptional<T>): Optional<T> {
  return isNull(value) ? undefined : value
}

export function trimmedStringOrEmpty(value: unknown): string {
  if (!isString(value)) return ''
  return value.trim()
}

export function truncate(value: string, maxLength: number, ellipsis = '…'): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}${ellipsis}`
}

export function stringifyPretty(value: unknown): string {
  return JSON.stringify(value, (_key, nestedValue) => nestedValue, 2)
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
