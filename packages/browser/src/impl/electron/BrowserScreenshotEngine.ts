import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import electron from 'electron'

import { isNumber, isPlainObject, isString,optionalWhenLazy, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Log } from '@velaros-ai/core/logger'

import type { BrowserPageDriver } from '../../contract/requires.js'
import type {
  BrowserCaptureScreenshotOptions,
  BrowserPagePreviewFrame,
  BrowserPagePreviewPointerEvent,
  BrowserPagePreviewStreamEvent,
  BrowserPageStabilityResult,
  BrowserScreencastStartOptions,
  BrowserScreencastStartResult,
  BrowserScreencastStopOptions,
  BrowserScreencastStopResult,
  BrowserScreenshotArtifact,
  BrowserScreenshotCaptureRegion,
  BrowserScreenshotDiff,
  BrowserScreenshotElementLabel,
  BrowserScreenshotElementLabelOptions,
  BrowserScreenshotMetadata,
  BrowserScreenshotModelImage,
  BrowserScreenshotRegionOptions,
  BrowserSiteContext,
} from '../../types/browser'
import type { ScreencastCapturedFrame } from '../../types/cdp.js'
import { type BrowserSession } from '../../types/electron'
import type { BrowserRuntimeKernel, BrowserScreenshotDiffFrame, BrowserScreenshotImageCapture } from '../../types/electron.js'
import type { ExternalBrowserPageSession } from '../../types/runtime.js'
import { evaluateInWebContents } from '../../utils/electron/evaluate'
import { buildScreenshotDiffSample, buildScreenshotElementLabelsScript, buildScreenshotElementLegend, buildScreenshotMetadataScript, buildScreenshotModelCoordinateMap, buildViewportCaptureRegion, compareScreenshotDiffSamples, normalizeScreenshotCursor, normalizeScreenshotElementLabels, readRecentBrowserEvents, resolveDomStabilityOptions, resolveScreenshotElementLabelOptions, resolveScreenshotFullPageOptions, resolveScreenshotModelImageOptions, resolveScreenshotPath, resolveScreenshotRegionRect, writeScreenshotModelImage } from '../../utils/electron/screenshot-image'
import { normalizeLoginDetection, resolveExternalScreenshotOptions } from '../../utils/electron/screenshot-image'
import { createElectronScreencastFrameDecoder } from '../../utils/electron/screenshot-image'
import { clampInteger, clampNumber, clampZoomFactor, readFiniteNumber } from '../../utils/numbers.js'
import { BrowserTuning } from '../../utils/tuning'
import { DEFAULT_BROWSER_VIEWPORT } from '../../utils/viewport.js'
import { resolveBrowserWorkspacePath } from '../../utils/workspace-paths'
import { DefaultScreencastStartOptions, encodeScreencastFramesToGif } from '../cdp/CdpScreencastRecorder'
import type { BrowserTargetRefStore } from '../session/BrowserTargetRefStore'

import type { BrowserPageWaiter } from './BrowserPageWaiter'

/**
 * 截图域执行体：视口/全页/区域截图、元素标注与图例、模型压缩图、diff 采样、
 * 页面元数据脚本与登录态启发检测。
 *
 * 方法默认在 runtime 的 actionQueue 内被调用。
 */
export interface BrowserScreenshotEngineApi {
  /**
   * 捕获仅供宿主 UI 短时展示的轻量页面帧。
   *
   * 预览不写入 browser workspace，也不更新截图 diff/legend 等模型侧状态；关闭观察窗后
   * renderer 会停止调用，因此不会给后台浏览器留下 artifact 垃圾。
   */
  capturePreviewFrame(sessionId: string, context: BrowserSiteContext, options: { maxWidth?: number; quality?: number }, abortSignal?: AbortSignal): Promise<BrowserPagePreviewFrame>
  /**
   * 用 CDP Page.startScreencast 向宿主画中画持续推帧。
   *
   * 与 capturePreviewFrame 不同，这里不轮询截图、不进入 actionQueue，也不在主进程保存帧；
   * 页面每次合成的新画面会直接交给 renderer，关闭窗口时由 stopPreviewFrameStream 释放。
   */
  startPreviewFrameStream(sessionId: string, context: BrowserSiteContext, options: { maxWidth?: number; quality?: number }, onEvent: (event: BrowserPagePreviewStreamEvent) => void, abortSignal?: AbortSignal): Promise<void>
  /** 高频指针更新沿现有画中画通道发送，避免为了移动光标重复编码整张页面。 */
  notifyPreviewPointer(sessionId: string, pointer: BrowserPagePreviewPointerEvent): void
  /** 停止画中画的 CDP 实时流；重复调用安全。 */
  stopPreviewFrameStream(sessionId: string): Promise<void>
  /** 开始页面录屏（GIF 产物）。 */
  startScreencast(sessionId: string, context: BrowserSiteContext, options: BrowserScreencastStartOptions, abortSignal?: AbortSignal): Promise<BrowserScreencastStartResult>
  /** 停止录屏，合成 GIF 并落盘 artifacts/recordings/。 */
  stopScreencast(sessionId: string, context: BrowserSiteContext, options: BrowserScreencastStopOptions, abortSignal?: AbortSignal): Promise<BrowserScreencastStopResult>
  /** 截图并把图片存进站点工作区，可标注元素、等页面稳定、与上一张比对。 */
  captureScreenshot(sessionId: string, context: BrowserSiteContext, options?: BrowserCaptureScreenshotOptions, abortSignal?: AbortSignal): Promise<BrowserScreenshotArtifact>
}

