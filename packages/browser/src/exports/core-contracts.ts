/**
 * 可在浏览器中安全使用的契约与确定性策略。
 *
 * 本入口刻意排除 `CDP` 传输、启动器、文件系统访问与宿主运行时实现。浏览器、渲染器、工作线程、
 * 远程调用和测试消费者可直接导入，不会引入 `Node.js` 内置模块。
 */
export { BrowserModId, BrowserSpaceId } from '../contract/constants.js'
export type * from '../types/browser.js'
export {
  getBrowserSiteHost,
  getBrowserUrlCandidate,
  isLocalBrowserUrl,
  resolveBrowserNavigationInput,
  resolveBrowserSearchFallbackUrl,
  resolveBrowserSearchOrNavigationInput,
} from '../utils/address.js'
export {
  BrowserViewNotAttachedReason,
  isBrowserViewNotAttachedError,
} from '../utils/errors.js'
export {
  BrowserFallbackVirtualPointer,
  buildBrowserFallbackVirtualPointerSvg,
} from '../utils/pointer.js'
export {
  BrowserAutomationModes,
  BrowserSearchEngineIds,
  DefaultBrowserAutomationMode,
  DefaultBrowserSearchEngine,
  isBrowserAutomationMode,
  isBrowserSearchEngineId,
  resolveBrowserAutomationMode,
  resolveBrowserSearchEngineId,
} from '../utils/preferences.js'
export {
  BrowserScreenshotDefaultDomStable,
  BrowserScreenshotDefaultModelImage,
  BrowserScreenshotDefaultNetworkIdleMs,
  type BrowserScreenshotPolicyDefaults,
  type BrowserScreenshotPolicyOptions,
  buildBrowserScreenshotOptions,
} from '../utils/screenshot-options.js'
