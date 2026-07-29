/**
 * 字符串语义化辅助（显式函数形式）。
 *
 * 历史上这些能力以 `String.prototype` 扩展形式提供（`packages/core/src/extensions.ts`）；为避免作为
 * npm 库嵌入时污染宿主全局原型，改为具名导出，调用点显式 `import`。
 */

/** 是否为空或纯空白。 */
export function isBlank(value: string): boolean {
  return value.trim().length === 0
}

/** 超出 `maxLen` 时截断并加省略号。 */
export function truncate(value: string, maxLen: number, ellipsis = '…'): string {
  return value.length <= maxLen ? value : value.slice(0, maxLen) + ellipsis
}
