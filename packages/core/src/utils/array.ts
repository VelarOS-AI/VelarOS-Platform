/**
 * 数组语义化辅助（显式函数形式）。
 *
 * 历史上这些能力以 `Array.prototype` 扩展形式提供（`packages/core/src/extensions.ts`）；为避免作为
 * npm 库嵌入时污染宿主全局原型，改为具名导出，调用点显式 `import`。
 *
 * `isEmpty` 同时覆盖字符串与数组（二者皆有 `length`），沿用原扩展在 `Array` / `String` 两个原型上的一致语义。
 */

/** 是否为空数组 / 空字符串。 */
export function isEmpty(value: string | readonly unknown[]): boolean {
  return value.length === 0
}

/** 第一个元素，不存在返回 `undefined`。 */
export function first<T>(value: readonly T[]): T | undefined {
  return value[0]
}

/** 最后一个元素，不存在返回 `undefined`。 */
export function last<T>(value: readonly T[]): T | undefined {
  return value[value.length - 1]
}

/** 去重（浅比较）。 */
export function unique<T>(value: readonly T[]): T[] {
  return [...new Set(value)]
}

/** 移除所有 falsy 值。 */
export function compact<T>(value: readonly T[]): Array<NonNullable<T>> {
  return value.filter(Boolean) as Array<NonNullable<T>>
}

/** 数值求和，可传取值函数。 */
export function sum<T>(value: readonly T[], fn?: (item: T) => number): number {
  return value.reduce((acc: number, item: T) => acc + (fn ? fn(item) : Number(item)), 0)
}
