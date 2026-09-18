/** 操作层与它背后的执行类用到的内部工作类型：点击脚本的选项、坐标、等挂起事件的轮询入参、登录墙的记账状态、提取脚本的原始载荷。都不出单元。 */

import type { BrowserPendingEventKind, BrowserPendingEventsResult } from './browser.js'
import type { BrowserTargetActionClickMode } from './runtime.js'

/** 生成点击脚本时的选项：点击走 DOM 还是走坐标。 */
export interface BrowserTargetActionScriptBuildOptions {
  clickMode?: BrowserTargetActionClickMode
}

/** 一个视口坐标点。 */
export interface CoordinateClickPoint {
  x: number
  y: number
}

/** 等一个挂起事件出现时的轮询入参：要等哪一类、等多久、取消信号与读挂起事件的口子。 */
export interface BrowserPendingEventWaitOptions {
  kind?: BrowserPendingEventKind
  timeoutMs?: number
  abortSignal: AbortSignal
  listPendingEvents: () => Promise<BrowserPendingEventsResult>
}

/** 一个站点在本次会话里的登录门控状态：问过、批准了、拒绝了。 */
export type BrowserLoginGateOriginState = 'prompted' | 'approved' | 'declined'

/** 页面提取脚本返回的原始载荷：页面侧构造的纯 JSON 对象，操作层再按形状交出去。 */
export type BrowserExtractionPayload = Record<string, unknown>
