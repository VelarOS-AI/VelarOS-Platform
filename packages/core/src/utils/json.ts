/**
 * JSON 序列化辅助（显式函数形式）。
 *
 * 一律具名导出：本包作为 npm 库嵌入宿主，禁在 `JSON` 上挂静态扩展。
 */

/** 按默认两空格格式化 JSON。 */
export function stringifyPretty(
  value: unknown,
  replacer?: JsonStringifyReplacer,
  space: string | number = 2,
): string {
  return JSON.stringify(value, replacer as Parameters<typeof JSON.stringify>[1], space)
}
