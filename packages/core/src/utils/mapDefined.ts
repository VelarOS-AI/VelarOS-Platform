import { isUndefined } from '../typeGuards.js'

/**
 * 若 `value` 为 `undefined` 则返回 `undefined`，否则返回 `map(value)`。
 *
 * 用于在「仅缺席用 undefined」的边界做类型转换（例如 `String`、`JSON.stringify`），避免重复三元。
 */
export function mapDefined<T, R>(value: T | undefined, map: (value: T) => R): R | undefined {
  return isUndefined(value) ? undefined : map(value)
}
