/**
 * 注入面：空间与宿主必须或可以塞进来的东西，每个注入点一个接口。本单元只从这些口子接收外部能力，别处不留钩子。
 *
 * - 调用上下文 `BrowserOperationContext`：必须。空间每次分发 `velar:browser`、`velar:devtools` 的调用时给，
 *   里面是已经绑好会话与站点的空间端口 `BrowserSpacePort` 与交图通道。
 * - 页面驱动 `BrowserPageDriver`、外部浏览器启动器 `BrowserExternalPageLauncher`、系统指针 `BrowserSystemPointerDriver`：可选，
 *   创建运行时时给，接别的浏览器后端、远程浏览器与真实鼠标。
 * - 登录墙的人工确认口 `BrowserLoginGatePort`：用登录墙门控的宿主给。
 * - React 合成 `BrowserCompositionAdapter`：用 React 合成的宿主在渲染进程给。
 * - 挂进内核 `CreateBrowserKernelModuleOptions`：宿主要把运行时挂进内核时给。
 *
 * 这里的每个接口都必须从根入口导出。
 */

import type { ReactNode } from 'react'

import type { KernelCallableCapabilityService } from '@velaros-ai/kernel'
import type { ImageAttachment } from '@velaros-ai/velar/images'

import type { ElectronBrowserRuntimeApi } from '../impl/electron/ElectronBrowserRuntime.js'
import type { BrowserElementSelection, ControlledBrowserSurfaceInput } from '../types/browser'
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
  BrowserMoveMouseOptions,
  BrowserMoveMouseResult,
  BrowserNetworkControlOptions,
  BrowserNetworkControlResult,
  BrowserNetworkRequestDetailsOptions,
  BrowserNetworkRequestDetailsResult,
  BrowserNetworkResponseBodyOptions,
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
} from '../types/browser'
import type { BrowserLoginDetection, BrowserOriginStorage, BrowserPageDiagnosticEntry, BrowserPageState,BrowserPageTargetInfo } from '../types/browser.js'
import type { CdpExternalBrowserLaunchOptions, CdpExternalBrowserSession, CdpScreencastConsumerOptions, CdpScreencastStartOptions, ScreencastCapturedFrame } from '../types/cdp.js'
import type { BrowserPageDriverClickCoordinatesOptions, BrowserPageDriverCookie, BrowserPageDriverCookieOptions, BrowserPageDriverDiagnosticsOptions, BrowserPageDriverDownloadListener, BrowserPageDriverDragCoordinatesOptions, BrowserPageDriverEmulationState,BrowserPageDriverFetchResourceOptions, BrowserPageDriverFetchResourceResult, BrowserPageDriverFileInputOptions, BrowserPageDriverKind, BrowserPageDriverMoveMouseOptions, BrowserPageDriverNetworkCaptureState, BrowserPageDriverNetworkControlState, BrowserPageDriverNetworkIdleOptions, BrowserPageDriverNetworkRequestDetailsResult, BrowserPageDriverNetworkResponseBodyResult, BrowserPageDriverPdfOptions, BrowserPageDriverScreenshot, BrowserPageDriverScreenshotOptions, BrowserPageDriverState, BrowserPageDriverStorageOriginOptions, BrowserSystemPointerMoveOptions } from '../types/driver.js'

/** 启动/接入外部浏览器并返回 page-level CDP driver 的 host 无关 launcher 面。 */
/**
 * 外部浏览器启动器：**接远程浏览器或容器的扩展点**。
 *
 * 谁给、什么时候：不给就用内置的本机 Chrome 启动器；要接别处的浏览器时由宿主创建运行时时传进来。
 */
export interface BrowserExternalPageLauncher {
  /** 拉起（或接上）一个外部浏览器，回一个可用的 page 级 CDP 会话。 */
  launch(options?: CdpExternalBrowserLaunchOptions): Promise<CdpExternalBrowserSession>
}

/**
 * 宿主注入的系统指针能力。
 *
 * 返回 false 表示当前环境、权限或可见性不允许使用系统指针，浏览器运行时随即改画统一兜底箭头。
 */
/**
 * 系统级指针：**接真实鼠标的扩展点**。
 *
 * 谁给、什么时候：不给就用页面内画的兜底指针；要让用户看到真的鼠标在动时由宿主传进来。
 */
export interface BrowserSystemPointerDriver {
  /** 把系统指针移到某个屏幕坐标；做不到时返回 false，调用方退回页面内指针。 */
  move(options: BrowserSystemPointerMoveOptions): Promise<boolean>
}

