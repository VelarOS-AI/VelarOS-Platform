/**
 * Nullish 归一化辅助（显式函数形式）。
 *
 * 一律具名导出：本包作为 npm 库嵌入宿主，禁往 `globalThis` 挂运行时原语。
 * 这两个函数是 null↔undefined 的**唯一合法转换点**，只允许在层边界各用一次，禁往返链。
 */
import { isNull, isUndefined } from '../typeGuards.js'

/** 将 `undefined` / `null` 归一化为 `null`。 */
export function toNullable<T>(value: LooseOptional<T>): Nullable<T> {
  return isUndefined(value) ? null : value
}

/** 将 `undefined` / `null` 归一化为 `undefined`。 */
export function toOptional<T>(value: LooseOptional<T>): T | undefined {
  return isNull(value) ? undefined : value
}
