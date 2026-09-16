/** 外部浏览器页面会话；通过 CDP driver 接入，不依赖任何 host 的内嵌 WebContents。 */
import type { DevtoolsParsedTrace } from '../../vendor/devtools-performance-engine/devtoolsPerformanceEngine.mjs'
import type { BrowserPageDriver } from '../contract/requires.js'

import type { BrowserTargetActionEffectSnapshot, BrowserViewportOptions, ProjectReadFileResult, WorkspaceFileEntry, WorkspaceListOptions, WorkspaceWriteFileOptions, WorkspaceWriteFileResult } from './browser.js'
import type { BrowserPageDriverState } from './driver.js'

export interface BrowserViewportDeviceMetrics {
  width: number
  height: number
  screenWidth: number
  screenHeight: number
  deviceScaleFactor: number
  mobile: boolean
}

/**
 * 浏览器工作区文件访问（宿主按 member/site 注入数据根 browser 分区）。
 * 使用 Browser 领域自己的 artifact DTO，与 `ToolBrowserApi` 的
 * listFiles/readFile/writeFile 单源一致。
 */
export interface CdpWorkspaceFileAccess {
  listFiles(options?: WorkspaceListOptions): Promise<WorkspaceFileEntry[]>
  readFile(
    path: string,
    startLine?: number,
    endLine?: number,
    maxChars?: number
  ): Promise<ProjectReadFileResult>
  writeFile(
    path: string,
    content: string,
    options?: WorkspaceWriteFileOptions
  ): Promise<WorkspaceWriteFileResult>
}

/** 诊断窗口上限的窄面（宿主的 BrowserDiagnosticsRecorder 结构满足它）。 */
export interface BrowserDiagnosticsLimits {
  maxEntries: number
}

export interface BrowserPointerPoint {
  x: number
  y: number
}

export interface BrowserTargetActionInternalEffectSnapshot extends BrowserTargetActionEffectSnapshot {
  textSampleLines: string[]
  textSampleTruncated: boolean
}

export type BrowserTargetActionClickMode = 'dom' | 'coordinate'

export interface BrowserViewportScreenMetrics {
  focused: boolean
  screenX: number
  screenY: number
  outerWidth: number
  outerHeight: number
  innerWidth: number
  innerHeight: number
}

/** 一次 trace 录制的解析产物；rawEvents 供落盘，parsedTrace 供 insight 查询。 */
export interface BrowserParsedTraceRecording {
  parsedTrace: DevtoolsParsedTrace
  insightSetIds: string[]
  rawEvents: unknown[]
}

export interface BrowserTraceParseMetadata {
  cpuThrottling?: number
  networkThrottling?: string
}

/** 每个 session 的性能 trace 状态：录制中 / 最近一次录制的解析产物。 */
export interface BrowserPerformanceTraceState {
  running: boolean
  startedAt: number
  url: string
  recording?: LooseOptional<BrowserParsedTraceRecording>
}

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
