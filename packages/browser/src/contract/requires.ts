


import type { CdpExternalBrowserLaunchOptions, CdpExternalBrowserSession } from '../impl/cdp/CdpExternalBrowserLauncher.js'
import type { CdpScreencastConsumerOptions, CdpScreencastStartOptions, ScreencastCapturedFrame } from '../impl/cdp/CdpScreencastRecorder.js'
import type {
  BrowserCaptureScreenshotOptions,
  BrowserClickCoordinatesOptions,
  BrowserClickCoordinatesResult,
  BrowserDragOptions,
  BrowserDragResult,
  BrowserElementQueryOptions,
  BrowserElementQueryResult,
  BrowserEmulationOptions,
  BrowserEmulationResult,
  BrowserEvaluateScriptOptions,
  BrowserEvaluateScriptResult,
  BrowserExportPagePdfOptions,
  BrowserExportPagePdfResult,
  BrowserFetchResourceOptions,
  BrowserFetchResourceResult,
  BrowserHandleDialogOptions,
  BrowserHandleDialogResult,
  BrowserHandleDownloadOptions,
  BrowserHandleDownloadResult,
  BrowserHandlePermissionOptions,
  BrowserHandlePermissionResult,
  BrowserHeapSnapshotOptions,
  BrowserHeapSnapshotResult,
  BrowserInspectPageOptions,
  BrowserListMediaSourcesOptions,
  BrowserListMediaSourcesResult,
  BrowserListPageResourcesOptions,
  BrowserListPageResourcesResult,
  BrowserMoveMouseOptions,
  BrowserMoveMouseResult,
  BrowserNetworkControlOptions,
  BrowserNetworkControlResult,
  BrowserNetworkRequestDetailsOptions,
  BrowserNetworkRequestDetailsResult,
  BrowserNetworkResponseBodyOptions,
  BrowserNetworkResponseBodyResult,
  BrowserPageDiagnostics,
  BrowserPageDiagnosticsOptions,
  BrowserPageInspection,
  BrowserPageNavigationOptions,
  BrowserPageNavigationResult,
  BrowserPageScrollOptions,
  BrowserPageScrollResult,
  BrowserPageStorageOptions,
  BrowserPageStorageResult,
  BrowserPageTargetsResult,
  BrowserPageWaitOptions,
  BrowserPageWaitResult,
  BrowserPageWindowState,
  BrowserPageZoomOptions,
  BrowserPageZoomResult,
  BrowserPendingEventsResult,
  BrowserPerformanceInsightOptions,
  BrowserPerformanceInsightResult,
  BrowserPerformanceTraceStartOptions,
  BrowserPerformanceTraceStartResult,
  BrowserPerformanceTraceStopResult,
  BrowserPressKeyOptions,
  BrowserPressKeyResult,
  BrowserScreencastStartOptions,
  BrowserScreencastStartResult,
  BrowserScreencastStopOptions,
  BrowserScreencastStopResult,
  BrowserScreenshotArtifact,
  BrowserSiteContext,
  BrowserSwitchPageTargetOptions,
  BrowserSwitchPageTargetResult,
  BrowserTargetActionOptions,
  BrowserTargetActionResult,
  BrowserTurnContextSnapshot,
  BrowserTypeTextOptions,
  BrowserTypeTextResult,
  BrowserUploadFileOptions,
  BrowserUploadFileResult,
  BrowserUserScriptManageRequest,
  BrowserUserScriptMutationResult,
  BrowserViewportOptions,
  BrowserViewportResult,
  BrowserWaitForSelectorOptions,
  BrowserWaitForSelectorResult,
  ProjectReadFileResult,
  WorkspaceFileEntry,
  WorkspaceListOptions,
  WorkspaceWriteFileOptions,
  WorkspaceWriteFileResult,
} from '../types/browser'
import type { BrowserLoginDetection, BrowserOriginStorage, BrowserPageDiagnosticEntry, BrowserPageState,BrowserPageTargetInfo } from '../types/browser.js'
import type { BrowserPageDriverClickCoordinatesOptions, BrowserPageDriverCookie, BrowserPageDriverCookieOptions, BrowserPageDriverDiagnosticsOptions, BrowserPageDriverDownloadListener, BrowserPageDriverDragCoordinatesOptions, BrowserPageDriverEmulationState,BrowserPageDriverFetchResourceOptions, BrowserPageDriverFetchResourceResult, BrowserPageDriverFileInputOptions, BrowserPageDriverKind, BrowserPageDriverMoveMouseOptions, BrowserPageDriverNetworkCaptureState, BrowserPageDriverNetworkControlState, BrowserPageDriverNetworkIdleOptions, BrowserPageDriverNetworkRequestDetailsResult, BrowserPageDriverNetworkResponseBodyResult, BrowserPageDriverPdfOptions, BrowserPageDriverScreenshot, BrowserPageDriverScreenshotOptions, BrowserPageDriverState, BrowserPageDriverStorageOriginOptions, BrowserSystemPointerMoveOptions } from '../types/driver.js'

