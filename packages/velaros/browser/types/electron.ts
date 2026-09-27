import type electron from 'electron'

import type {
  BrowserExternalPageLauncher,
  BrowserPageDriver,
  BrowserSystemPointerDriver,
} from '../contract/requires.js'

import type {
  BrowserNavigationHistoryRestore,
  BrowserPageDiagnosticEntry,
  BrowserUserActivityEvent,
  BrowserViewportOptions,
} from './browser'
import type {
  BrowserScreenshotCaptureRegion,
  BrowserScreenshotRect,
  BrowserSiteContext,
} from './browser.js'
import type { BrowserPageDriverKernel, BrowserPageDriverSession } from './runtime.js'
import type { BrowserUserActivitySummary } from './session'

/** 在内嵌页面里求值时的期限参数。 */
export interface BrowserEvaluateDeadlineOptions {
  /** 覆盖默认上限；页内脚本自带更长等待时才需要传。 */
  readonly timeoutMs?: number
  /** 超时正文里的调用名，用来把死结定位到具体路径。 */
  readonly label?: string
}

/** 建一条内嵌页面驱动要的输入。 */
export interface BrowserPageDriverFactoryInput {
  /** 浏览器会话 id。 */
  sessionId: string
  /** 这条会话接管的 WebContents。 */
  webContents: electron.WebContents
}

/** 建内嵌页面驱动的工厂：宿主可以换成自己的实现。 */
export type BrowserPageDriverFactory = (input: BrowserPageDriverFactoryInput) => BrowserPageDriver

export interface BrowserPagePresentationTarget {
  context: BrowserSiteContext
  webContentsId: number
  navigationHistory?: BrowserNavigationHistoryRestore
}

export interface BrowserSessionLookup {
  sessionId: string
  session: BrowserSession
}

export interface BrowserPopupBootstrapLease {
  release: () => void
}

export interface BrowserScreenshotDiffFrame {
  fingerprint: string
  sample: Buffer
}

export interface BrowserScreenshotImageCapture {
  image: Electron.NativeImage
  capture: BrowserScreenshotCaptureRegion
}

/** 截图前从页面量到的尺寸，都是页面 CSS 像素。 */
export interface BrowserScreenshotLayout {
  /** 能截到的整页宽。 */
  documentWidth: number
  /** 能截到的整页高。 */
  documentHeight: number
  /** 一次截图最多截多宽（clip 缩放为 1 时）：视口里看得到的内容那么宽，滚动条不算。 */
  viewWidth: number
  /** 一次截图最多截多高（clip 缩放为 1 时）。 */
  viewHeight: number
}

/** 一块截图区域怎么切：每块的 clip 缩放，与按截取顺序排好的块。 */
export interface BrowserScreenshotTilePlan {
  /** 每块 clip 的 scale：1 是页面本来的清晰度，整张图超出像素上限时小于 1。 */
  clipScale: number
  /** 切好的块（页面 CSS 像素），从上到下、从左到右，互不重叠、合起来正好铺满要截的区域。 */
  tiles: BrowserScreenshotRect[]
}

/** 一块原始位图：每像素四字节，按行紧排，字节顺序与 Electron `toBitmap` 一致。 */
export interface BrowserScreenshotBitmap {
  data: Buffer
  width: number
  height: number
}

/** 一块截图往拼接图里拷的位置：拼接图上的矩形，以及源图相对它的整数偏移。 */
export interface BrowserScreenshotTilePlacement {
  /** 拼接图上的矩形，像素，左上含、右下不含。 */
  target: { left: number; top: number; right: number; bottom: number }
  /** 拼接图的 (x, y) 取源图的 (x + offsetX, y + offsetY)。 */
  offsetX: number
  /** 同上，纵向。 */
  offsetY: number
}

export type WebContentsListener = (...args: any[]) => void

export interface SharedWebContentsEvent {
  readonly dispatch: WebContentsListener
  readonly subscribers: Set<WebContentsListener>
}

export interface BrowserJavaScriptDialogDetails {
  type?: string
  message?: string
  title?: string
  defaultPromptText?: string
}

export interface BrowserDialogEventSource {
  on(
    eventName: 'dialog',
    listener: (
      event: electron.Event,
      details: BrowserJavaScriptDialogDetails,
      callback: (response: boolean, input?: string) => void
    ) => void
  ): void
}

export type BrowserPopupNavigationResolution =
  | { kind: 'route'; url: string; loadOptions?: electron.LoadURLOptions }
  | { kind: 'bootstrap' }
  | { kind: 'deny'; reason: string }

export type BrowserPopupUrlResolution =
  { kind: 'route'; url: string } | { kind: 'bootstrap' } | { kind: 'deny'; reason: string }

/** 统一的页面 driver 会话：webview 与外部 CDP 二选一，driver 面向多态调用。 */
export interface BrowserRuntimePageDriverSession extends BrowserPageDriverSession {
  browserSession?: BrowserSession
}

/**
 * engines 依赖的运行时内核面（Electron 宿主全量）。
 *
 * 约束：只放「取会话、刷状态、跨域协作、共享工具」；领域逻辑一律进各自 engine。
 * 新增成员前先问：这是不是又在把 kernel 养成第二个上帝类。
 */