export class BrowserScreenshotEngine implements BrowserScreenshotEngineApi {
  private static readonly ModelImageQualityLadder = [60, 45, 32]

  private readonly log = Log.tag('BrowserScreenshotEngine')
  /** 记录上一次截图采样，用于返回轻量 diff 元数据。 */
  private readonly screenshotDiffFrames = new Map<string, BrowserScreenshotDiffFrame>()
  /** 录屏中的会话（sessionId → 开始信息）。 */
  private readonly screencasts = new Map<string, { startedAt: number; url: string }>()
  /** UI 画中画实时流；页面帧与指针事件分开发送，不在主进程累计 JPEG。 */
  private readonly previewStreams = new Map<
    string,
    {
      driver: BrowserPageDriver
      onEvent: (event: BrowserPagePreviewStreamEvent) => void
    }
  >()

  constructor(
    private readonly kernel: BrowserRuntimeKernel,
    private readonly pageWaiter: BrowserPageWaiter,
    private readonly targetRefs: BrowserTargetRefStore
  ) {}

  /**
   * 捕获仅供宿主 UI 短时展示的轻量页面帧。
   *
   * 预览不写入 browser workspace，也不更新截图 diff/legend 等模型侧状态；关闭观察窗后
   * renderer 会停止调用，因此不会给后台浏览器留下 artifact 垃圾。
   */
  public async capturePreviewFrame(
    sessionId: string,
    context: BrowserSiteContext,
    options: { maxWidth?: number; quality?: number } = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserPagePreviewFrame> {
    abortSignal?.throwIfAborted()
    const externalSession = this.kernel.getExternalPageSession(sessionId)
    if (!externalSession) {
      throw new AppError('NOT_FOUND', '后台浏览器页面尚未就绪，无法生成预览。')
    }
    if (!externalSession.driver.captureScreenshot) {
      throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持页面预览。')
    }

    // 观察窗不得走 waitForSession：否则首帧会占住同一 actionQueue，反向阻塞后台页面启动。
    const pageState = await this.kernel.refreshPageDriverSessionState(
      sessionId,
      { driver: externalSession.driver, externalSession },
      context.url
    )
    const metadata = await this.readExternalScreenshotMetadata(externalSession)
    const screenshotOptions = await resolveExternalScreenshotOptions(
      externalSession,
      metadata,
      {}
    )
    const captured = await externalSession.driver.captureScreenshot(screenshotOptions)
    let image = electron.nativeImage.createFromBuffer(captured.bytes)

    if (image.isEmpty()) {
      throw new AppError('EXECUTION_FAILED', '浏览器页面预览不是有效图像。')
    }

    const maxWidth = clampInteger(options.maxWidth, 240, 1_280, BrowserTuning.screenshot.previewMaxWidth)
    if (image.getSize().width > maxWidth) {
      image = image.resize({ width: maxWidth })
    }
    const quality = clampInteger(options.quality, 35, 90, BrowserTuning.screenshot.previewJpegQuality)
    const jpeg = image.toJPEG(quality)
    const { width, height } = image.getSize()

    return {
      dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      width,
      height,
      url: pageState.url || context.url,
      title: toNullable(pageState.title),
      capturedAt: Date.now(),
    }
  }

  /**
   * 用 CDP Page.startScreencast 向宿主画中画持续推帧。
   *
   * 与 capturePreviewFrame 不同，这里不轮询截图、不进入 actionQueue，也不在主进程保存帧；
   * 页面每次合成的新画面会直接交给 renderer，关闭窗口时由 stopPreviewFrameStream 释放。
   */
  public async startPreviewFrameStream(
    sessionId: string,
    context: BrowserSiteContext,
    options: { maxWidth?: number; quality?: number },
    onEvent: (event: BrowserPagePreviewStreamEvent) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    abortSignal?.throwIfAborted()
    if (this.previewStreams.has(sessionId)) {
      throw new AppError('VALIDATION', '该后台浏览器画中画已经在实时同步。')
    }

    const externalSession = this.kernel.getExternalPageSession(sessionId)
    if (!externalSession) {
      throw new AppError('NOT_FOUND', '后台浏览器页面尚未就绪，无法启动实时预览。')
    }
    const driver = externalSession.driver
    if (!driver.startScreencast || !driver.stopScreencast) {
      throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持实时画面同步。')
    }
    if (driver.isScreencasting?.()) {
      throw new AppError('VALIDATION', '页面正在执行其他录屏任务，暂时无法启动画中画。')
    }

    const pageState = await this.kernel.refreshPageDriverSessionState(
      sessionId,
      { driver, externalSession },
      context.url
    )
    const maxWidth = clampInteger(options.maxWidth, 240, 1_280, BrowserTuning.screenshot.previewStreamMaxWidth)
    const quality = clampInteger(options.quality, 35, 90, 62)

    await driver.startScreencast(
      {
        maxWidth,
        maxHeight: BrowserTuning.screenshot.previewStreamMaxHeight,
        everyNthFrame: 1,
        maxFrames: Number.MAX_SAFE_INTEGER,
      },
      {
        retainFrames: false,
        quality,
        onFrame: (captured) => {
          const sourceWidth = Math.max(1, captured.width)
          const sourceHeight = Math.max(1, captured.height)
          const scale = Math.min(
            1,
            maxWidth / sourceWidth,
            BrowserTuning.screenshot.previewStreamMaxHeight / sourceHeight
          )
          onEvent({
            kind: 'frame',
            frame: {
              dataUrl: `data:image/jpeg;base64,${captured.bytes.toString('base64')}`,
              width: Math.max(1, Math.round(sourceWidth * scale)),
              height: Math.max(1, Math.round(sourceHeight * scale)),
              url: driver.getURL() || pageState.url || context.url,
              title: toNullable(driver.getTitle()),
              capturedAt: Number.isFinite(captured.timestamp)
                ? Math.round(captured.timestamp * 1_000)
                : Date.now(),
            },
          })
        },
      }
    )
    this.previewStreams.set(sessionId, { driver, onEvent })
  }

  /** 高频指针更新沿现有画中画通道发送，避免为了移动光标重复编码整张页面。 */
  public notifyPreviewPointer(sessionId: string, pointer: BrowserPagePreviewPointerEvent): void {
    this.previewStreams.get(sessionId)?.onEvent({ kind: 'pointer', pointer })
  }

  /** 停止画中画的 CDP 实时流；重复调用安全。 */
  public async stopPreviewFrameStream(sessionId: string): Promise<void> {
    const stream = this.previewStreams.get(sessionId)
    if (!stream) return
    this.previewStreams.delete(sessionId)
    if (!stream.driver.stopScreencast || !stream.driver.isScreencasting?.()) return
    await stream.driver.stopScreencast().then(() => undefined)
  }

  /** 开始页面录屏（GIF 产物）。 */
  public async startScreencast(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserScreencastStartOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserScreencastStartResult> {
    abortSignal?.throwIfAborted()
    if (this.screencasts.has(sessionId)) {
      throw new AppError('VALIDATION', '页面录屏已在进行中，请先 stop。')
    }

    const pageSession = await this.kernel.getLivePageDriverSession(sessionId, abortSignal)
    if (!pageSession.driver.startScreencast || !pageSession.driver.stopScreencast) {
      throw new AppError('VALIDATION', '当前浏览器页面 driver 不支持录屏。')
    }

    const pageState = await this.kernel.refreshPageDriverSessionState(
      sessionId,
      pageSession,
      context.url
    )
    await pageSession.driver.startScreencast({
      ...DefaultScreencastStartOptions,
      maxWidth: clampInteger(options.maxWidth, 240, 1600, DefaultScreencastStartOptions.maxWidth),
      everyNthFrame: clampInteger(
        options.everyNthFrame,
        1,
        10,
        DefaultScreencastStartOptions.everyNthFrame
      ),
    })

    const startedAt = Date.now()
    this.screencasts.set(sessionId, { startedAt, url: pageState.url || context.url })
    return {
      url: pageState.url || context.url,
      status: 'recording' as const,
      startedAt,
      note: '录屏中：执行需要演示的页面操作，然后调用 stop 合成 GIF。页面无变化时不产生新帧。',
    }
  }

  /** 停止录屏，合成 GIF 并落盘 artifacts/recordings/。 */
  public async stopScreencast(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserScreencastStopOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserScreencastStopResult> {
    abortSignal?.throwIfAborted()
    const state = this.screencasts.get(sessionId)
    if (!state) {
      throw new AppError('VALIDATION', '当前没有正在进行的页面录屏。')
    }

    const pageSession = await this.kernel.getLivePageDriverSession(sessionId, abortSignal)
    if (!pageSession.driver.stopScreencast) {
      this.screencasts.delete(sessionId)
      throw new AppError('EXECUTION_FAILED', '浏览器页面连接已断开，录屏丢失。')
    }

    let captured: { frames: ScreencastCapturedFrame[]; frameLimitReached: boolean }
    try {
      captured = await pageSession.driver.stopScreencast()
    } finally {
      this.screencasts.delete(sessionId)
    }

    const gif = encodeScreencastFramesToGif(captured.frames, {
      decode: createElectronScreencastFrameDecoder(),
    })

    const stem = options.name
      ?.trim()
      .replace(/[^\w一-龥-]+/g, '-')
      .slice(0, 60)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const artifact = await resolveBrowserWorkspacePath(
      context.workspaceRoot,
      `artifacts/recordings/${stem || `screencast-${stamp}`}.gif`,
      '录屏产物路径'
    )
    const { path: gifPath, relativePath } = artifact
    await mkdir(dirname(gifPath), { recursive: true })
    await writeFile(gifPath, gif)

    return {
      url: state.url,
      path: gifPath,
      relativePath,
      frameCount: captured.frames.length,
      durationMs: Date.now() - state.startedAt,
      bytes: gif.byteLength,
      frameLimitReached: captured.frameLimitReached,
      capturedAt: Date.now(),
    }
  }

  // ---- kernel 桥接 ----
  // 这些 protected 一行方法是 runtime 拆分期的搬运脚手架（“方法体零改写”地平移进 engine）。
  // 现在拆分已定形，它们的**退场条件**是：把 engine 内的调用点直接改成 `this.kernel.X(...)`，
  // 然后整段删除。在那之前别逐个删——半删会让同一个 engine 里两种取会话写法并存（§0.1 条 2）。
  private getExternalPageSession(sessionId: string): Nullable<ExternalBrowserPageSession> {
    return this.kernel.getExternalPageSession(sessionId)
  }

  private getLivePageSessionUnlocked(
    sessionId: string,
    abortSignal?: AbortSignal
  ): Promise<BrowserSession> {
    return this.kernel.getLivePageSession(sessionId, abortSignal)
  }

  /** 安全判断 WebContents 是否正在加载（webview 截图前的稳定性检查）。 */
  private isWebContentsLoading(webContents: Electron.WebContents): boolean {
    try {
      return !webContents.isDestroyed() && webContents.isLoading()
    } catch (error) {
      this.log.debug('检查 WebContents 加载状态失败', {
        error: AppError.from(error).message,
      })
      return false
    }
  }

  private delay(ms: number): Promise<void> {
    return this.kernel.delay(ms)
  }

  public async captureScreenshot(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserCaptureScreenshotOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserScreenshotArtifact> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession)
      return this.captureExternalScreenshot(sessionId, context, externalSession, options)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    if (this.isWebContentsLoading(session.webContents)) {
      await this.pageWaiter.waitForNavigationToSettle(session.webContents, abortSignal)
    }
    if (options.waitForNetworkIdle) {
      await this.pageWaiter.waitForNetworkIdle(
        session.webContents,
        isNumber(options.waitForNetworkIdle) ? options.waitForNetworkIdle : 700
      )
    }
    const stabilityOptions = resolveDomStabilityOptions(options.waitForDomStable)
    const stability = stabilityOptions
      ? await this.pageWaiter.waitForDomAndLayoutStable(
          session.webContents,
          stabilityOptions,
          abortSignal
        )
      : null

    const labelOptions = resolveScreenshotElementLabelOptions(options.annotateElements)
    let elementLabels: BrowserScreenshotElementLabel[] = []
    let shouldClearElementLabels = false

    try {
      if (labelOptions) {
        elementLabels = await this.installScreenshotElementLabels(session, labelOptions)
        shouldClearElementLabels = true
        await this.delay(40)
      }

      const metadata = await this.readScreenshotMetadata(session, elementLabels, stability)
      if (labelOptions) {
        this.targetRefs.storeScreenshotLegend(sessionId, metadata.elementLegend)
      }
      const { image, capture } = await this.captureBrowserScreenshotImage(
        session,
        metadata,
        options
      )
      const imageSize = image.getSize()
      const bytes = image.toPNG()
      const artifactPath = await resolveScreenshotPath(context.workspaceRoot, options.path)
      const diff = optionalWhenLazy(options.compareWithPrevious, () =>
        this.buildScreenshotDiff(sessionId, image, bytes)
      )
      const modelImage = await this.buildScreenshotModelImage(
        image,
        options.includeModelImage,
        capture
      )
      const persistedModelImage = modelImage
        ? await writeScreenshotModelImage(
            context.workspaceRoot,
            artifactPath.relativePath,
            modelImage
          )
        : null

      // 截图落盘而不是只回传 dataUrl，避免大图撑爆 IPC payload。
      await mkdir(dirname(artifactPath.path), { recursive: true })
      await writeFile(artifactPath.path, bytes)

      return {
        url: session.webContents.getURL() || context.url,
        path: artifactPath.path,
        relativePath: artifactPath.relativePath,
        width: imageSize.width,
        height: imageSize.height,
        bytes: bytes.byteLength,
        capturedAt: Date.now(),
        capture,
        metadata,
        diff: toOptional(diff),
        modelImage: toOptional(persistedModelImage),
      }
    } finally {
      if (shouldClearElementLabels) {
        await this.clearScreenshotElementLabels(session)
      }
    }
  }

  private async captureExternalScreenshot(
    sessionId: string,
    context: BrowserSiteContext,
    session: ExternalBrowserPageSession,
    options: BrowserCaptureScreenshotOptions
  ): Promise<BrowserScreenshotArtifact> {
    if (!session.driver.captureScreenshot) {
      throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持截图。')
    }

    const metadata = await this.readExternalScreenshotMetadata(session)
    const screenshotOptions = await resolveExternalScreenshotOptions(
      session,
      metadata,
      options
    )
    const captured = await session.driver.captureScreenshot(screenshotOptions)
    const image = electron.nativeImage.createFromBuffer(captured.bytes)
    if (image.isEmpty()) {
      throw new AppError('EXECUTION_FAILED', '外部浏览器截图不是有效图像。')
    }

    const imageSize = image.getSize()
    const bytes = Buffer.from(captured.bytes)
    const artifactPath = await resolveScreenshotPath(context.workspaceRoot, options.path)
    const diff = optionalWhenLazy(options.compareWithPrevious, () =>
      this.buildScreenshotDiff(sessionId, image, bytes)
    )
    const modelImage = await this.buildScreenshotModelImage(
      image,
      options.includeModelImage,
      captured.capture
    )
    const persistedModelImage = modelImage
      ? await writeScreenshotModelImage(
          context.workspaceRoot,
          artifactPath.relativePath,
          modelImage
        )
      : null

    await mkdir(dirname(artifactPath.path), { recursive: true })
    await writeFile(artifactPath.path, bytes)

    return {
      url: session.url || session.driver.getURL() || context.url,
      path: artifactPath.path,
      relativePath: artifactPath.relativePath,
      width: imageSize.width,
      height: imageSize.height,
      bytes: bytes.byteLength,
      capturedAt: Date.now(),
      capture: captured.capture,
      metadata,
      diff: toOptional(diff),
      modelImage: toOptional(persistedModelImage),
    }
  }

  

  

  

  

  private async captureBrowserScreenshotImage(
    session: BrowserSession,
    metadata: BrowserScreenshotMetadata,
    options: BrowserCaptureScreenshotOptions
  ): Promise<BrowserScreenshotImageCapture> {
    if (options.region) {
      const regionCapture = await this.tryCaptureRegionScreenshot(session, metadata, options.region)
      if (regionCapture) return regionCapture
    }

    const fullPageOptions = resolveScreenshotFullPageOptions(options.fullPage)
    if (fullPageOptions) {
      const fullPageCapture = await this.tryCaptureFullPageScreenshot(
        session,
        metadata,
        fullPageOptions
      )
      if (fullPageCapture) return fullPageCapture
    }

    const image = await session.webContents.capturePage()
    const size = image.getSize()
    return {
      image,
      capture: buildViewportCaptureRegion(metadata, size.width, size.height),
    }
  }

  

  

  private async tryCaptureFullPageScreenshot(
    session: BrowserSession,
    metadata: BrowserScreenshotMetadata,
    options: { maxWidth: number; maxHeight: number }
  ): Promise<Nullable<BrowserScreenshotImageCapture>> {
    const webContents = session.webContents
    if (webContents.isDestroyed()) return null

    const wasAttached = webContents.debugger.isAttached()
    try {
      if (!wasAttached) {
        webContents.debugger.attach('1.3')
      }

      const metrics = (await webContents.debugger.sendCommand('Page.getLayoutMetrics')) as {
        cssContentSize?: { x?: number; y?: number; width?: number; height?: number }
        contentSize?: { x?: number; y?: number; width?: number; height?: number }
      }
      const content = metrics.cssContentSize ?? metrics.contentSize
      const documentWidth = clampInteger(
        readFiniteNumber(content?.width),
        1,
        32_000,
        metadata.documentWidth
      )
      const documentHeight = clampInteger(
        readFiniteNumber(content?.height),
        1,
        32_000,
        metadata.documentHeight
      )
      const captureWidth = Math.min(documentWidth, options.maxWidth)
      const captureHeight = Math.min(documentHeight, options.maxHeight)
      const captured = (await webContents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: captureWidth,
          height: captureHeight,
          scale: 1,
        },
      })) as { data?: string }
      if (!isString(captured.data) || !captured.data.trim()) return null

      const image = electron.nativeImage.createFromBuffer(Buffer.from(captured.data, 'base64'))
      if (image.isEmpty()) return null

      return {
        image,
        capture: {
          mode: 'full-page',
          coordinateSpace: 'page-css-px',
          x: 0,
          y: 0,
          width: captureWidth,
          height: captureHeight,
          documentWidth,
          documentHeight,
          viewport: {
            x: metadata.scrollX,
            y: metadata.scrollY,
            width: metadata.viewportWidth,
            height: metadata.viewportHeight,
          },
          clipped: captureWidth < documentWidth || captureHeight < documentHeight,
        },
      }
    } catch (error) {
      this.log.debug('截取完整浏览器页面失败，回退当前可视区域截图', {
        error: AppError.from(error).message,
      })
      return null
    } finally {
      if (!wasAttached && webContents.debugger.isAttached()) {
        try {
          webContents.debugger.detach()
        } catch (error) {
          this.log.debug('断开浏览器截图调试器失败', { error: AppError.from(error).message })
        }
      }
    }
  }

  private async tryCaptureRegionScreenshot(
    session: BrowserSession,
    metadata: BrowserScreenshotMetadata,
    region: BrowserScreenshotRegionOptions
  ): Promise<Nullable<BrowserScreenshotImageCapture>> {
    const rect = await resolveScreenshotRegionRect(session, region)
    if (!rect || rect.width <= 0 || rect.height <= 0) return null

    const webContents = session.webContents
    if (webContents.isDestroyed()) return null

    const wasAttached = webContents.debugger.isAttached()
    try {
      if (!wasAttached) {
        webContents.debugger.attach('1.3')
      }

      const captureWidth = Math.min(Math.max(1, Math.round(rect.width)), 32_000)
      const captureHeight = Math.min(Math.max(1, Math.round(rect.height)), 32_000)
      const captured = (await webContents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: {
          x: Math.max(0, Math.round(rect.x)),
          y: Math.max(0, Math.round(rect.y)),
          width: captureWidth,
          height: captureHeight,
          scale: 1,
        },
      })) as { data?: string }
      if (!isString(captured.data) || !captured.data.trim()) return null

      const image = electron.nativeImage.createFromBuffer(Buffer.from(captured.data, 'base64'))
      if (image.isEmpty()) return null

      return {
        image,
        capture: {
          mode: 'region',
          coordinateSpace: 'page-css-px',
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: captureWidth,
          height: captureHeight,
          documentWidth: metadata.documentWidth,
          documentHeight: metadata.documentHeight,
          viewport: {
            x: metadata.scrollX,
            y: metadata.scrollY,
            width: metadata.viewportWidth,
            height: metadata.viewportHeight,
          },
          clipped: captureWidth < rect.width || captureHeight < rect.height,
        },
      }
    } catch (error) {
      this.log.debug('截取浏览器区域截图失败，回退当前可视区域截图', {
        error: AppError.from(error).message,
      })
      return null
    } finally {
      if (!wasAttached && webContents.debugger.isAttached()) {
        try {
          webContents.debugger.detach()
        } catch (error) {
          this.log.debug('断开浏览器截图调试器失败', { error: AppError.from(error).message })
        }
      }
    }
  }

  

  private async buildScreenshotModelImage(
    image: Electron.NativeImage,
    options: BrowserCaptureScreenshotOptions['includeModelImage'],
    capture: BrowserScreenshotCaptureRegion
  ): Promise<Nullable<BrowserScreenshotModelImage>> {
    const modelOptions = resolveScreenshotModelImageOptions(options)
    if (!modelOptions) return null

    const sourceSize = image.getSize()
    const sourceWidth = Math.max(1, sourceSize.width)
    const sourceHeight = Math.max(1, sourceSize.height)
    const scale = Math.min(
      1,
      modelOptions.maxWidth / sourceWidth,
      modelOptions.maxHeight / sourceHeight
    )
    const targetWidth = Math.max(1, Math.round(sourceWidth * scale))
    const targetHeight = Math.max(1, Math.round(sourceHeight * scale))
    const resizedImage =
      targetWidth === sourceWidth && targetHeight === sourceHeight
        ? image
        : image.resize({
            width: targetWidth,
            height: targetHeight,
            quality: 'good',
          })
    const coordinateMap = buildScreenshotModelCoordinateMap(capture, targetWidth, targetHeight)
    const modelImage =
      modelOptions.highlightViewport && capture.mode === 'full-page'
        ? await this.applyModelScreenshotViewportOverlay(resizedImage, coordinateMap)
        : resizedImage

    try {
      let bytes = modelImage.toJPEG(modelOptions.quality)
      let effectiveQuality = modelOptions.quality
      let effectiveImage = modelImage
      let effectiveWidth = targetWidth
      let effectiveHeight = targetHeight
      // 高熵页面（密集小字）在既定质量下可能远超字节预算,先降质、再整体缩一档。
      for (const quality of BrowserScreenshotEngine.ModelImageQualityLadder) {
        if (bytes.byteLength <= BrowserTuning.screenshot.modelImageByteBudget || quality >= effectiveQuality) continue
        bytes = effectiveImage.toJPEG(quality)
        effectiveQuality = quality
      }
      if (bytes.byteLength > BrowserTuning.screenshot.modelImageByteBudget) {
        effectiveWidth = Math.max(1, Math.round(effectiveWidth * 0.75))
        effectiveHeight = Math.max(1, Math.round(effectiveHeight * 0.75))
        effectiveImage = effectiveImage.resize({
          width: effectiveWidth,
          height: effectiveHeight,
          quality: 'good',
        })
        bytes = effectiveImage.toJPEG(effectiveQuality)
      }
      return {
        data: bytes.toString('base64'),
        mediaType: 'image/jpeg',
        width: effectiveWidth,
        height: effectiveHeight,
        bytes: bytes.byteLength,
        sourceWidth,
        sourceHeight,
        scale: effectiveWidth / sourceWidth,
        quality: effectiveQuality,
        coordinateMap: buildScreenshotModelCoordinateMap(
          capture,
          effectiveWidth,
          effectiveHeight
        ),
      }
    } catch (error) {
      this.log.debug('压缩浏览器截图失败，回退 PNG 模型图', {
        error: AppError.from(error).message,
      })
      const bytes = modelImage.toPNG()
      return {
        data: bytes.toString('base64'),
        mediaType: 'image/png',
        width: targetWidth,
        height: targetHeight,
        bytes: bytes.byteLength,
        sourceWidth,
        sourceHeight,
        scale: targetWidth / sourceWidth,
        quality: 100,
        coordinateMap,
      }
    }
  }

  

  

  private async applyModelScreenshotViewportOverlay(
    image: Electron.NativeImage,
    coordinateMap: NonNullable<BrowserScreenshotModelImage['coordinateMap']>
  ): Promise<Electron.NativeImage> {
    const size = image.getSize()
    const width = Math.max(1, size.width)
    const height = Math.max(1, size.height)
    const viewport = coordinateMap.viewportRectInImage
    if (
      viewport.width >= width - 2 &&
      viewport.height >= height - 2 &&
      viewport.x <= 1 &&
      viewport.y <= 1
    )
      return image

    const imageDataUrl = image.toDataURL()
    const viewportStyle = [
      `left:${viewport.x}px`,
      `top:${viewport.y}px`,
      `width:${viewport.width}px`,
      `height:${viewport.height}px`,
    ].join(';')
    const shadeRects = [
      { left: 0, top: 0, width, height: viewport.y },
      { left: 0, top: viewport.y + viewport.height, width, height },
      { left: 0, top: viewport.y, width: viewport.x, height: viewport.height },
      {
        left: viewport.x + viewport.width,
        top: viewport.y,
        width,
        height: viewport.height,
      },
    ].filter((rect) => rect.width > 0 && rect.height > 0)
    const shadeMarkup = shadeRects
      .map(
        (rect, index) =>
          `<div class="shade" data-label="${index === 0 ? '当前屏幕外区域' : ''}" style="left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px"></div>`
      )
      .join('')
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body { width: ${width}px; height: ${height}px; margin: 0; overflow: hidden; background: #fff; }
    .stage { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
    .shade { position: absolute; background: rgba(15, 23, 42, 0.16); box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.06); }
    .shade::before {
      content: attr(data-label);
      display: block;
      padding: 6px 8px;
      color: rgba(15, 23, 42, 0.76);
      font-size: 13px;
      font-weight: 700;
      line-height: 16px;
    }
    .viewport {
      position: absolute;
      ${viewportStyle};
      box-sizing: border-box;
      border: 3px solid #22c55e;
      box-shadow: 0 0 0 2px rgba(255,255,255,0.9), 0 0 0 9999px rgba(15,23,42,0.04);
    }
    .viewport::before {
      content: "用户当前可视区域";
      position: absolute;
      left: 8px;
      top: 8px;
      max-width: calc(100% - 16px);
      padding: 4px 7px;
      border-radius: 6px;
      background: rgba(34, 197, 94, 0.94);
      color: white;
      font-size: 13px;
      font-weight: 800;
      line-height: 16px;
      white-space: nowrap;
    }
  </style>
</head>
<body><div class="stage"><img src="${imageDataUrl}" />${shadeMarkup}<div class="viewport"></div></div></body>
</html>`

    let windowRef: Nullable<Electron.BrowserWindow> = null
    try {
      windowRef = new electron.BrowserWindow({
        show: false,
        frame: false,
        transparent: true,
        width,
        height,
        webPreferences: {
          devTools: !electron.app.isPackaged,
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      await windowRef.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      await evaluateInWebContents(
        windowRef.webContents,
        'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
        true
      )
      const overlaid = await windowRef.webContents.capturePage({
        x: 0,
        y: 0,
        width,
        height,
      })
      return overlaid.isEmpty() ? image : overlaid
    } catch (error) {
      this.log.debug('生成模型截图可视区域标注失败，使用未标注模型图', {
        error: AppError.from(error).message,
      })
      return image
    } finally {
      if (windowRef && !windowRef.isDestroyed()) {
        windowRef.destroy()
      }
    }
  }

  private buildScreenshotDiff(
    sessionId: string,
    image: Electron.NativeImage,
    bytes: Buffer
  ): BrowserScreenshotDiff {
    const fingerprint = createHash('sha256').update(bytes).digest('hex')
    const sample = buildScreenshotDiffSample(image)
    const previousFrame = toNullable(this.screenshotDiffFrames.get(sessionId))
    this.screenshotDiffFrames.set(sessionId, { fingerprint, sample })

    const changed = previousFrame?.fingerprint !== fingerprint
    const pixelDiff = previousFrame
      ? compareScreenshotDiffSamples(previousFrame.sample, sample)
      : null
    return {
      changed,
      reason: previousFrame ? (changed ? 'changed' : 'unchanged') : 'first-capture',
      fingerprint: fingerprint.slice(0, 16),
      previousFingerprint: toNullable(previousFrame?.fingerprint.slice(0, 16)),
      ...(pixelDiff
        ? {
            changedPixels: pixelDiff.changedPixels,
            totalPixels: pixelDiff.totalPixels,
            changedRatio: pixelDiff.changedRatio,
          }
        : {}),
    }
  }

  

  

  private async installScreenshotElementLabels(
    session: BrowserSession,
    options: BrowserScreenshotElementLabelOptions
  ): Promise<BrowserScreenshotElementLabel[]> {
    if (session.webContents.isDestroyed()) return []

    try {
      const labels = await evaluateInWebContents(
        session.webContents,
        buildScreenshotElementLabelsScript(
          options.maxElements ?? BrowserTuning.screenshot.elementLabelLimit
        ),
        true
      )
      return normalizeScreenshotElementLabels(labels)
    } catch (error) {
      this.log.debug('绘制浏览器截图元素标号失败', {
        error: AppError.from(error).message,
      })
      return []
    }
  }

  private async clearScreenshotElementLabels(session: BrowserSession): Promise<void> {
    if (session.webContents.isDestroyed()) return

    try {
      await evaluateInWebContents(
        session.webContents,
        `(() => {
  const overlay = document.getElementById('__velaros_screenshot_labels__');
  if (overlay) overlay.remove();
  return true;
})()`,
        true
      )
    } catch (error) {
      this.log.debug('清理浏览器截图元素标号失败', {
        error: AppError.from(error).message,
      })
    }
  }

  private async readScreenshotMetadata(
    session: BrowserSession,
    elementLabels: BrowserScreenshotElementLabel[],
    stability: Nullable<BrowserPageStabilityResult>
  ): Promise<BrowserScreenshotMetadata> {
    let pageMetadata: Record<string, unknown> = {}

    if (!session.webContents.isDestroyed()) {
      try {
        const rawPageMetadata = await evaluateInWebContents(
          session.webContents,
          buildScreenshotMetadataScript(),
          true
        )
        pageMetadata = isPlainObject(rawPageMetadata) ? rawPageMetadata : {}
      } catch (error) {
        this.log.debug('读取浏览器截图元数据失败，使用默认元数据', {
          error: AppError.from(error).message,
        })
      }
    }

    return {
      viewportWidth: clampInteger(
        readFiniteNumber(pageMetadata.viewportWidth),
        1,
        3840,
        DEFAULT_BROWSER_VIEWPORT.width
      ),
      viewportHeight: clampInteger(
        readFiniteNumber(pageMetadata.viewportHeight),
        1,
        2160,
        DEFAULT_BROWSER_VIEWPORT.height
      ),
      scrollX: Math.max(0, Math.round(readFiniteNumber(pageMetadata.scrollX) ?? 0)),
      scrollY: Math.max(0, Math.round(readFiniteNumber(pageMetadata.scrollY) ?? 0)),
      documentWidth: clampInteger(
        readFiniteNumber(pageMetadata.documentWidth),
        1,
        32_000,
        DEFAULT_BROWSER_VIEWPORT.width
      ),
      documentHeight: clampInteger(
        readFiniteNumber(pageMetadata.documentHeight),
        1,
        32_000,
        DEFAULT_BROWSER_VIEWPORT.height
      ),
      deviceScaleFactor: clampNumber(readFiniteNumber(pageMetadata.deviceScaleFactor), 0.1, 8, 1),
      zoomFactor: clampZoomFactor(session.webContents.getZoomFactor(), 1),
      cursor: normalizeScreenshotCursor(pageMetadata.cursor),
      elementLabels,
      elementLegend: buildScreenshotElementLegend(elementLabels),
      stability,
      recentEvents: readRecentBrowserEvents(session),
      login: normalizeLoginDetection(pageMetadata.login),
    }
  }

  private async readExternalScreenshotMetadata(
    session: ExternalBrowserPageSession
  ): Promise<BrowserScreenshotMetadata> {
    let pageMetadata: Record<string, unknown> = {}

    if (!session.driver.isDestroyed()) {
      try {
        const rawPageMetadata = await session.driver.executeJavaScript(
          buildScreenshotMetadataScript(),
          true
        )
        pageMetadata = isPlainObject(rawPageMetadata) ? rawPageMetadata : {}
      } catch (error) {
        this.log.debug('读取外部浏览器截图元数据失败，使用默认元数据', {
          error: AppError.from(error).message,
        })
      }
    }

    return {
      viewportWidth: clampInteger(
        readFiniteNumber(pageMetadata.viewportWidth),
        1,
        3840,
        DEFAULT_BROWSER_VIEWPORT.width
      ),
      viewportHeight: clampInteger(
        readFiniteNumber(pageMetadata.viewportHeight),
        1,
        2160,
        DEFAULT_BROWSER_VIEWPORT.height
      ),
      scrollX: Math.max(0, Math.round(readFiniteNumber(pageMetadata.scrollX) ?? 0)),
      scrollY: Math.max(0, Math.round(readFiniteNumber(pageMetadata.scrollY) ?? 0)),
      documentWidth: clampInteger(
        readFiniteNumber(pageMetadata.documentWidth),
        1,
        32_000,
        DEFAULT_BROWSER_VIEWPORT.width
      ),
      documentHeight: clampInteger(
        readFiniteNumber(pageMetadata.documentHeight),
        1,
        32_000,
        DEFAULT_BROWSER_VIEWPORT.height
      ),
      deviceScaleFactor: clampNumber(readFiniteNumber(pageMetadata.deviceScaleFactor), 0.1, 8, 1),
      zoomFactor: clampZoomFactor(readFiniteNumber(pageMetadata.zoomFactor), 1),
      cursor: normalizeScreenshotCursor(pageMetadata.cursor),
      elementLabels: [],
      elementLegend: [],
      stability: null,
      recentEvents: [],
      login: normalizeLoginDetection(pageMetadata.login),
    }
  }

  

  

  

  

  

  

  

  

  

  
}