/** 启动/接入外部浏览器并返回 page-level CDP driver 的 host 无关 launcher 面。 */
export interface BrowserExternalPageLauncher {
  launch(options?: CdpExternalBrowserLaunchOptions): Promise<CdpExternalBrowserSession>
}

/**
 * 宿主注入的系统指针能力。
 *
 * 返回 false 表示当前环境、权限或可见性不允许使用系统指针，浏览器运行时随即改画统一兜底箭头。
 */
export interface BrowserSystemPointerDriver {
  move(options: BrowserSystemPointerMoveOptions): Promise<boolean>
}

export interface BrowserPageDriverDownloadItem {
  getFilename(): string
  getMimeType(): string
  getTotalBytes(): number
  getReceivedBytes(): number
  getSavePath(): string
  pause(): void
  cancel(): void
  setSavePath(path: string): void
  resume(): void
  once(event: 'done', listener: (_event: unknown, state: string) => void): unknown
}

export interface BrowserPageDriver {
  kind: BrowserPageDriverKind
  executeJavaScript<T = unknown>(script: string, userGesture?: boolean): Promise<T>
  navigateTo(url: string): Promise<BrowserPageDriverState>
  refreshPageState(): Promise<BrowserPageDriverState>
  bringToFront(): Promise<void>
  captureScreenshot?(
    options: BrowserPageDriverScreenshotOptions
  ): Promise<BrowserPageDriverScreenshot>
  typeText?(options: BrowserTypeTextOptions): Promise<void>
  pressKey?(options: BrowserPressKeyOptions): Promise<void>
  moveMouse?(options: BrowserPageDriverMoveMouseOptions): Promise<void>
  clickCoordinates?(options: BrowserPageDriverClickCoordinatesOptions): Promise<void>
  dragCoordinates?(options: BrowserPageDriverDragCoordinatesOptions): Promise<void>
  setViewport?(options: BrowserViewportOptions): Promise<void>
  setFileInputFiles?(options: BrowserPageDriverFileInputOptions): Promise<boolean>
  printToPdf?(options: BrowserPageDriverPdfOptions): Promise<Buffer>
  fetchResource?(
    options: BrowserPageDriverFetchResourceOptions
  ): Promise<BrowserPageDriverFetchResourceResult>
  getPageZoomFactor?(): number
  setPageZoomFactor?(zoomFactor: number): Promise<void>
  readDiagnostics?(options: BrowserPageDriverDiagnosticsOptions): BrowserPageDiagnosticEntry[]
  /**
   * 确保网络采集已经在跑（读诊断前调用）。
   *
   * 内嵌页面的采集是惰性建立的：不调用就永远读不到网络事件。读诊断时顺手把它建起来，
   * 并如实回报「这次才开始」，回执才能告诉模型之前的请求看不到。
   */
  ensureNetworkCapture?(): Promise<BrowserPageDriverNetworkCaptureState>
  listPageTargets?(): Promise<BrowserPageTargetInfo[]>
  switchPageTarget?(options: BrowserSwitchPageTargetOptions): Promise<BrowserPageDriver>
  onDownload?(listener: BrowserPageDriverDownloadListener): () => void
  grantPermissions?(permissions: string[], origin?: LooseOptional<string>): Promise<void>
  readCookies?(options?: BrowserPageDriverCookieOptions): Promise<BrowserPageDriverCookie[]>
  readStorageOrigins?(
    options: BrowserPageDriverStorageOriginOptions
  ): Promise<BrowserOriginStorage[]>
  configureNetwork?(
    options: BrowserNetworkControlOptions
  ): Promise<BrowserPageDriverNetworkControlState>
  readNetworkResponseBody?(
    options: BrowserNetworkResponseBodyOptions
  ): Promise<BrowserPageDriverNetworkResponseBodyResult>
  readNetworkRequestDetails?(
    options: BrowserNetworkRequestDetailsOptions
  ): Promise<BrowserPageDriverNetworkRequestDetailsResult>
  waitForNetworkIdle?(options: BrowserPageDriverNetworkIdleOptions): Promise<void>
  configureEmulation?(
    options: BrowserEmulationOptions
  ): Promise<BrowserPageDriverEmulationState>
  getEmulationState?(): BrowserPageDriverEmulationState
  /** 开始录制性能 trace（CDP Tracing domain）。 */
  startTracing?(): Promise<void>
  /** 停止录制并返回全部 trace 事件。 */
  stopTracing?(): Promise<unknown[]>
  isTracing?(): boolean
  /** 采集 V8 堆快照，流式写入 sink。 */
  captureHeapSnapshot?(sink: (chunk: string) => void): Promise<{ chunks: number; bytes: number }>
  /** 开始页面录屏（CDP Page.startScreencast）。 */
  startScreencast?(
    options: CdpScreencastStartOptions,
    consumer?: CdpScreencastConsumerOptions
  ): Promise<void>
  /** 停止录屏并取回帧序列。 */
  stopScreencast?(): Promise<{ frames: ScreencastCapturedFrame[]; frameLimitReached: boolean }>
  isScreencasting?(): boolean
  getURL(): string
  getTitle(): string
  isDestroyed(): boolean
  dispose?(): void
}

