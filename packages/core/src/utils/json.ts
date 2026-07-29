/**
 * JSON 序列化辅助（显式函数形式）。
 *
 * 历史上以 `JSON.stringifyPretty` 静态扩展形式提供（`packages/core/src/extensions.ts`）；为避免作为
 * npm 库嵌入时污染宿主全局，改为具名导出，调用点显式 `import`。
 */

/** 按默认两空格格式化 JSON。 */
export function stringifyPretty(
  value: unknown,
  replacer?: JsonStringifyReplacer,
  space: string | number = 2,
): string {
  return JSON.stringify(value, replacer as Parameters<typeof JSON.stringify>[1], space)
}
