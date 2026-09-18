/**
 * `@velaros-ai/velar/browser/renderer`：渲染进程要的那几件**值**。
 *
 * 地址栏、偏好、截图选项三件纯策略，加 React 合成边界。单开这个入口的唯一理由是运行环境：
 * 根入口的引用链会带进 `node:fs`（站点工作区、CDP 启动器），可移植入口按标准只许放常量与类型，
 * 而这几件是渲染进程真要调的函数。React 是可选 peer，只在这里出现。
 */
export type { BrowserCompositionApi } from './impl/BrowserComposition.js'
export { browserComposition } from './impl/BrowserComposition.js'
export type { BrowserAddressApi } from './impl/policies/BrowserAddress.js'
export { browserAddress } from './impl/policies/BrowserAddress.js'
export type { BrowserPreferencesApi } from './impl/policies/BrowserPreferences.js'
export { browserPreferences } from './impl/policies/BrowserPreferences.js'
export type { BrowserScreenshotPolicyApi } from './impl/policies/BrowserScreenshotPolicy.js'
export { browserScreenshotPolicy } from './impl/policies/BrowserScreenshotPolicy.js'