/**
 * 一次下载：**驱动交给宿主处置的句柄**，形状照 Electron 的 DownloadItem，好让两条路共用同一段处理逻辑。
 *
 * 谁给、什么时候：由页面驱动在下载事件里给；宿主只读它、决定存哪或取消。
 */
export interface BrowserPageDriverDownloadItem {
  /** 服务端给的文件名。 */
  getFilename(): string
  /** 服务端给的 MIME 类型。 */
  getMimeType(): string
  /** 总字节数；服务端没给就是 0。 */
  getTotalBytes(): number
  /** 已经收到多少字节。 */
  getReceivedBytes(): number
  /** 当前的落盘路径。 */
  getSavePath(): string
  /** 暂停下载。 */
  pause(): void
  /** 取消下载。 */
  cancel(): void
  /** 指定落盘路径；必须在开始写之前定。 */
  setSavePath(path: string): void
  /** 继续下载。 */
  resume(): void
  /** 订阅一次结束事件（完成、取消或失败）。 */
  once(event: 'done', listener: (_event: unknown, state: string) => void): unknown
}

/**
 * 页面驱动：**接新浏览器后端的扩展点**。
 *
 * 谁给、什么时候：不给也能跑——内嵌页面与外部 CDP 浏览器各有一份内置实现；要接别的后端（远程浏览器、
 * 容器里的 Chrome）时由宿主经 `ElectronBrowserRuntimeOptions.createPageDriver` 传进来。
 * 可选成员表示「这个后端做不到」：调用方必须先判存在，做不到就如实回报不支持，不许伪造结果。
 */
