/**
 * 数组语义化辅助（显式函数形式）。
 *
 * 一律具名导出、调用点显式 `import`：本包作为 npm 库嵌入宿主，禁改 `globalThis` 与内建原型
 * （原 `Array.prototype` 扩展入口已按宪章处决清单拔除，勿复活）。
 *
 * `isEmpty` 同时覆盖字符串与数组（二者皆有 `length`），两侧语义一致。
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