export interface BrowserLoginGateDecision {
  /** 用户是否表示「已完成登录，继续」。 */
  approved: boolean
  /** 拒绝原因或用户批注；批准时通常为空。 */
  message?: LooseOptional<string>
}

export interface BrowserLoginGatePort {
  /**
   * 阻塞当前工具调用并请用户人工完成登录/验证。
   *
   * 宿主实现应弹出**必须由用户亲自裁决**的确认卡（Desktop 走 ApprovalPort 的手动审批）。
   * 没有审批通道的宿主必须返回 `approved:false`，不能静默放行——那正是本层要补的洞。
   */
  requestLoginCompletion: (input: {
    message: string
    riskScope: string
    origin: string
    detection: BrowserLoginDetection
  }) => Promise<BrowserLoginGateDecision>
}

/**
 * 工具侧看到的浏览器能力(全仓唯一权威定义;app 的 ToolBrowserTypes.ts re-export 本接口)。
 *
 * 工具只依赖这个接口,不直接碰 Electron runtime。它已经绑定了当前 session 和
 * browser site context,因此方法参数里不再重复传 sessionId。
 * 给本接口加必选成员前注意:浏览器 CLI(cli.ts)用 proxy 实现,加必选成员安全;
 * 但保持 host 专属能力 optional(如 getTurnContextSnapshot)。
 */
