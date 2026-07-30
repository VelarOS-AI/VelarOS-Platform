/**
 * 字符串语义化辅助（显式函数形式）。
 *
 * 一律具名导出：本包作为 npm 库嵌入宿主，禁改 `globalThis` 与 `String.prototype`。
 */

/** 是否为空或纯空白。 */
export function isBlank(value: string): boolean {
  return value.trim().length === 0
}

/** 超出 `maxLen` 时截断并加省略号。 */
export function truncate(value: string, maxLen: number, ellipsis = '…'): string {
  return value.length <= maxLen ? value : value.slice(0, maxLen) + ellipsis
}