export interface BrowserRuntimeKernel extends BrowserPageDriverKernel {
  /** 统一多态入口：优先外部 CDP 会话，否则包裹 webview driver。 */
  getLivePageDriverSession(
    sessionId: string,
    abortSignal?: AbortSignal
  ): Promise<BrowserRuntimePageDriverSession>
  /** webview 专属路径（Electron 输入合成、注入脚本等 driver 覆盖不了的能力）。 */
  getLivePageSession(sessionId: string, abortSignal?: AbortSignal): Promise<BrowserSession>
  /** 从 webview 会话解析当前 URL（含占位页处理）。 */
  resolveCurrentPageUrl(session: BrowserSession, fallbackUrl: string): string
  /** 把 webview 会话包成 BrowserPageDriver（多态调用面）。 */
  wrapPageDriver(sessionId: string, session: BrowserSession): BrowserPageDriver
}

/** 单个浏览器会话的主进程状态。 */
export interface BrowserSession {
  /** renderer 提供的 webContents，被 main 接管后用于导航、注入脚本和截图。 */
  webContents: electron.WebContents
  /** 当前页面是否展示在 UI 中。 */
  visible: boolean
  /** 显式 viewport 覆盖；未设置时由可见容器自然决定。 */
  viewport?: LooseOptional<BrowserViewportOptions>
  /** 最近同步到系统上下文的页面 URL。 */
  url: Nullable<string>
  /** 控制台、加载错误、渲染进程异常等诊断记录。 */
  diagnostics: BrowserPageDiagnosticEntry[]
  /** B2: 最近一次导航历史 */
  lastNavigation: LooseOptional<{
    url: string
    type: 'load' | 'redirect' | 'back-forward' | 'unknown'
    errorCode?: number
    errorDescription?: string
    failedAt?: number
  }>
  /** B3: 最近一次导航错误（HTTP 4xx/5xx 或 did-fail-load）*/
  lastNavigationError: LooseOptional<{
    url: string
    errorCode: number
    errorDescription: string
    failedAt: number
  }>
}

/** Electron 浏览器运行时回调。 */
export interface BrowserPermissionRequest {
  sessionId: string
  permission: string
  url: Nullable<string>
  requestingUrl: Nullable<string>
  embeddingOrigin: Nullable<string>
}

export interface BrowserUnmanagedPermissionRequest {
  permission: string
  url: Nullable<string>
  requestingUrl: Nullable<string>
  embeddingOrigin: Nullable<string>
}

export type BrowserPermissionRequestHandler = NonNullable<
  Parameters<electron.Session['setPermissionRequestHandler']>[0]
>

export type BrowserPermissionRequestHandlerRegistration = (
  electronSession: electron.Session,
  handler: BrowserPermissionRequestHandler
) => LooseOptional<() => void>

export interface BrowserWebAuthnAccountSelectionRequest {
  relyingPartyId: string
  accounts: Array<{
    credentialId: string
    displayName?: string
    name?: string
    userHandle?: string
  }>
}

/** 宿主给后台会话开的页面：新开的空白页，运行时接管后加载 url。 */
export interface BrowserBackgroundPage {
  webContents: electron.WebContents
  /** 会话当前站点的地址。 */
  url: string
}

export interface ElectronBrowserRuntimeOptions {
  createPageDriver?: BrowserPageDriverFactory
  externalBrowserLauncher?: LooseOptional<BrowserExternalPageLauncher>
  /** 可见页面优先使用的操作系统原生指针；返回 false 时由浏览器绘制统一兜底箭头。 */
  systemPointerDriver?: LooseOptional<BrowserSystemPointerDriver>
  onSessionSiteChange?: (
    sessionId: string,
    url: string,
    navigationHistory?: LooseOptional<BrowserNavigationHistoryRestore>
  ) => void
  onSessionPageReady?: (sessionId: string, url: string) => void
  onSessionViewportChange?: (sessionId: string, viewport: BrowserViewportOptions) => void
  onSessionClosed?: (sessionId: string) => void
  /**
   * 有操作要页面、界面却没挂 webview（比如用户切到了别的对话）时，宿主给这个会话开一个后台页面：交回一个
   * 新开的空白 WebContents（与界面 webview 同样的分区与沙箱）和会话当前站点的地址。运行时不经动作队列直接接管、
   * 标成不可见，加载完这个地址再交给在等的操作；界面之后挂上 webview 会整个换掉它，开的页面由宿主自己关。
   * 不实现或交回 null，就照旧等界面挂载，超时报 browser-view-not-attached。
   */
  provideBackgroundPage?: (sessionId: string) => Promise<Nullable<BrowserBackgroundPage>>
  onUserActivity?: (activity: BrowserUserActivityEvent) => void
  resolvePermissionRequest?: (input: BrowserPermissionRequest) => boolean
  resolveUnmanagedPermissionRequest?: (input: BrowserUnmanagedPermissionRequest) => boolean
  registerPermissionRequestHandler?: BrowserPermissionRequestHandlerRegistration
  selectWebAuthnAccount?: (
    input: BrowserWebAuthnAccountSelectionRequest
  ) => Promise<Nullable<string>>
}

export type { BrowserUserActivityEvent, BrowserUserActivitySummary }
