export { BrowserDiagnosticsRecorder } from './impl/electron/BrowserDiagnosticsRecorder'
export { BrowserPageWaiter } from './impl/electron/BrowserPageWaiter'
export type { BrowserSessionManagerOptions } from './impl/electron/BrowserSessionManager'
export { BrowserSessionManager } from './impl/electron/BrowserSessionManager'
export { ElectronBrowserRuntime } from './impl/electron/ElectronBrowserRuntime'
export {
  createElectronWebContentsBrowserPageDriver,
  ElectronWebContentsBrowserPageDriver,
} from './impl/electron/ElectronWebContentsBrowserPageDriver'
export { BrowserRuntimeCapability, createBrowserKernelModule } from './impl/electron/kernel-module'
export type { BrowserUserActivityEvent, BrowserUserActivitySummary } from './types/browser'
export type {
  BrowserExternalPageLauncher,
  BrowserPermissionRequest,
  BrowserPermissionRequestHandler,
  BrowserPermissionRequestHandlerRegistration,
  BrowserRuntimeKernel,
  BrowserRuntimePageDriverSession,
  BrowserSession,
  BrowserUnmanagedPermissionRequest,
  BrowserWebAuthnAccountSelectionRequest,
  ElectronBrowserRuntimeOptions,
} from './types/electron'
export type { BrowserPageDriverFactory, BrowserPageDriverFactoryInput } from './types/electron.js'
export type { BrowserRuntimeCapabilityService, CreateBrowserKernelModuleOptions } from './types/electron.js'
export type {
  BrowserPageDriverKernel,
  BrowserPageDriverSession,
  ExternalBrowserPageSession,
} from './types/runtime'
export {
  clampInteger,
  clampNumber,
  clampZoomFactor,
  readBoundedString,
  readFiniteNumber,
} from './utils/numbers'
export { resolveExternalPageUrl } from './utils/url'
export { DEFAULT_BROWSER_VIEWPORT } from './utils/viewport'
export { resolveWorkspaceFilePath } from './utils/workspace-paths'
