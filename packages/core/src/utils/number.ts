/**
 * 数值语义化辅助（显式函数形式）。
 *
 * 历史上以 `Number.prototype` 扩展形式提供（`packages/core/src/extensions.ts`）；为避免作为 npm 库嵌入时
 * 污染宿主全局原型，改为具名导出，调用点显式 `import`。
 */

/** 将数值限制在 `[min, max]` 范围内。 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
