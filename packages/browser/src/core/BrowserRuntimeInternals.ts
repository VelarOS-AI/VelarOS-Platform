import { isFiniteNumber, isString, optionalWhen } from '@velaros-ai/core'

import type {
  BrowserPageDriver,
  BrowserPageDriverNetworkCaptureState,
  BrowserPageDriverState,
} from './BrowserPageDriver'
import type { BrowserWorkspacePath } from './BrowserPathContainment'
import { resolveBrowserWorkspacePath } from './BrowserPathContainment'
import type { BrowserPageDiagnosticKind, BrowserViewportOptions } from './types.js'

/** 内嵌浏览器默认视口，和桌面常见窗口比例接近。 */
export const DEFAULT_BROWSER_VIEWPORT = {
  width: 1365,
  height: 768,
} as const

/**
 * 浏览器运行时的 host 无关内部协作契约。
 *
 * 外部 CDP driver 会话与「面向 driver 多态调用」的页面数据面，engine 只经
 * `BrowserPageDriverKernel` 取会话、刷状态、跨域协作；宿主专属的 WebContents 会话与
 * webview-only 能力（Electron 输入合成等）由各宿主在 `@velaros-ai/browser/runtime` 里
 * 扩展这个 kernel，不反向下沉进 core。
 */

/** 外部浏览器页面会话；通过 CDP driver 接入，不依赖任何 host 的内嵌 WebContents。 */
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

/* ------------------------------------------------------------------ *
 * 领域共用的纯工具（原 runtime 私有方法提出，engines 与 runtime 同源使用）
 * ------------------------------------------------------------------ */

export function readFiniteNumber(value: unknown): number | undefined {
  return optionalWhen(isFiniteNumber, value)
}

/**
 * 诊断按种类取窗口：**先按种类过滤，再取最近 limit 条**。
 *
 * 顺序反过来就是一个实打实的 bug：一个 console 刷屏的页面里，「最近 50 条诊断」全是 console，
 * 再过滤网络就回 0 条（`networkTotal: 0`），而失败的请求就在更早的诊断里。
 */
export function takeBrowserDiagnosticWindow<Entry extends { kind: BrowserPageDiagnosticKind }>(
  entries: readonly Entry[],
  limit: number,
  kinds?: LooseOptional<readonly BrowserPageDiagnosticKind[]>
): Entry[] {
  const selected = kinds ? entries.filter((entry) => kinds.includes(entry.kind)) : [...entries]
  return selected.slice(-limit)
}

/**
 * 网络采集状态 → 给模型看的如实说明；采集一直在跑（没什么要说的）时返回 null。
 *
 * 内嵌页面的采集是读诊断时才建立的：不说这一句，模型看到的就是「网络事件是空的」，
 * 然后照着提示词在空列表上打转。
 */
export function buildBrowserNetworkCaptureNotice(
  state: LooseOptional<Nullable<BrowserPageDriverNetworkCaptureState>>
): Nullable<string> {
  if (!state) return null
  if (state.unavailableReason)
    return `内嵌页面的网络采集没能开始（${state.unavailableReason}），这次列不到网络事件；关掉开发者工具后再试。`

  return state.startedNow
    ? '内嵌页面的网络采集从这次调用才开始，在这之前发出的请求没有记录；重新加载页面后再列一次就能看到。'
    : null
}

/**
 * 按种类清空诊断缓冲（就地改）：kinds 缺席时全清，否则只清所选种类。
 *
 * 读一次网络事件顺手把 console 与页面异常也清掉，等于让「读」吃掉别人的证据。
 */
export function clearBrowserDiagnosticEntries<Entry extends { kind: BrowserPageDiagnosticKind }>(
  buffer: Entry[],
  kinds?: LooseOptional<readonly BrowserPageDiagnosticKind[]>
): void {
  if (!kinds) {
    buffer.splice(0, buffer.length)
    return
  }

  const kept = buffer.filter((entry) => !kinds.includes(entry.kind))
  buffer.splice(0, buffer.length, ...kept)
}

export function readBoundedString(value: unknown, maxLength: number): Nullable<string> {
  if (!isString(value)) return null

  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

/**
 * 数值入参钳制族：**全包唯一实现**，页面脚本构造器与 engines 都从这里取。
 *
 * 为什么钳制而不是拒绝：这些值来自模型给的工具入参（超时、条数、字符上限、滚动距离）。
 * 越界一律夹回区间、缺席用 fallback，**不抛错**——拒绝会把「参数写大了一点」升级成一次
 * 完整的失败重试，而夹回后的行为对调用方仍然正确。
 *
 * 用 `isFiniteNumber` 而非 `Number.isFinite`：后者不是类型谓词，收窄不了 `number | undefined`，
 * 于是每份拷贝都要补一次 `value as number`——本包曾因此散着 7 份实现 + 14 处断言。
 */
export function clampNumber(
  value: LooseOptional<number>,
  min: number,
  max: number,
  fallback: number
): number {
  if (!isFiniteNumber(value)) return fallback

  return Math.min(Math.max(value, min), max)
}

export function clampInteger(
  value: LooseOptional<number>,
  min: number,
  max: number,
  fallback: number
): number {
  if (!isFiniteNumber(value)) return fallback

  return Math.min(Math.max(Math.round(value), min), max)
}

/** 页面缩放因子归一化（0.25–3，两位小数）。 */
export function clampZoomFactor(value: LooseOptional<number>, fallback: number): number {
  if (!isFiniteNumber(value)) return fallback

  const normalized = Math.round(value * 100) / 100
  return Math.min(Math.max(normalized, 0.25), 3)
}

/** 解析外部 CDP 会话当前 URL，必要时回退。 */
export function resolveExternalPageUrl(
  session: ExternalBrowserPageSession,
  fallbackUrl: string
): string {
  return session.url || session.driver.getURL() || fallbackUrl
}

/**
 * 解析站点工作区内的相对保存路径，防目录穿越。
 *
 * 判定走 {@link resolveBrowserWorkspacePath}（按真实路径，解开符号链接）：与 `browser:files`
 * 同一份实现，工作区里指向外面的符号链接读写都拒绝。
 */
export async function resolveWorkspaceFilePath(
  workspaceRoot: string,
  requestedPath: string,
  label = '路径'
): Promise<BrowserWorkspacePath> {
  return resolveBrowserWorkspacePath(workspaceRoot, requestedPath, label)
}
