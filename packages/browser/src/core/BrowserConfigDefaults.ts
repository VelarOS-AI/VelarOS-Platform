/**
 * 浏览器产品配置的**唯一权威**：合法值闭集、出厂默认值、宽容守卫。
 *
 * 为什么住在浏览器包而不是宿主：这两个旋钮是浏览器语义（搜索引擎、自动化后端），
 * 加一个引擎理应只改这里。此前同一份枚举在三处各写一遍——IPC 契约、本包 `types.ts`、
 * 宿主 Normalizer 的字面量复检——漏改任何一处的表现都是"设置页选了、下次读盘被静默打回"。
 *
 * 闭集导出成 `as const` 元组而不是只留联合类型，是为了让持久层 schema（zod enum）也能
 * 从同一份清单生成：类型对齐了但校验没对齐，等于没对齐。
 */

import type { BrowserAutomationMode, BrowserSearchEngineId } from './types.js'

export const BrowserSearchEngineIds = [
  'google',
  'bing',
] as const satisfies readonly BrowserSearchEngineId[]

export const BrowserAutomationModes = [
  'webview',
  'external',
] as const satisfies readonly BrowserAutomationMode[]

export const DefaultBrowserSearchEngine: BrowserSearchEngineId = 'google'
export const DefaultBrowserAutomationMode: BrowserAutomationMode = 'webview'

export function isBrowserSearchEngineId(value: unknown): value is BrowserSearchEngineId {
  return (BrowserSearchEngineIds as readonly unknown[]).includes(value)
}

export function isBrowserAutomationMode(value: unknown): value is BrowserAutomationMode {
  return (BrowserAutomationModes as readonly unknown[]).includes(value)
}

/** 宽容解析：认不出的值回落 fallback，不拒绝、不抛。 */
export function resolveBrowserSearchEngineId(
  value?: LooseOptional<string>,
  fallback: BrowserSearchEngineId = DefaultBrowserSearchEngine
): BrowserSearchEngineId {
  return isBrowserSearchEngineId(value) ? value : fallback
}

/** 宽容解析：认不出的值回落 fallback，不拒绝、不抛。 */
export function resolveBrowserAutomationMode(
  value?: LooseOptional<string>,
  fallback: BrowserAutomationMode = DefaultBrowserAutomationMode
): BrowserAutomationMode {
  return isBrowserAutomationMode(value) ? value : fallback
}
