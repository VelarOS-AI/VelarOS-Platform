/**
 * `@velaros-ai/browser/composition/mod` 入口：mod 定义、常驻集与工具类别。
 *
 * 子路径名不变，实现搬到 `impl/tools/mod.ts`。
 */
export type { BrowserBundledModDefinition, BrowserToolCategoryId } from '../impl/tools/mod.js'
export {
  BrowserModId,
  BrowserResidentToolNames,
  BrowserSpaceId,
  BrowserToolCategoryDefinitions,
  BrowserToolCategoryIds,
  BrowserToolNamesByCategory,
  createBrowserBundledModDefinition,
} from '../impl/tools/mod.js'
