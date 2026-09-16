/**
 * `@velaros-ai/browser/composition/mod` 入口：mod 定义、常驻集与工具类别。
 *
 * 子路径名不变，实现搬到工具文件 `impl/BrowserTools.ts`。
 */
export { BrowserModId, BrowserSpaceId } from './contract/constants'
export type { BrowserBundledModDefinition, BrowserToolCategoryId } from './impl/BrowserTools.js'
export {
  BrowserResidentToolNames,
  BrowserToolCategoryDefinitions,
  BrowserToolCategoryIds,
  BrowserToolNamesByCategory,
  createBrowserBundledModDefinition,
} from './impl/BrowserTools.js'
