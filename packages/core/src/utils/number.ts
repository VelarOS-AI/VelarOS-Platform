/**
 * 数值语义化辅助（显式函数形式）。
 *
 * 一律具名导出：本包作为 npm 库嵌入宿主，禁改 `globalThis` 与 `Number.prototype`。
 */

/** 将数值限制在 `[min, max]` 范围内。 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * 先取整再限制在 `[min, max]` 内——数量类参数（limit / maxChars / maxDepth / 步数）的唯一钳制口径。
 *
 * 工具参数铁律是「钳制不拒绝」，各处曾各写一份 `Math.min(max, Math.max(min, Math.round(v)))`；
 * 同一算式抄六份就会有六种边界行为，故收成单源。新的数量钳制一律调这里，别再写内联算式。
 */
export function clampRounded(value: number, min: number, max: number): number {
  return clamp(Math.round(value), min, max)
}
