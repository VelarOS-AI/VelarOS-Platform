/**
 * 浏览器根入口（`@velaros-ai/velar/browser`），给 Node 宿主：代码面 `velar:browser` 与 `velar:devtools` 的操作、
 * 站点工作区的文件访问、用户脚本存储、登录墙门控与动作策略，产品面与注入面的接口，以及它们签名里用到的数据。
 * 类与工具函数一律不出单元。另三个入口：`./browser/contracts`（可移植数据，任何进程）、`./browser/renderer`（渲染进程要的值）、
 * `./browser/electron`（要 electron peer 的运行时）；`./browser/renderer` 与 `./browser/electron` 里每个公开接口的**类型**在这里也叫得出来。
 */

// ── 子集入口：常量表与可移植数据 ────────────────────────────────
export * from './contracts.js'

// ── 产品面：类上方的 API 接口 ───────────────────────────────────
export type {
  BrowserActionPolicyApi,
  BrowserAddressApi,
  BrowserCompositionApi,
  BrowserLoginGateApi,
  BrowserOperationsApi,
  BrowserPreferencesApi,
  BrowserScreenshotPolicyApi,
  BrowserUserScriptManagerApi,
  BrowserWorkspaceFileAccessApi,
  DevtoolsOperationsApi,
  ElectronBrowserRuntimeApi,
} from './contract/provides.js'

// ── 注入面：空间与宿主要塞进来的东西 ────────────────────────────
export type {
  BrowserCompositionAdapter,
  BrowserExternalPageLauncher,
  BrowserLoginGateDecision,
  BrowserLoginGatePort,
  BrowserOperationContext,
  BrowserPageDriver,
  BrowserPageDriverDownloadItem,
  BrowserRuntimeCapabilityService,
  BrowserSpacePort,
  BrowserSystemPointerDriver,
  ControlledBrowserSurface,
  ControlledBrowserSurfaceRenderOptions,
  CreateBrowserKernelModuleOptions,
} from './contract/requires.js'

// ── 数据：公开签名用到、又不在可移植文件里的类型 ─────────────────
export type {
  CdpExternalBrowserLaunchOptions,
  CdpExternalBrowserSession,
  CdpScreencastConsumerOptions,
  CdpScreencastStartOptions,
  ScreencastCapturedFrame,
} from './types/cdp.js'
export type {
  BrowserPageDriverClickCoordinatesOptions,
  BrowserPageDriverCookie,
  BrowserPageDriverCookieOptions,
  BrowserPageDriverDiagnosticsOptions,
  BrowserPageDriverDownloadEvent,
  BrowserPageDriverDownloadListener,
  BrowserPageDriverDragCoordinatesOptions,
  BrowserPageDriverEmulationState,
  BrowserPageDriverFetchResourceOptions,
  BrowserPageDriverFetchResourceResult,
  BrowserPageDriverFileInputOptions,
  BrowserPageDriverKind,
  BrowserPageDriverMoveMouseOptions,
  BrowserPageDriverNetworkCaptureState,
  BrowserPageDriverNetworkControlState,
  BrowserPageDriverNetworkIdleOptions,
  BrowserPageDriverNetworkRequestDetailsResult,
  BrowserPageDriverNetworkResponseBodyResult,
  BrowserPageDriverPdfOptions,
  BrowserPageDriverPointerEvent,
  BrowserPageDriverPointerListener,
  BrowserPageDriverScreenshot,
  BrowserPageDriverScreenshotOptions,
  BrowserPageDriverState,
  BrowserPageDriverStorageOriginOptions,
  BrowserSystemPointerMoveOptions,
} from './types/driver.js'
export type {
  BrowserPageDriverFactory,
  BrowserPageDriverFactoryInput,
  BrowserPermissionRequest,
  BrowserPermissionRequestHandler,
  BrowserPermissionRequestHandlerRegistration,
  BrowserUnmanagedPermissionRequest,
  BrowserWebAuthnAccountSelectionRequest,
  ElectronBrowserRuntimeOptions,
} from './types/electron.js'
export type { BrowserLoginGateOriginState } from './types/operations.js'
export type { BrowserTurnContextDeltaSource, ExternalBrowserPageSession } from './types/runtime.js'
export type { BrowserUserActivityWaitState } from './types/session.js'
export type { BrowserUserScriptAccess } from './types/workspace.js'

// ── 值：两件能力的操作、站点工作区的工厂与策略实例 ──────────────────
export { browserOperations } from './impl/BrowserOperations.js'
export { devtoolsOperations } from './impl/DevtoolsOperations.js'
export { browserActionPolicy } from './impl/policies/BrowserActionPolicy.js'
export { createBrowserLoginGate } from './impl/workspace/BrowserLoginGate.js'
export { createBrowserUserScriptStore } from './impl/workspace/BrowserUserScriptManager.js'
export {
  createBrowserSiteWorkspaceFileAccess,
  createBrowserWorkspaceFileAccess,
} from './impl/workspace/BrowserWorkspaceFileAccess.js'
