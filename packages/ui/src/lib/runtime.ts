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

export function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value as number)
}

export function isFunction(value: unknown): value is Function {
  return value instanceof Function
}

export function isNumber(value: unknown): value is number {
  return Object.prototype.toString.call(value) === '[object Number]' && Object(value) !== value
}

export function isPresent<T>(value: T): value is NonNullable<T> {
  return !isNull(value) && !isUndefined(value)
}

export function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === '[object String]' && Object(value) !== value
}

export function isNull(value: unknown): value is null {
  return Object.is(value, null)
}

export function isUndefined(value: unknown): value is undefined {
  return Object.is(value, undefined)
}

export function optionalWhen<T>(condition: unknown, value: T): Optional<T> {
  return condition ? value : undefined
}

export function optionalWhenLazy<T>(condition: unknown, value: () => T): Optional<T> {
  return condition ? value() : undefined
}

export function toNullable<T>(value: Optional<T>): Nullable<T> {
  return isUndefined(value) ? null : value
}

export function toOptional<T>(value: LooseOptional<T>): Optional<T> {
  return isNull(value) ? undefined : value
}
