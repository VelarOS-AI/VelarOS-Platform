/** 外部浏览器页面会话；通过 CDP driver 接入，不依赖任何 host 的内嵌 WebContents。 */
import type { BrowserPageDriver } from '../contract/requires.js'

import type {
  BrowserMouseButton,
  BrowserTargetActionEffectSnapshot,
  BrowserTurnContextSourcePeekInput,
  BrowserTurnContextSourcePeekResult,
  BrowserViewportOptions,
} from './browser.js'
import type { BrowserPageDriverState } from './driver.js'

export interface BrowserViewportDeviceMetrics {
  width: number
  height: number
  screenWidth: number
  screenHeight: number
  deviceScaleFactor: number
  mobile: boolean
}

/** 诊断窗口上限的窄面（宿主的 BrowserDiagnosticsRecorder 结构满足它）。 */
export interface BrowserDiagnosticsLimits {
  maxEntries: number
}

export interface BrowserPointerPoint {
  x: number
  y: number
}

/** 一个会话的输入状态：按着的键（DOM key 值）、按着的鼠标键、指针在视口里的位置。输入原子与点击、拖拽共用，按着的修饰键带到每个输入事件上。 */
export interface BrowserInputState {
  held: Set<string>
  buttons: Set<BrowserMouseButton>
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

/**
 * vendor DevTools 引擎解析出来的那份 trace。
 *
 * 它的具体形状属于第三方引擎，而类型文件按标准不引实现与 vendor 产物，所以这里只声明
 * insight 查询真用得到的那一格；引擎内部仍按自己的完整类型走。
 */
export interface BrowserParsedTrace {
  insights?: LooseOptional<Map<string, { model: Record<string, unknown> }>>
}

/** 一次 trace 录制的解析产物；`rawEvents` 供落盘，`parsedTrace` 供 insight 查询。 */
export interface BrowserParsedTraceRecording {
  parsedTrace: BrowserParsedTrace
  insightSetIds: string[]
  rawEvents: unknown[]
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

/**
 * 回合上下文增量源：本包自持这一份形状，结构上与内核的通用回合上下文源兼容。
 *
 * 带方法成员，所以不在可移植数据文件里——`./contracts` 只放不带行为的数据。
 */
export interface BrowserTurnContextDeltaSource {
  /** 源 id，宿主按它认这一路增量。 */
  id: string
  /** 这一路增量允许出现在哪些空间。 */
  scopes: readonly string[]
  /** 渲染进程看不看得到。 */
  rendererVisible?: boolean
  /** 读一段还没被消费的增量。 */
  peekCached(input: BrowserTurnContextSourcePeekInput): BrowserTurnContextSourcePeekResult
}

export interface BrowserCommandSpec {
  file: string
  args: string[]
}
