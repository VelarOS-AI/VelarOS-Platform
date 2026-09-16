import type electron from 'electron'

import type {
  KernelCallableCapabilityService,
} from '@velaros-ai/kernel'

import type { BrowserPageDriver, BrowserSystemPointerDriver } from '../contract/requires.js'
import type { ElectronBrowserRuntime } from '../impl/electron/ElectronBrowserRuntime.js'

import type {
  BrowserNavigationHistoryRestore,
  BrowserPageDiagnosticEntry,
  BrowserUserActivityEvent,
  BrowserUserActivitySummary,
  BrowserViewportOptions,
} from './browser'
import type { BrowserScreenshotCaptureRegion, BrowserSiteContext } from './browser.js'
import type { CdpExternalBrowserLaunchOptions, CdpExternalBrowserSession } from './cdp.js'
import type { BrowserPageDriverKernel,BrowserPageDriverSession } from './runtime.js'

export interface BrowserRuntimeCapabilityService
  extends KernelCallableCapabilityService {
  /**
   * Product-local runtime. Electron WebContents cannot be transferred into a
   * daemon, so in-process consumers receive the injected runtime explicitly.
   */
  readonly runtime: ElectronBrowserRuntime
}

export interface CreateBrowserKernelModuleOptions {
  /** Reuse the product composition root's only Browser runtime instance. */
  readonly runtime: ElectronBrowserRuntime
  /** Injected runtimes remain product-owned unless this is explicitly true. */
  readonly disposeInjectedRuntime?: boolean
}

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

export type WebContentsListener = (...args: any[]) => void;

export interface SharedWebContentsEvent {
  readonly dispatch: WebContentsListener;
  readonly subscribers: Set<WebContentsListener>;
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
  | { kind: 'route'; url: string }
  | { kind: 'bootstrap' }
  | { kind: 'deny'; reason: string }

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

export type BrowserPermissionRequestHandler =
  NonNullable<Parameters<electron.Session['setPermissionRequestHandler']>[0]>

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

export interface BrowserExternalPageLauncher {
  launch(options?: CdpExternalBrowserLaunchOptions): Promise<CdpExternalBrowserSession>
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
  onUserActivity?: (activity: BrowserUserActivityEvent) => void
  resolvePermissionRequest?: (input: BrowserPermissionRequest) => boolean
  resolveUnmanagedPermissionRequest?: (input: BrowserUnmanagedPermissionRequest) => boolean
  registerPermissionRequestHandler?: BrowserPermissionRequestHandlerRegistration
  selectWebAuthnAccount?: (
    input: BrowserWebAuthnAccountSelectionRequest
  ) => Promise<Nullable<string>>
}

export type { BrowserUserActivityEvent, BrowserUserActivitySummary }
