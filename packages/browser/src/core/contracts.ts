/**
 * Browser-safe contracts and deterministic policies.
 *
 * This entry deliberately excludes CDP transports, launchers, filesystem
 * access, and host runtime implementations. Browser, renderer, worker, RPC,
 * and test consumers can import it without pulling Node.js built-ins.
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
export {
  BrowserScreenshotDefaultDomStable,
  BrowserScreenshotDefaultModelImage,
  BrowserScreenshotDefaultNetworkIdleMs,
  type BrowserScreenshotPolicyDefaults,
  type BrowserScreenshotPolicyOptions,
  buildBrowserScreenshotOptions,
} from './BrowserScreenshotPolicy.js'
export type * from './types.js'
