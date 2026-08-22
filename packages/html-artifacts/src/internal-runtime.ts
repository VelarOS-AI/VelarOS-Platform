const writeDebug = globalThis.console.debug.bind(globalThis.console)
const writeError = globalThis.console.error.bind(globalThis.console)
const writeWarning = globalThis.console.warn.bind(globalThis.console)

export function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value as number)
}

export function isFunction(value: unknown): value is Function {
  return value instanceof Function
}

export function isNull(value: unknown): value is null {
  return Object.is(value, null)
}

export function isNotNull<T>(value: Nullable<T>): value is T {
  return !isNull(value)
}

export function isObject(value: unknown): value is object {
  return Object(value) === value && !isFunction(value)
}

export function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === '[object String]' && Object(value) !== value
}

export function isUndefined(value: unknown): value is undefined {
  return Object.is(value, undefined)
}

export function toNullable<T>(value: LooseOptional<T>): Nullable<T> {
  return isUndefined(value) ? null : value
}

interface RuntimeLog {
  debug(message: string, context?: unknown): void
  error(message: string, context?: unknown): void
  warn(message: string, context?: unknown): void
}

export const Log = {
  tag(tag: string): RuntimeLog {
    return {
      debug: (message, context) => writeDebug(`[${tag}] ${message}`, context),
      error: (message, context) => writeError(`[${tag}] ${message}`, context),
      warn: (message, context) => writeWarning(`[${tag}] ${message}`, context),
    }
  },
}
