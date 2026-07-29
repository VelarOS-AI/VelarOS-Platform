import { isAbsolute, resolve } from 'node:path'

import { isFiniteNumber, isString, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  BrowserPageDriver,
  BrowserPageDriverState,
} from './BrowserPageDriver'
import {
  getRelativePathInsideRoot,
  toPortableRelativePath,
} from './BrowserPathContainment'
import type { BrowserViewportOptions } from './types.js'

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
 * webview-only 能力（Electron 输入合成等）由各宿主在 `@velaros-ai/browser-runtime` 里
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

export function readBoundedString(value: unknown, maxLength: number): Nullable<string> {
  if (!isString(value)) return null

  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

export function clampNumber(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number
): number {
  if (!Number.isFinite(value)) return fallback

  return Math.min(Math.max(value as number, min), max)
}

export function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number
): number {
  if (!Number.isFinite(value)) return fallback

  return Math.min(Math.max(Math.round(value as number), min), max)
}

/** 页面缩放因子归一化（0.25–3，两位小数）。 */
export function clampZoomFactor(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback

  const normalized = Math.round((value as number) * 100) / 100
  return Math.min(Math.max(normalized, 0.25), 3)
}

/** 解析外部 CDP 会话当前 URL，必要时回退。 */
export function resolveExternalPageUrl(
  session: ExternalBrowserPageSession,
  fallbackUrl: string
): string {
  return session.url || session.driver.getURL() || fallbackUrl
}

/** 解析浏览器工作区内的相对保存路径，防目录穿越。 */
export function resolveWorkspaceFilePath(
  workspaceRoot: string,
  requestedPath: string
): {
  path: string
  relativePath: string
} {
  const trimmed = requestedPath.trim()
  if (!trimmed) {
    throw new AppError('VALIDATION', 'savePath 不能为空。')
  }

  if (isAbsolute(trimmed)) {
    throw new AppError('VALIDATION', '路径必须是当前浏览器工作区内的相对路径。')
  }

  const resolvedRoot = resolve(workspaceRoot)
  const resolvedPath = resolve(resolvedRoot, trimmed)
  const pathFromRoot = getRelativePathInsideRoot(resolvedRoot, resolvedPath)
  if (!pathFromRoot) {
    throw new AppError('PERMISSION', '路径不能离开当前浏览器工作区。')
  }

  return {
    path: resolvedPath,
    relativePath: toPortableRelativePath(pathFromRoot),
  }
}