export interface BrowserPageDriver {
  /** 这条驱动接的是内嵌页面还是外部浏览器。 */
  kind: BrowserPageDriverKind
  /** 在页面上下文里跑一段脚本并取回结果；`userGesture` 让带用户手势门槛的 API 也能用。 */
  executeJavaScript<T = unknown>(script: string, userGesture?: boolean): Promise<T>
  /** 导航到一个地址，回新的页面状态。 */
  navigateTo(url: string): Promise<BrowserPageDriverState>
  /** 重新读一次当前页面的 URL 与标题。 */
  refreshPageState(): Promise<BrowserPageDriverState>
  /** 把这一页提到最前面（外部浏览器里就是切到它那个标签页）。 */
  bringToFront(): Promise<void>
  /** 截一张图；不支持的驱动可以不实现。 */
  captureScreenshot?(
    options: BrowserPageDriverScreenshotOptions
  ): Promise<BrowserPageDriverScreenshot>
  /** 往当前焦点或指定目标输入文本。 */
  typeText?(options: BrowserTypeTextOptions): Promise<void>
  /** 发一次键盘按键。 */
  pressKey?(options: BrowserPressKeyOptions): Promise<void>
  /** 把鼠标移到某个坐标（用于 hover）。 */
  moveMouse?(options: BrowserPageDriverMoveMouseOptions): Promise<void>
  /** 在某个坐标点一下。 */
  clickCoordinates?(options: BrowserPageDriverClickCoordinatesOptions): Promise<void>
  /** 按一条坐标路径拖拽。 */
  dragCoordinates?(options: BrowserPageDriverDragCoordinatesOptions): Promise<void>
  /** 改受控页面的视口尺寸与设备像素比。 */
  setViewport?(options: BrowserViewportOptions): Promise<void>
  /** 给 file input 塞文件；找不到目标时返回 false。 */
  setFileInputFiles?(options: BrowserPageDriverFileInputOptions): Promise<boolean>
  /** 把当前页面打印成 PDF 字节。 */
  printToPdf?(options: BrowserPageDriverPdfOptions): Promise<Buffer>
  /** 带页面会话的 cookie 去取一个远程资源。 */
  fetchResource?(
    options: BrowserPageDriverFetchResourceOptions
  ): Promise<BrowserPageDriverFetchResourceResult>
  /** 读当前页面缩放系数。 */
  getPageZoomFactor?(): number
  /** 设置页面缩放系数。 */
  setPageZoomFactor?(zoomFactor: number): Promise<void>
  /** 同步读页面诊断缓冲（console、加载错误、网络事件）。 */
  readDiagnostics?(options: BrowserPageDriverDiagnosticsOptions): BrowserPageDiagnosticEntry[]
  /**
   * 确保网络采集已经在跑（读诊断前调用）。
   *
   * 内嵌页面的采集是惰性建立的：不调用就永远读不到网络事件。读诊断时顺手把它建起来，
   * 并如实回报「这次才开始」，回执才能告诉模型之前的请求看不到。
   */
  ensureNetworkCapture?(): Promise<BrowserPageDriverNetworkCaptureState>
  /** 列出这个浏览器里的页面（内嵌页面只有当前这一页）。 */
  listPageTargets?(): Promise<BrowserPageTargetInfo[]>
  /** 切到另一页，返回那一页的驱动。 */
  switchPageTarget?(options: BrowserSwitchPageTargetOptions): Promise<BrowserPageDriver>
  /** 订阅下载事件；返回取消订阅的函数。 */
  onDownload?(listener: BrowserPageDriverDownloadListener): () => void
  /** 预先授予一组权限，省掉页面弹权限框。 */
  grantPermissions?(permissions: string[], origin?: LooseOptional<string>): Promise<void>
  /** 读 cookie。 */
  readCookies?(options?: BrowserPageDriverCookieOptions): Promise<BrowserPageDriverCookie[]>
  /** 按来源读 localStorage / sessionStorage。 */
  readStorageOrigins?(
    options: BrowserPageDriverStorageOriginOptions
  ): Promise<BrowserOriginStorage[]>
  /** 配置页面网络：离线、请求头、拦截与 mock。 */
  configureNetwork?(
    options: BrowserNetworkControlOptions
  ): Promise<BrowserPageDriverNetworkControlState>
  /** 按 requestId 读响应体。 */
  readNetworkResponseBody?(
    options: BrowserNetworkResponseBodyOptions
  ): Promise<BrowserPageDriverNetworkResponseBodyResult>
  /** 按 requestId 读请求、响应与 timing 详情。 */
  readNetworkRequestDetails?(
    options: BrowserNetworkRequestDetailsOptions
  ): Promise<BrowserPageDriverNetworkRequestDetailsResult>
  /** 等页面网络空闲。 */
  waitForNetworkIdle?(options: BrowserPageDriverNetworkIdleOptions): Promise<void>
  /** 配置环境模拟：色彩方案、时区、地理位置、CPU 与网络节流。 */
  configureEmulation?(
    options: BrowserEmulationOptions
  ): Promise<BrowserPageDriverEmulationState>
  /** 读当前生效的环境模拟状态。 */
  getEmulationState?(): BrowserPageDriverEmulationState
  /** 开始录制性能 trace（CDP Tracing domain）。 */
  startTracing?(): Promise<void>
  /** 停止录制并返回全部 trace 事件。 */
  stopTracing?(): Promise<unknown[]>
  /** 现在是不是正在录 trace。 */
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
  /** 现在是不是正在录屏。 */
  isScreencasting?(): boolean
  /** 读当前 URL（同步，取缓存态）。 */
  getURL(): string
  /** 读当前标题（同步，取缓存态）。 */
  getTitle(): string
  /** 这一页是不是已经销毁了。 */
  isDestroyed(): boolean
  /** 拆掉这条驱动占用的资源（debugger、监听器、临时目录）。 */
  dispose?(): void
}

/** 用户对一次登录墙征询的裁决。 */
export interface BrowserLoginGateDecision {
  /** 用户是否表示「已完成登录，继续」。 */
  approved: boolean
  /** 拒绝原因或用户批注；批准时通常为空。 */
  message?: LooseOptional<string>
}

/**
 * 登录墙的人工确认口。
 *
 * 谁给、什么时候：用登录墙门控的宿主在装配工具端口时给（Desktop 走 ApprovalPort 的手动审批）。
 * 没有审批通道的宿主必须返回 `approved: false`，不能静默放行。
 */
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
 * 空间端口：`velar:browser` 与 `velar:devtools` 的操作在运行时能向空间要什么，写作 `ctx.browser`。全仓唯一权威。
 *
 * 已经绑定了当前会话与站点，所以方法参数里不带 sessionId。扁平一层，只放操作真会调的方法——门禁按两个操作文件逐方法核对。
 * 宿主拿 `./browser/electron` 的运行时拼它；要登录墙门控时用 `createBrowserLoginGate(port).wrap(api)` 包一层再交进来。
 */
