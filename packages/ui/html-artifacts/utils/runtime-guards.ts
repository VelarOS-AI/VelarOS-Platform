/**
 * 零依赖的运行时守卫：本包对外承诺「零运行时依赖的浏览器库」，不能反向依赖 `@velaros-ai/core`，
 * 所以在这里自带一份最小实现。判定一律用 `typeof` / `Object.prototype.toString`，不用 `instanceof`。
 */

/** 判断未知值是不是有限数。 */
export function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value as number)
}

/** 判断未知值是不是有限正数。 */
export function isFinitePositiveNumber(value: unknown): value is number {
  // @arch-guard:suspend code-style/prefer-is-finite-number-guard 理由：html-artifacts 保持零运行时依赖，无法导入 core 的 isFiniteNumber。
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * 判断未知值是不是函数。用 `typeof` 而不是 `instanceof Function`：`instanceof` 比的是本 realm 的
 * 原型链，宿主在另一个 realm（另一个 iframe、webview 桥）里造出来的函数会被判成「不是函数」——
 * 回调被静默丢掉、另一个 realm 传来的挂载目标被当成不是元素而拒绝。
 */
export function isFunction(value: unknown): value is Function {
  return typeof value === 'function'
}

/** 判断未知值是不是 `null`。 */
export function isNull(value: unknown): value is null {
  return Object.is(value, null)
}

/** 判断一个可空值是不是有值。 */
export function isNotNull<T>(value: Nullable<T>): value is T {
  return !isNull(value)
}

/** 判断未知值是不是对象（函数不算）。 */
export function isObject(value: unknown): value is object {
  return Object(value) === value && !isFunction(value)
}

/** 判断未知值是不是字符串原始值。 */
export function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === '[object String]' && Object(value) !== value
}

/** 判断未知值是不是 `undefined`。 */
export function isUndefined(value: unknown): value is undefined {
  return Object.is(value, undefined)
}

/** 把缺席值统一成 `null`，好让后面的判定只处理一种缺席。 */
export function toNullable<T>(value: LooseOptional<T>): Nullable<T> {
  return isUndefined(value) ? null : value
}
