import {
  TypeGuards,
  type VelarosRuntimeTypeGuardName,
  VelarosRuntimeTypeGuardNames,
  VelarosTypeGuardName,
} from '../typeGuards.js'

/**
 * 条件为真时返回 `value`，否则返回 `undefined` 或显式 fallback。
 *
 * 替代业务里的 `cond ? value : undefined` / `cond ? undefined : value`。
 * 真分支有副作用或需短路求值时用 **`optionalWhenLazy`**。
 *
 * 类型守卫与同参 identity 请写 **`optionalWhen(isString, value)`**（勿写 **`optionalWhen(isString(value), value)`**）。
 * 需要默认值时写 **`optionalWhen(isString, value, '')`**。
 * 只有 `TypeGuards` 里的 predicate 函数会被当作类型守卫执行；其它函数作为条件传入会抛错。
 */
type AnyFunction = (...args: any[]) => unknown
type OptionalWhenTypeGuard<T> = (value: unknown) => value is T
type OptionalWhenKnownTypeGuard =
  | typeof TypeGuards.isNull
  | typeof TypeGuards.isNotNull
  | typeof TypeGuards.isUndefined
  | typeof TypeGuards.isNotUndefined
  | typeof TypeGuards.isPresent
  | typeof TypeGuards.isBoolean
  | typeof TypeGuards.isTrue
  | typeof TypeGuards.isFalse
  | typeof TypeGuards.isString
  | typeof TypeGuards.isNonBlankString
  | typeof TypeGuards.isNumber
  | typeof TypeGuards.isPositiveNumber
  | typeof TypeGuards.isFiniteNumber
  | typeof TypeGuards.isFunction
  | typeof TypeGuards.isBigInt
  | typeof TypeGuards.isSymbol
  | typeof TypeGuards.isObject
  | typeof TypeGuards.isRecord
  | typeof TypeGuards.isPlainObject
  | typeof TypeGuards.isArray
  | typeof TypeGuards.isNonEmptyArray
type OptionalWhenGuardedValue<T> = T extends OptionalWhenTypeGuard<infer Value> ? Value : never
type NonFunctionCondition<T> = T extends AnyFunction ? never : T

const OptionalWhenTypeGuardFunctions = new Set<Function>([
  TypeGuards.isNull,
  TypeGuards.isNotNull,
  TypeGuards.isUndefined,
  TypeGuards.isNotUndefined,
  TypeGuards.isPresent,
  TypeGuards.isBoolean,
  TypeGuards.isTrue,
  TypeGuards.isFalse,
  TypeGuards.isString,
  TypeGuards.isNonBlankString,
  TypeGuards.isNumber,
  TypeGuards.isPositiveNumber,
  TypeGuards.isFiniteNumber,
  TypeGuards.isFunction,
  TypeGuards.isBigInt,
  TypeGuards.isSymbol,
  TypeGuards.isObject,
  TypeGuards.isRecord,
  TypeGuards.isPlainObject,
  TypeGuards.isArray,
  TypeGuards.isNonEmptyArray,
])
const OptionalWhenTypeGuardNames = new Set<VelarosRuntimeTypeGuardName>(
  VelarosRuntimeTypeGuardNames,
)

function isOptionalWhenTypeGuard<T>(value: unknown): value is OptionalWhenTypeGuard<T> {
  if (typeof value !== 'function') return false
  if (OptionalWhenTypeGuardFunctions.has(value)) return true
  const typeGuardName = (value as { [VelarosTypeGuardName]?: unknown })[VelarosTypeGuardName]
  return (
    typeof typeGuardName === 'string' &&
    OptionalWhenTypeGuardNames.has(typeGuardName as VelarosRuntimeTypeGuardName)
  )
}

function describeOptionalWhenFunction(value: Function): string {
  return value.name || '<anonymous>'
}

export function optionalWhen<G extends OptionalWhenKnownTypeGuard>(
  guard: G,
  value: unknown,
): OptionalWhenGuardedValue<G> | undefined
export function optionalWhen<G extends OptionalWhenKnownTypeGuard, F>(
  guard: G,
  value: unknown,
  fallback: F,
): OptionalWhenGuardedValue<G> | F
export function optionalWhen<C, T>(
  condition: NonFunctionCondition<C>,
  value: T,
): T | undefined
export function optionalWhen<C, T, F>(
  condition: NonFunctionCondition<C>,
  value: T,
  fallback: F,
): T | F
export function optionalWhen<T, F = undefined>(
  conditionOrGuard: unknown | ((value: unknown) => value is T),
  value: unknown,
  fallback?: F,
): T | F | undefined {
  if (typeof conditionOrGuard === 'function') {
    if (!isOptionalWhenTypeGuard<T>(conditionOrGuard)) {
      throw new TypeError(
        `optionalWhen only accepts TypeGuards predicate functions as guards; received ${describeOptionalWhenFunction(conditionOrGuard)}.`,
      )
    }
    return conditionOrGuard(value) ? (value as T) : fallback
  }
  return conditionOrGuard ? (value as T) : fallback
}

/**
 * 条件为真时执行 `value` 并返回结果，否则返回 `undefined`（短路求值）。
 *
 * 替代 `cond ? value() : undefined` 及真分支含调用的 `cond ? expr : undefined`。
 */
export function optionalWhenLazy<T>(condition: unknown, value: () => T): T | undefined {
  return condition ? value() : undefined
}