export interface BrowserSpacePort {
  /** 当前会话是不是已经进了站点（open 过、没 leave）。 */
  isActive: () => boolean
  /** 读取当前站点上下文。 */
  getContext: () => Nullable<BrowserSiteContext>
  /** 打开这个网址并把会话绑到它的站点，准备好这个站点的工作区。 */
  enterSite: (url: string) => Promise<BrowserSiteContext>
  /** 退出站点：之后要页面的操作都会先要求 open。 */
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
  /** 将当前页面导出为 PDF。 */
  exportPagePdf: (options?: BrowserExportPagePdfOptions) => Promise<BrowserExportPagePdfResult>
  /** 读取 localStorage/sessionStorage/cookie 等页面存储。 */
  readPageStorage: (options?: BrowserPageStorageOptions) => Promise<BrowserPageStorageResult>
  /** 在页面上下文执行受控脚本，适合读取复杂 DOM 状态。 */
  evaluateScript: (options: BrowserEvaluateScriptOptions) => Promise<BrowserEvaluateScriptResult>
  /** 获取当前页轻量状态，通常用于动作后的确认。 */
  getPageState: () => Promise<BrowserPageState>
  /** 管理当前浏览器会话共享的持久用户脚本。 */
  manageUserScripts: (
    request: BrowserUserScriptManageRequest
  ) => Promise<BrowserUserScriptMutationResult>
}

/** 每次调用拿到的上下文：取消信号、空间端口与交图通道。 */
export interface BrowserOperationContext {
  /** 本次调用的取消信号：用户中止时要尽快停下并如实回报已经做了什么。 */
  abortSignal: AbortSignal
  /** 空间端口：已经绑好当前会话与站点的浏览器能力，写作 `ctx.browser`。 */
  browser: BrowserSpacePort
  /** 把一张图交给模型看（screenshot 用它）；宿主收着，在这次结果后面按顺序放出来。不给时截图照样落盘，只是模型看不到图。 */
  attachImage?: (image: ImageAttachment) => void
}


/**
 * React 合成适配器：宿主用它把「受控浏览器页面」交给产品树。
 *
 * 谁给、什么时候：用 React 合成的宿主在渲染进程装 Provider 时给；不用 React 的宿主可以不给。
 */
export interface BrowserCompositionAdapter {
  /** Provider 安装后必须保持实现引用稳定，保证 hook 拓扑固定。 */
  useControlledSurface: (input: ControlledBrowserSurfaceInput) => ControlledBrowserSurface
}

/** 渲染受控页面时的语义回调。 */
export interface ControlledBrowserSurfaceRenderOptions {
  /** 用户在页面上挑中一个元素。 */
  onElementPicked: (selection: BrowserElementSelection) => void
  /** 用户要求关掉这个受控页面。 */
  onRequestClose: () => void
}

/** 宿主交回来的受控浏览器页面。 */
export interface ControlledBrowserSurface {
  /** 浏览器会话 id。 */
  readonly sessionId: string
  /** 页面是不是活的。 */
  readonly active: boolean
  /** 激活令牌；未激活时是 null。 */
  readonly activationToken: Nullable<string>
  /** 页面当前的地址与标题。 */
  readonly page: {
    /** 当前 URL；还没导航时是 null。 */
    readonly url: Nullable<string>
    /** 当前标题。 */
    readonly title: string
  }
  /**
   * 宿主拥有具体 Browser stage；产品只请求渲染并提供语义回调。
   * 返回节点不得要求消费方理解 Electron、WebView 或宿主 controller。
   */
  readonly render: (options: ControlledBrowserSurfaceRenderOptions) => ReactNode
}

/**
 * 浏览器运行时在内核里的服务形状：可调用能力，外加进程内消费方直接拿到的那份运行时。
 *
 * Electron 的 WebContents 递不进守护进程，所以「整件运行时」只在进程内经这一格交出去，
 * 跨进程只走 `close_session` / `close_all_sessions` 两个可调用操作。
 */
export interface BrowserRuntimeCapabilityService extends KernelCallableCapabilityService {
  /** 产品持有的那一份 Electron 浏览器运行时。 */
  readonly runtime: ElectronBrowserRuntimeApi
}

/** 把浏览器运行时挂进内核时宿主要给的东西。 */
export interface CreateBrowserKernelModuleOptions {
  /** 复用产品组合根里唯一那份浏览器运行时。 */
  readonly runtime: ElectronBrowserRuntimeApi
  /** 注入进来的运行时缺省归产品所有；显式为真时才由内核模块在卸载时释放它。 */
  readonly disposeInjectedRuntime?: boolean
}
