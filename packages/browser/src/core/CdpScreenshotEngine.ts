import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

import { isFiniteNumber, isObject, isPlainObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import type {
  BrowserPageDriverScreenshotOptions,
} from './BrowserPageDriver'
import {
  getRelativePathInsideRoot,
  toPortableRelativePath,
} from './BrowserPathContainment'
import {
  type BrowserPageDriverKernel,
  DEFAULT_BROWSER_VIEWPORT,
  type ExternalBrowserPageSession,
} from './BrowserRuntimeInternals'
import type { BrowserCaptureScreenshotOptions, BrowserScreencastStartResult, BrowserScreencastStopResult, BrowserScreenshotArtifact, BrowserScreenshotCaptureRegion, BrowserScreenshotMetadata } from './types.js'

/**
 * 截图域的 host 无关外部核（**降级实现**）。
 *
 * ⚠️ 诚实缺席声明:Electron 宿主的 `BrowserScreenshotEngine` 靠 `electron.nativeImage`
 * （裁剪/缩放/标注/diff/模型图）与隐藏 `BrowserWindow`（模型视图叠加渲染）完成富截图，
 * CDP 侧没有等价的栅格编解码器。本核只保证 driver 能力覆盖得到的部分:
 *
 *  - `captureScreenshot`:经 `driver.captureScreenshot` 拿 PNG 字节并落盘,尺寸来自 driver
 *    返回的 capture region;**annotateElements / includeModelImage / compareWithPrevious（diff）
 *    在 CDP 侧诚实缺席**（返回 null,不硬造）。
 *  - `startScreencast` / `stopScreencast`:录制经 `driver.startScreencast/stopScreencast`,
 *    但 **GIF 合成需要把 PNG 帧解码成 RGBA 的栅格解码器,CDP 侧诚实缺席**,故 stop 抛可读诊断。
 *
 * 本降级实现仍需通过完整浏览器旅程电池后，才能声明与 Electron 富截图路径等价。
 */
export class CdpScreenshotEngine {
  protected readonly log = logRuntime.tag('BrowserScreenshotEngine')

  private readonly screencasts = new Map<string, { startedAt: number; url: string }>()

  constructor(protected readonly kernel: BrowserPageDriverKernel) {}

  protected getExternalPageSession(sessionId: string): Nullable<ExternalBrowserPageSession> {
    return this.kernel.getExternalPageSession(sessionId)
  }

  private requireExternalPageSession(sessionId: string): ExternalBrowserPageSession {
    const externalSession = this.getExternalPageSession(sessionId)
    if (!externalSession) {
      throw new AppError('NOT_FOUND', `外部浏览器会话不存在：${sessionId}`)
    }
    return externalSession
  }

  public async captureScreenshot(
    sessionId: string,
    context: { url: string; workspaceRoot: string },
    options: BrowserCaptureScreenshotOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserScreenshotArtifact> {
    abortSignal?.throwIfAborted()
    const session = this.requireExternalPageSession(sessionId)
    if (!session.driver.captureScreenshot) {
      throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持截图。')
    }

    const metadata = await this.readDegradedScreenshotMetadata(session)
    const screenshotOptions = this.resolveScreenshotOptions(metadata, options)
    const captured = await session.driver.captureScreenshot(screenshotOptions)
    const bytes = Buffer.from(captured.bytes)
    const artifactPath = this.resolveScreenshotPath(context.workspaceRoot, options.path)

    await mkdir(dirname(artifactPath.path), { recursive: true })
    await writeFile(artifactPath.path, bytes)

    return {
      url: session.url || session.driver.getURL() || context.url,
      path: artifactPath.path,
      relativePath: artifactPath.relativePath,
      width: captured.capture.width,
      height: captured.capture.height,
      bytes: bytes.byteLength,
      capturedAt: Date.now(),
      capture: captured.capture,
      metadata: this.applyCaptureRegionToMetadata(metadata, captured.capture),
      // 诚实缺席:diff / 模型图需要 nativeImage 级栅格处理,CDP 侧不硬造。
      diff: undefined,
      modelImage: undefined,
    }
  }

  public async startScreencast(
    sessionId: string,
    context: { url: string },
    _abortSignal?: AbortSignal
  ): Promise<BrowserScreencastStartResult> {
    _abortSignal?.throwIfAborted()
    if (this.screencasts.has(sessionId)) {
      throw new AppError('VALIDATION', '页面录屏已在进行中，请先 stop。')
    }
    const session = this.requireExternalPageSession(sessionId)
    if (!session.driver.startScreencast || !session.driver.stopScreencast) {
      throw new AppError('VALIDATION', '当前浏览器页面 driver 不支持录屏。')
    }
    const startedAt = Date.now()
    this.screencasts.set(sessionId, { startedAt, url: session.url || context.url })
    return {
      url: session.url || context.url,
      status: 'recording' as const,
      startedAt,
      note: '录屏中：执行需要演示的页面操作，然后调用 stop。',
    }
  }

  public async stopScreencast(
    sessionId: string,
    _context: { url: string },
    _abortSignal?: AbortSignal
  ): Promise<BrowserScreencastStopResult> {
    _abortSignal?.throwIfAborted()
    if (!this.screencasts.has(sessionId)) {
      throw new AppError('VALIDATION', '当前没有正在进行的页面录屏。')
    }
    this.screencasts.delete(sessionId)
    // 诚实缺席:GIF 合成需要把 CDP 的 PNG 帧解码成 RGBA 的栅格解码器,headless CDP 侧不硬造。
    throw new AppError(
      'EXECUTION_FAILED',
      'headless CDP 模式下的录屏 GIF 合成需要 nativeImage 级栅格解码器（诚实缺席）。请在 Electron 宿主内录屏，或改用 browser:capture_screenshot。'
    )
  }

  private async readDegradedScreenshotMetadata(
    session: ExternalBrowserPageSession
  ): Promise<BrowserScreenshotMetadata> {
    let pageMetadata: Record<string, unknown> = {}
    if (!session.driver.isDestroyed()) {
      try {
        const raw = await session.driver.executeJavaScript(
          `(() => {
  const root = document.documentElement;
  const body = document.body;
  const viewportWidth = Math.max(1, Math.round(window.innerWidth || root.clientWidth || 1));
  const viewportHeight = Math.max(1, Math.round(window.innerHeight || root.clientHeight || 1));
  return {
    viewportWidth,
    viewportHeight,
    scrollX: Math.max(0, Math.round(window.scrollX || root.scrollLeft || 0)),
    scrollY: Math.max(0, Math.round(window.scrollY || root.scrollTop || 0)),
    documentWidth: Math.max(viewportWidth, Math.round(root.scrollWidth || 0), body ? Math.round(body.scrollWidth || 0) : 0),
    documentHeight: Math.max(viewportHeight, Math.round(root.scrollHeight || 0), body ? Math.round(body.scrollHeight || 0) : 0),
    deviceScaleFactor: Number(window.devicePixelRatio) || 1,
  };
})()`,
          true
        )
        pageMetadata = isPlainObject(raw) ? raw : {}
      } catch (error) {
        this.log.debug('读取外部浏览器截图元数据失败，使用默认元数据', {
          error: AppError.from(error).message,
        })
      }
    }

    const readNumber = (value: unknown, fallback: number): number =>
      isFiniteNumber(value) ? value : fallback

    return {
      viewportWidth: readNumber(pageMetadata.viewportWidth, DEFAULT_BROWSER_VIEWPORT.width),
      viewportHeight: readNumber(pageMetadata.viewportHeight, DEFAULT_BROWSER_VIEWPORT.height),
      scrollX: Math.max(0, Math.round(readNumber(pageMetadata.scrollX, 0))),
      scrollY: Math.max(0, Math.round(readNumber(pageMetadata.scrollY, 0))),
      documentWidth: readNumber(pageMetadata.documentWidth, DEFAULT_BROWSER_VIEWPORT.width),
      documentHeight: readNumber(pageMetadata.documentHeight, DEFAULT_BROWSER_VIEWPORT.height),
      deviceScaleFactor: readNumber(pageMetadata.deviceScaleFactor, 1),
      zoomFactor: 1,
      cursor: null,
      elementLabels: [],
      elementLegend: [],
      stability: null,
      recentEvents: [],
      // 诚实缺席:CDP 降级路径不跑登录墙启发式（截图元数据脚本未内嵌 detectLogin）。
      login: {
        requiresLogin: false,
        confidence: 0,
        reason: '未检测到明确登录墙。',
        signals: [],
        passwordInputs: 0,
        usernameInputs: 0,
        loginButtons: 0,
        loginLinks: 0,
        forms: 0,
      },
    }
  }

  private applyCaptureRegionToMetadata(
    metadata: BrowserScreenshotMetadata,
    capture: BrowserScreenshotCaptureRegion
  ): BrowserScreenshotMetadata {
    return {
      ...metadata,
      documentWidth: capture.documentWidth || metadata.documentWidth,
      documentHeight: capture.documentHeight || metadata.documentHeight,
    }
  }

  private resolveScreenshotOptions(
    metadata: BrowserScreenshotMetadata,
    options: BrowserCaptureScreenshotOptions
  ): BrowserPageDriverScreenshotOptions {
    if (options.region && isObject(options.region) && 'width' in options.region) {
      const region = options.region as { x?: number; y?: number; width?: number; height?: number }
      return {
        mode: 'region',
        metadata,
        clip: {
          x: Math.max(0, Math.round(region.x ?? 0)),
          y: Math.max(0, Math.round(region.y ?? 0)),
          width: Math.max(1, Math.round(region.width ?? metadata.viewportWidth)),
          height: Math.max(1, Math.round(region.height ?? metadata.viewportHeight)),
        },
      }
    }

    if (options.fullPage) return {
        mode: 'full-page',
        metadata,
      }

    return {
      mode: 'viewport',
      metadata,
    }
  }

  private resolveScreenshotPath(
    workspaceRoot: string,
    requestedPath?: string
  ): {
    path: string
    relativePath: string
  } {
    const relativePath =
      requestedPath?.trim() ||
      `artifacts/screenshots/browser-${new Date().toISOString().replace(/[:.]/g, '-')}.png`

    if (isAbsolute(relativePath)) {
      throw new AppError('VALIDATION', '截图路径必须是当前浏览器工作区内的相对路径。')
    }

    const resolvedRoot = resolve(workspaceRoot)
    const resolvedPath = resolve(resolvedRoot, relativePath)
    const pathFromRoot = getRelativePathInsideRoot(resolvedRoot, resolvedPath)

    if (!pathFromRoot) {
      // 防止 ../../ 逃出工作区。
      throw new AppError('PERMISSION', '截图路径不能离开当前浏览器工作区。')
    }

    return {
      path: resolvedPath,
      relativePath: toPortableRelativePath(pathFromRoot),
    }
  }
}
