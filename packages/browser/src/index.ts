/**
 * `@velaros-ai/browser` 根入口，给 Node 宿主（两个产品的主进程与测试）。
 *
 * 只写转发语句。四个入口：这里、`./contracts`（可移植数据，任何进程）、
 * `./renderer`（渲染进程要的值）、`./electron`（要 electron peer 的运行时）。
 * 类与工具函数一律不出包：要它们的能力走下面的工厂与实例的方法面；
 * `./renderer` 与 `./electron` 里每个公开接口的**类型**在这里也叫得出来。
 */

// ── 合同：常量表与可移植数据（与 ./contracts 同一份） ──────────────────────
export * from './contracts'

// ── 产品面：类上方接口（contract/provides.ts 登记） ───────────────────────────
export type {
  BrowserAddressApi,
  BrowserCompositionApi,
  BrowserLoginGateApi,
  BrowserPreferencesApi,
  BrowserRecipesApi,
  BrowserScreenshotPolicyApi,
  BrowserToolCollection,
  BrowserUserScriptManagerApi,
  BrowserWorkspaceArtifactManagerApi,
  BrowserWorkspaceFileAccessApi,
  ElectronBrowserRuntimeApi,
  VelaTool,
  VelaToolSurface,
} from './contract/provides'
export type { BrowserActionPolicyApi } from './impl/policies/BrowserActionPolicy'
export type {
  BrowserBundledModDefinition,
  BrowserBundledModOptions,
  BrowserLoginGateOriginState,
} from './types/tools'

// ── 注入面：宿主要塞进来的东西 ────────────────────────────────────────────
export type {
  BrowserCompositionAdapter,
  BrowserExternalPageLauncher,
  BrowserLoginGateDecision,
  BrowserLoginGatePort,
  BrowserPageDriver,
  BrowserPageDriverDownloadItem,
  BrowserRuntimeCapabilityService,
  BrowserSystemPointerDriver,
  BrowserToolContext,
  ControlledBrowserSurface,
  ControlledBrowserSurfaceRenderOptions,
  CreateBrowserKernelModuleOptions,
  ToolBrowserApi,
  ToolContext,
} from './contract/requires'

// ── 数据：公开签名用到、又不在可移植文件里的类型 ─────────────────────────
export type {
  CdpExternalBrowserLaunchOptions,
  CdpExternalBrowserSession,
  CdpScreencastConsumerOptions,
  CdpScreencastStartOptions,
  ScreencastCapturedFrame,
} from './types/cdp'
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
} from './types/driver'
export type {
  BrowserPageDriverFactory,
  BrowserPageDriverFactoryInput,
  BrowserPermissionRequest,
  BrowserPermissionRequestHandler,
  BrowserPermissionRequestHandlerRegistration,
  BrowserUnmanagedPermissionRequest,
  BrowserWebAuthnAccountSelectionRequest,
  ElectronBrowserRuntimeOptions,
} from './types/electron'
export type { BrowserRecipeTemplate } from './types/recipes'
export type {
  BrowserTurnContextDeltaSource,
  ExternalBrowserPageSession,
} from './types/runtime'
export type { BrowserUserActivityWaitState } from './types/session'
export type {
  BrowserUserScriptAccess,
  BrowserWorkspaceArtifactAccess,
  SaveBrowserPageSnapshotInput,
  SaveBrowserRecipeSkeletonInput,
  WriteBrowserArtifactInput,
} from './types/workspace'

// ── 出包的值：工具集合、工厂与实例 ────────────────────────────────────────
export { browserTools, createBrowserBundledModDefinition } from './impl/BrowserTools'
export { browserRecipes } from './impl/operations/BrowserRecipes'
export { browserActionPolicy } from './impl/policies/BrowserActionPolicy'
export { createBrowserLoginGate } from './impl/workspace/BrowserLoginGate'
export { createBrowserUserScriptStore } from './impl/workspace/BrowserUserScriptManager'
export { createBrowserWorkspaceArtifacts } from './impl/workspace/BrowserWorkspaceArtifactManager'
export {
  createBrowserSiteWorkspaceFileAccess,
  createBrowserWorkspaceFileAccess,
} from './impl/workspace/BrowserWorkspaceFileAccess'
