/**
 * 可在浏览器中安全使用的契约与确定性策略。
 *
 * 本入口刻意排除 `CDP` 传输、启动器、文件系统访问与宿主运行时实现。浏览器、渲染器、工作线程、
 * 远程调用和测试消费者可直接导入，不会引入 `Node.js` 内置模块。
 */
export {
  getBrowserSiteHost,
  getBrowserUrlCandidate,
  isLocalBrowserUrl,
  resolveBrowserNavigationInput,
  resolveBrowserSearchFallbackUrl,
  resolveBrowserSearchOrNavigationInput,
} from './BrowserAddressHelper.js'
export {
  BrowserAutomationModes,
  BrowserSearchEngineIds,
  DefaultBrowserAutomationMode,
  DefaultBrowserSearchEngine,
  isBrowserAutomationMode,
  isBrowserSearchEngineId,
  resolveBrowserAutomationMode,
  resolveBrowserSearchEngineId,
} from './BrowserConfigDefaults.js'
export { BrowserModId, BrowserSpaceId } from './BrowserModIdentity.js'
export {
  BrowserScreenshotDefaultDomStable,
  BrowserScreenshotDefaultModelImage,
  BrowserScreenshotDefaultNetworkIdleMs,
  type BrowserScreenshotPolicyDefaults,
  type BrowserScreenshotPolicyOptions,
  buildBrowserScreenshotOptions,
} from './BrowserScreenshotPolicy.js'
export {
  BrowserViewNotAttachedReason,
  isBrowserViewNotAttachedError,
} from './BrowserViewAttachment.js'
export type * from './types.js'