export interface ToolBrowserApi {
  /** 当前 session 是否已经进入 browser site 模式。 */
  isActive: () => boolean
  /** 读取当前站点上下文。 */
  getContext: () => Nullable<BrowserSiteContext>
  /** 进入某个 URL 对应的 browser 工作区，并准备该站点的私有文件区。 */
  enterSite: (url: string) => Promise<BrowserSiteContext>
  /** 退出 browser site 模式，后续 browser 工具会不可用。 */
  leaveSite: () => Promise<void>
  /** 把受控浏览器页面显示出来。 */
  showPage: () => Promise<BrowserPageWindowState>
  /** 抽取页面结构、可点击元素和基础状态，供模型决定下一步。 */
  inspectPage: (options?: BrowserInspectPageOptions) => Promise<BrowserPageInspection>
  /** 截图并把图片作为工作区产物保存。 */
  captureScreenshot: (
    options?: BrowserCaptureScreenshotOptions
  ) => Promise<BrowserScreenshotArtifact>
  /** 按目标元素描述执行点击等动作，比坐标点击更稳定。 */
  performTargetAction: (options: BrowserTargetActionOptions) => Promise<BrowserTargetActionResult>
  /** 导航到新地址或触发前进/后退/刷新。 */
  navigatePage: (options: BrowserPageNavigationOptions) => Promise<BrowserPageNavigationResult>
  /** 滚动页面，用于长页面探查和定位目标元素。 */
  scrollPage: (options?: BrowserPageScrollOptions) => Promise<BrowserPageScrollResult>
  /** 用选择器/文本条件查询页面元素。 */
  queryElements: (options: BrowserElementQueryOptions) => Promise<BrowserElementQueryResult>
  /** 获取控制台、网络和加载状态等诊断信息。 */
  getPageDiagnostics: (options?: BrowserPageDiagnosticsOptions) => Promise<BrowserPageDiagnostics>
  /** 向当前焦点或目标元素输入文本。 */
  typeText: (options: BrowserTypeTextOptions) => Promise<BrowserTypeTextResult>
  /** 发送键盘按键，如 Enter、Escape、Tab。 */
  pressKey: (options: BrowserPressKeyOptions) => Promise<BrowserPressKeyResult>
  /** 移动鼠标，用于 hover 或人工可视化调试。 */
  moveMouse: (options: BrowserMoveMouseOptions) => Promise<BrowserMoveMouseResult>
  /** 坐标点击，作为目标元素点击失败时的兜底能力。 */
  clickCoordinates: (
    options: BrowserClickCoordinatesOptions
  ) => Promise<BrowserClickCoordinatesResult>
  /** 按两个目标元素拖拽。 */
  dragTargets: (options: BrowserDragOptions) => Promise<BrowserDragResult>
  /** 等待选择器出现/消失，保证后续动作在页面稳定后执行。 */
  waitForSelector: (options: BrowserWaitForSelectorOptions) => Promise<BrowserWaitForSelectorResult>
  /** 等待页面 readyState 或短暂停顿，适合轻量异步渲染稳定。 */
  waitForPage: (options: BrowserPageWaitOptions) => Promise<BrowserPageWaitResult>
  /** 修改受控浏览器 viewport，便于复现移动端或桌面布局。 */
  setViewport: (options: BrowserViewportOptions) => Promise<BrowserViewportResult>
  /** 调整页面缩放比例，便于视觉定位和点击。 */
  setPageZoom: (options: BrowserPageZoomOptions) => Promise<BrowserPageZoomResult>
  /** 配置外部 CDP 浏览器页面网络状态。 */
  configureNetwork: (
    options: BrowserNetworkControlOptions
  ) => Promise<BrowserNetworkControlResult>
  /** 按 browser:list_network_events 返回的 requestId 读取外部 CDP 响应体。 */
  readNetworkResponseBody: (
    options: BrowserNetworkResponseBodyOptions
  ) => Promise<BrowserNetworkResponseBodyResult>
  /** 按 requestId 读取请求、响应、timing 和可选响应体详情。 */
  readNetworkRequestDetails: (
    options: BrowserNetworkRequestDetailsOptions
  ) => Promise<BrowserNetworkRequestDetailsResult>
  /** 配置外部 CDP 浏览器页面环境模拟。 */
  configureEmulation: (
    options: BrowserEmulationOptions
  ) => Promise<BrowserEmulationResult>
  /** 开始录制性能 trace。 */
  startPerformanceTrace: (
    options: BrowserPerformanceTraceStartOptions
  ) => Promise<BrowserPerformanceTraceStartResult>
  /** 停止录制并返回 DevTools trace 引擎分析摘要。 */
  stopPerformanceTrace: () => Promise<BrowserPerformanceTraceStopResult>
  /** 对最近一次 trace 的指定 insight 输出详细分析。 */
  analyzePerformanceInsight: (
    options: BrowserPerformanceInsightOptions
  ) => Promise<BrowserPerformanceInsightResult>
  /** 采集 V8 堆快照并落盘到浏览器工作区。 */
  captureHeapSnapshot: (
    options?: BrowserHeapSnapshotOptions
  ) => Promise<BrowserHeapSnapshotResult>
  /** 开始页面录屏。 */
  startScreencast: (
    options?: BrowserScreencastStartOptions
  ) => Promise<BrowserScreencastStartResult>
  /** 停止录屏并合成 GIF 落盘。 */
  stopScreencast: (
    options?: BrowserScreencastStopOptions
  ) => Promise<BrowserScreencastStopResult>
  /** 列出待处理的 dialog/download/permission 事件。 */
  listPendingEvents: () => Promise<BrowserPendingEventsResult>
  /** 枚举当前受控页面 target。 */
  listPageTargets: () => Promise<BrowserPageTargetsResult>
  /** 切换当前受控的外部 CDP page target。 */
  switchPageTarget: (
    options: BrowserSwitchPageTargetOptions
  ) => Promise<BrowserSwitchPageTargetResult>
  /** 处理 JS 弹窗。 */
  handleDialog: (options: BrowserHandleDialogOptions) => Promise<BrowserHandleDialogResult>
  /** 接受或取消待处理下载。 */
  handleDownload: (options: BrowserHandleDownloadOptions) => Promise<BrowserHandleDownloadResult>
  /** 允许或拒绝权限请求。 */
  handlePermission: (
    options: BrowserHandlePermissionOptions
  ) => Promise<BrowserHandlePermissionResult>
  /** 向 file input 上传文件。 */
  uploadFile: (options: BrowserUploadFileOptions) => Promise<BrowserUploadFileResult>
  /** 用当前会话 cookie 下载远程资源到浏览器工作区。 */
  fetchResource: (options: BrowserFetchResourceOptions) => Promise<BrowserFetchResourceResult>
  /** 枚举当前页面媒体 URL。 */
  listMediaSources: (
    options?: BrowserListMediaSourcesOptions
  ) => Promise<BrowserListMediaSourcesResult>
  /** 枚举页面链接、iframe 与媒体概览。 */
  listPageResources: (
    options?: BrowserListPageResourcesOptions
  ) => Promise<BrowserListPageResourcesResult>
  /** 将当前页面导出为 PDF。 */
  exportPagePdf: (options?: BrowserExportPagePdfOptions) => Promise<BrowserExportPagePdfResult>
  /** 读取 localStorage/sessionStorage/cookie 等页面存储。 */
  readPageStorage: (options?: BrowserPageStorageOptions) => Promise<BrowserPageStorageResult>
  /** 在页面上下文执行受控脚本，适合读取复杂 DOM 状态。 */
  evaluateScript: (options: BrowserEvaluateScriptOptions) => Promise<BrowserEvaluateScriptResult>
  /** 获取当前页轻量状态，通常用于动作后的确认。 */
  getPageState: () => Promise<BrowserPageState>
  /** 每回合浏览器上下文快照：同步读取缓存态，不进动作队列、不做页面往返。 */
  getTurnContextSnapshot?: () => Nullable<BrowserTurnContextSnapshot>
  /** 列出 browser 工作区里的私有文件产物。 */
  listFiles: (options?: WorkspaceListOptions) => Promise<WorkspaceFileEntry[]>
  /** 读取 browser 工作区文件，和普通 workspace 隔离。 */
  readFile: (
    path: string,
    startLine?: number,
    endLine?: number,
    maxChars?: number
  ) => Promise<ProjectReadFileResult>
  /** 写入 browser 工作区文件，常用于保存 recipe、截图说明或抓取结果。 */
  writeFile: (
    path: string,
    content: string,
    options?: WorkspaceWriteFileOptions
  ) => Promise<WorkspaceWriteFileResult>
  /** 管理当前浏览器会话共享的持久用户脚本。 */
  manageUserScripts: (
    request: BrowserUserScriptManageRequest
  ) => Promise<BrowserUserScriptMutationResult>
}

export interface BrowserToolContext {
  abortSignal: AbortSignal
  browser: ToolBrowserApi
}

export type ToolContext = BrowserToolContext

