import {
  type VelarosRuntimeTypeGuardName,
  VelarosRuntimeTypeGuardNames,
  VelarosTypeGuardName,
  type VelarTypeGuards,
} from '../typeGuards'

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
/**
 * 可当守卫传入的谓词闭集，**由 `VelarosRuntimeTypeGuardNames` 派生**。
 *
 * 早期版本把这 21 个守卫在本文件里又抄了两份（一份类型联合、一份运行时 Set）。三份清单同义
 * 不同源，新增守卫只要漏改一处就会出现「类型允许但运行时抛 TypeError」的裂缝，故改为单源派生。
 */
type OptionalWhenKnownTypeGuard = VelarTypeGuards[VelarosRuntimeTypeGuardName]
type OptionalWhenGuardedValue<T> = T extends OptionalWhenTypeGuard<infer Value> ? Value : never
type NonFunctionCondition<T> = T extends AnyFunction ? never : T

const OptionalWhenTypeGuardNames = new Set<VelarosRuntimeTypeGuardName>(
  VelarosRuntimeTypeGuardNames,
)

/**
 * 只认 `TypeGuards` 家的谓词：靠 `typeGuards.ts` 打在函数上的注册符号品牌识别。
 *
 * 品牌用 `Symbol.for` 注册符号，故比函数身份比较更稳（双份模块副本下仍成立）。
 */
function isOptionalWhenTypeGuard<T>(value: unknown): value is OptionalWhenTypeGuard<T> {
  if (typeof value !== 'function') return false
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
