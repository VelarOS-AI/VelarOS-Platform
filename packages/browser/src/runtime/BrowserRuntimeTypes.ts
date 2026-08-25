import type electron from 'electron'

import type {
  CdpExternalBrowserLaunchOptions,
  CdpExternalBrowserSession,
} from '../core'
import type { BrowserSystemPointerDriver } from '../core'
import type { BrowserNavigationHistoryRestore, BrowserPageDiagnosticEntry, BrowserUserActivityEvent, BrowserUserActivitySummary, BrowserViewportOptions } from '../core'
import { DEFAULT_BROWSER_VIEWPORT } from '../core'

import type { BrowserPageDriverFactory } from './ElectronWebContentsBrowserPageDriver'

export { DEFAULT_BROWSER_VIEWPORT }

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
  backgroundBrowserLauncher?: LooseOptional<BrowserExternalPageLauncher>
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
