import type {
  BrowserPageDriver,
  BrowserPageDriverKernel,
  BrowserPageDriverSession,
} from '@velaros-ai/browser-core'

import type { BrowserSession } from './BrowserRuntimeTypes'

/**
 * Electron 宿主侧的运行时内核扩展。
 *
 * host 无关的 driver 多态面（会话取用 / 外部会话缓存协作 / 纯工具）住在
 * `@velaros-ai/browser-core`；这里只补 webview / WebContents 专属能力（Electron 输入合成、
 * 注入脚本等 driver 覆盖不了的路径），并把内嵌 `BrowserSession` 挂到页面 driver 会话上。
 */

export type {
  BrowserPageDriverKernel,
  BrowserPageDriverSession,
  ExternalBrowserPageSession,
} from '@velaros-ai/browser-core'
export {
  clampInteger,
  clampNumber,
  clampZoomFactor,
  readBoundedString,
  readFiniteNumber,
  resolveExternalPageUrl,
  resolveWorkspaceFilePath,
} from '@velaros-ai/browser-core'

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
