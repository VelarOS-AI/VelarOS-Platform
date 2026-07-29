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

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isFunction(value: unknown): value is Function {
  return typeof value === 'function'
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number'
}

export function isPresent<T>(value: T): value is NonNullable<T> {
  return value != null
}

export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

export function optionalWhen<T>(condition: unknown, value: T): T | undefined {
  return condition ? value : undefined
}

export function optionalWhenLazy<T>(condition: unknown, value: () => T): T | undefined {
  return condition ? value() : undefined
}

export function toNullable<T>(value: T | undefined): T | null {
  return value ?? null
}

export function toOptional<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined
}
