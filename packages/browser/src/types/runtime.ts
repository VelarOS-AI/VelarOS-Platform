/** 外部浏览器页面会话；通过 CDP driver 接入，不依赖任何 host 的内嵌 WebContents。 */
import type { BrowserPageDriver } from '../contract/requires.js'

import type { BrowserViewportOptions } from './browser.js'
import type { BrowserPageDriverState } from './driver.js'

export interface ExternalBrowserPageSession {
  driver: BrowserPageDriver
  visible: boolean
  viewport?: LooseOptional<BrowserViewportOptions>
  url: Nullable<string>
  title: Nullable<string>
  disposeHost?: LooseOptional<() => void>
  unsubscribeDownloads?: LooseOptional<() => void>
}

/** host 无关的页面 driver 会话视图：只暴露 driver 与外部 CDP 会话。 */
export interface BrowserPageDriverSession {
  driver: BrowserPageDriver
  externalSession?: ExternalBrowserPageSession
}

/**
 * engine 依赖的 driver 多态内核面（host 无关）。
 *
 * 约束：只放「取 driver 会话、刷状态、外部会话缓存协作」；任何 webview / WebContents
 * 专属能力都不属于这里——它们在宿主侧的 kernel 扩展里，core 不感知。
 */
export interface BrowserPageDriverKernel {
  /** 统一多态入口：优先外部 CDP 会话，否则由宿主包裹其内嵌 driver。 */
  getLivePageDriverSession(
    sessionId: string,
    abortSignal?: AbortSignal
  ): Promise<BrowserPageDriverSession>
  /** 外部 CDP 会话直查；能走 driver 多态就别用这个（boundary 守卫盯着扩散）。 */
  getExternalPageSession(sessionId: string): Nullable<ExternalBrowserPageSession>
  /** 读取页面 driver 会话的最新 url/title。 */
  refreshPageDriverSessionState(
    sessionId: string,
    pageSession: BrowserPageDriverSession,
    fallbackUrl: string
  ): Promise<BrowserPageDriverState>
  /** 刷新外部 CDP 会话的 url/title 缓存。 */
  refreshExternalPageState(
    sessionId: string,
    session: ExternalBrowserPageSession,
    fallbackUrl: string
  ): Promise<BrowserPageDriverState>
  /** 用页面检查结果回填外部会话缓存态。 */
  updateExternalPageStateFromInspection(
    sessionId: string,
    session: ExternalBrowserPageSession,
    inspection: unknown
  ): void
  /** 用页面脚本返回值回填外部会话缓存态。 */
  syncExternalPageStateFromScriptResult(
    sessionId: string,
    session: ExternalBrowserPageSession,
    result: unknown,
    fallbackUrl: string
  ): void
  /** 页面 URL 变化后同步 session 站点上下文。 */
  syncSessionSiteContext(sessionId: string, url: string): void
  /** 可测的延时（TimerScope 包装）。 */
  delay(ms: number): Promise<void>
}
