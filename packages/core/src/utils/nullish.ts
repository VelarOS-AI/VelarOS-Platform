/**
 * Nullish 归一化辅助（显式函数形式）。
 *
 * 历史上以 `globalThis.toNullable` / `globalThis.toOptional` 形式提供（`packages/core/src/extensions.ts`）；
 * 为避免作为 npm 库嵌入时污染宿主全局，改为具名导出，调用点显式 `import`。
 */

/** 将 `undefined` / `null` 归一化为 `null`。 */
export function toNullable<T>(value: T | null | undefined): T | null {
  return value ?? null
}

/** 将 `undefined` / `null` 归一化为 `undefined`。 */
export function toOptional<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined
}
