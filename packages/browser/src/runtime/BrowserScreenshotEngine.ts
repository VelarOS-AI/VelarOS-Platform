import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

import electron from 'electron'

import { isArray, isFalse, isNumber, isObject, isPlainObject, isPresent, isString, isTrue,optionalWhenLazy, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import type { BrowserCaptureScreenshotOptions, BrowserDomStabilityOptions, BrowserElementTargetHint, BrowserLoginDetection, BrowserPagePreviewFrame, BrowserPagePreviewPointerEvent, BrowserPagePreviewStreamEvent, BrowserPageStabilityResult, BrowserScreencastStartOptions, BrowserScreencastStartResult, BrowserScreencastStopOptions, BrowserScreencastStopResult, BrowserScreenshotArtifact, BrowserScreenshotCaptureRegion, BrowserScreenshotDiff, BrowserScreenshotElementLabel, BrowserScreenshotElementLabelOptions, BrowserScreenshotElementLegendItem, BrowserScreenshotMetadata, BrowserScreenshotModelImage, BrowserScreenshotModelImageOptions, BrowserScreenshotRegionOptions, BrowserSiteContext } from '../core'
import {
  type BrowserPageDriver,
  type BrowserPageDriverScreenshotOptions,
  type BrowserTargetRefStore,
  DefaultScreencastStartOptions,
  encodeScreencastFramesToGif,
  type ScreencastCapturedFrame,
  type ScreencastFrameDecoder,
} from '../core'
import { browserLoginDetectionScriptFragment } from '../core'
import {
  getRelativePathInsideRoot,
  toPortableRelativePath,
} from '../core'

import type { BrowserPageWaiter } from './BrowserPageWaiter'
import {
  type BrowserRuntimeKernel,
  clampInteger,
  clampNumber,
  clampZoomFactor,
  type ExternalBrowserPageSession,
  readBoundedString,
  readFiniteNumber,
} from './BrowserRuntimeInternals'
import { type BrowserSession, DEFAULT_BROWSER_VIEWPORT } from './BrowserRuntimeTypes'
import { evaluateInWebContents } from './BrowserWebContentsEvaluator'

interface BrowserScreenshotDiffFrame {
  fingerprint: string
  sample: Buffer
}

interface BrowserScreenshotImageCapture {
  image: Electron.NativeImage
  capture: BrowserScreenshotCaptureRegion
}

/** 录屏帧解码：JPEG → RGBA（electron nativeImage,toBitmap 为 BGRA 需换序）。 */
function createElectronScreencastFrameDecoder(): ScreencastFrameDecoder {
  return (bytes, maxWidth) => {
    let image = electron.nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) return null

    if (image.getSize().width > maxWidth) {
      image = image.resize({ width: maxWidth })
    }
    const { width, height } = image.getSize()
    const rgba = Buffer.from(image.toBitmap())
    for (let offset = 0; offset < rgba.length; offset += 4) {
      const blue = rgba[offset]!
      rgba[offset] = rgba[offset + 2]!
      rgba[offset + 2] = blue
    }
    return { width, height, rgba }
  }
}

const DefaultScreenshotModelImageMaxWidth = 1280

const DefaultScreenshotModelImageMaxHeight = 900

const DefaultScreenshotModelImageQuality = 72

/**
 * 模型图编码字节预算。
 *
 * 模型图会以 base64 进对话历史,超预算的图（曾出现 425×900 q72 却 166KB 的高熵页面）
 * 会显著抬高上下文占用；超预算时按质量阶梯降质,仍超则整体再缩一档。
 */
const ModelImageByteBudget = 96_000

const ModelImageQualityLadder = [60, 45, 32]

const DefaultScreenshotFullPageMaxWidth = 10_000

const DefaultScreenshotFullPageMaxHeight = 16_000

const DefaultScreenshotElementLabelLimit = 40

const DefaultPreviewMaxWidth = 720

const DefaultPreviewJpegQuality = 68

const DefaultPreviewStreamMaxWidth = 960

const DefaultPreviewStreamMaxHeight = 1_600

/**
 * 截图域执行体：视口/全页/区域截图、元素标注与图例、模型压缩图、diff 采样、
 * 页面元数据脚本与登录态启发检测。
 *
 * 方法默认在 runtime 的 actionQueue 内被调用。
 */
export class BrowserScreenshotEngine {
  private readonly log = logRuntime.tag('BrowserScreenshotEngine')
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
    const screenshotOptions = await this.resolveExternalScreenshotOptions(
      externalSession,
      metadata,
      {}
    )
    const captured = await externalSession.driver.captureScreenshot(screenshotOptions)
    let image = electron.nativeImage.createFromBuffer(captured.bytes)

    if (image.isEmpty()) {
      throw new AppError('EXECUTION_FAILED', '浏览器页面预览不是有效图像。')
    }

    const maxWidth = clampInteger(options.maxWidth, 240, 1_280, DefaultPreviewMaxWidth)
    if (image.getSize().width > maxWidth) {
      image = image.resize({ width: maxWidth })
    }
    const quality = clampInteger(options.quality, 35, 90, DefaultPreviewJpegQuality)
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
    const maxWidth = clampInteger(options.maxWidth, 240, 1_280, DefaultPreviewStreamMaxWidth)
    const quality = clampInteger(options.quality, 35, 90, 62)

    await driver.startScreencast(
      {
        maxWidth,
        maxHeight: DefaultPreviewStreamMaxHeight,
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
            DefaultPreviewStreamMaxHeight / sourceHeight
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
    const relativePath = `artifacts/recordings/${stem || `screencast-${stamp}`}.gif`
    const resolvedRoot = resolve(context.workspaceRoot)
    const gifPath = resolve(resolvedRoot, relativePath)
    if (!getRelativePathInsideRoot(resolvedRoot, gifPath)) {
      throw new AppError('PERMISSION', '录屏产物路径不能离开当前浏览器工作区。')
    }
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
    const stabilityOptions = this.resolveDomStabilityOptions(options.waitForDomStable)
    const stability = stabilityOptions
      ? await this.pageWaiter.waitForDomAndLayoutStable(
          session.webContents,
          stabilityOptions,
          abortSignal
        )
      : null

    const labelOptions = this.resolveScreenshotElementLabelOptions(options.annotateElements)
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
      const artifactPath = this.resolveScreenshotPath(context.workspaceRoot, options.path)
      const diff = optionalWhenLazy(options.compareWithPrevious, () =>
        this.buildScreenshotDiff(sessionId, image, bytes)
      )
      const modelImage = await this.buildScreenshotModelImage(
        image,
        options.includeModelImage,
        capture
      )
      const persistedModelImage = modelImage
        ? await this.writeScreenshotModelImage(
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
    const screenshotOptions = await this.resolveExternalScreenshotOptions(
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
    const artifactPath = this.resolveScreenshotPath(context.workspaceRoot, options.path)
    const diff = optionalWhenLazy(options.compareWithPrevious, () =>
      this.buildScreenshotDiff(sessionId, image, bytes)
    )
    const modelImage = await this.buildScreenshotModelImage(
      image,
      options.includeModelImage,
      captured.capture
    )
    const persistedModelImage = modelImage
      ? await this.writeScreenshotModelImage(
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

  private resolveScreenshotElementLabelOptions(
    options: BrowserCaptureScreenshotOptions['annotateElements']
  ): Nullable<BrowserScreenshotElementLabelOptions> {
    if (!options) return null
    if (isObject(options) && isFalse(options.enabled)) return null

    const rawMaxElements = optionalWhenLazy(
      isObject(options),
      () => (options as BrowserScreenshotElementLabelOptions).maxElements
    )
    return {
      enabled: true,
      maxElements: clampInteger(rawMaxElements, 1, 120, DefaultScreenshotElementLabelLimit),
    }
  }

  private resolveDomStabilityOptions(
    options: BrowserCaptureScreenshotOptions['waitForDomStable']
  ): Nullable<BrowserDomStabilityOptions> {
    if (!options) return null

    const rawOptions = isObject(options) ? options : {}
    return {
      stableFrames: clampInteger(rawOptions.stableFrames, 3, 16, 5),
      sampleIntervalMs: clampInteger(rawOptions.sampleIntervalMs, 16, 250, 80),
      maxWaitMs: clampInteger(rawOptions.maxWaitMs, 250, 8000, 2500),
    }
  }

  private resolveScreenshotFullPageOptions(
    options: BrowserCaptureScreenshotOptions['fullPage']
  ): Nullable<{ maxWidth: number; maxHeight: number }> {
    if (!options) return null
    if (isObject(options) && isFalse(options.enabled)) return null

    const rawOptions = isObject(options) ? options : {}
    return {
      maxWidth: clampInteger(rawOptions.maxWidth, 320, 32_000, DefaultScreenshotFullPageMaxWidth),
      maxHeight: clampInteger(
        rawOptions.maxHeight,
        240,
        32_000,
        DefaultScreenshotFullPageMaxHeight
      ),
    }
  }

  private resolveScreenshotModelImageOptions(
    options: BrowserCaptureScreenshotOptions['includeModelImage']
  ): Nullable<Required<BrowserScreenshotModelImageOptions>> {
    if (!options) return null

    const rawOptions = isObject(options) ? options : {}
    return {
      maxWidth: clampInteger(rawOptions.maxWidth, 320, 3840, DefaultScreenshotModelImageMaxWidth),
      maxHeight: clampInteger(
        rawOptions.maxHeight,
        240,
        2160,
        DefaultScreenshotModelImageMaxHeight
      ),
      quality: clampInteger(rawOptions.quality, 1, 100, DefaultScreenshotModelImageQuality),
      highlightViewport: !isFalse(rawOptions.highlightViewport),
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

    const fullPageOptions = this.resolveScreenshotFullPageOptions(options.fullPage)
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
      capture: this.buildViewportCaptureRegion(metadata, size.width, size.height),
    }
  }

  private async resolveExternalScreenshotOptions(
    session: ExternalBrowserPageSession,
    metadata: BrowserScreenshotMetadata,
    options: BrowserCaptureScreenshotOptions
  ): Promise<BrowserPageDriverScreenshotOptions> {
    if (options.region) {
      const clip = await this.resolveExternalScreenshotRegionRect(session, options.region)
      if (clip)
        return {
          mode: 'region',
          metadata,
          clip,
        }
    }

    const fullPageOptions = this.resolveScreenshotFullPageOptions(options.fullPage)
    if (fullPageOptions)
      return {
        mode: 'full-page',
        metadata,
        maxWidth: fullPageOptions.maxWidth,
        maxHeight: fullPageOptions.maxHeight,
      }

    return {
      mode: 'viewport',
      metadata,
    }
  }

  private buildViewportCaptureRegion(
    metadata: BrowserScreenshotMetadata,
    imageWidth: number,
    imageHeight: number
  ): BrowserScreenshotCaptureRegion {
    return {
      mode: 'viewport',
      coordinateSpace: 'page-css-px',
      x: metadata.scrollX,
      y: metadata.scrollY,
      width: Math.max(1, metadata.viewportWidth),
      height: Math.max(1, metadata.viewportHeight),
      documentWidth: metadata.documentWidth,
      documentHeight: metadata.documentHeight,
      viewport: {
        x: metadata.scrollX,
        y: metadata.scrollY,
        width: Math.max(1, metadata.viewportWidth),
        height: Math.max(1, metadata.viewportHeight),
      },
      clipped: imageWidth <= 0 || imageHeight <= 0,
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
    const rect = await this.resolveScreenshotRegionRect(session, region)
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

  private async resolveScreenshotRegionRect(
    session: BrowserSession,
    region: BrowserScreenshotRegionOptions
  ): Promise<Nullable<{ x: number; y: number; width: number; height: number }>> {
    if (region.selector?.trim()) {
      const selectorLiteral = JSON.stringify(region.selector.trim())
      const resolved = (await evaluateInWebContents(
        session.webContents,
        `(() => {
          const el = document.querySelector(${selectorLiteral});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            x: Math.round(window.scrollX + r.x),
            y: Math.round(window.scrollY + r.y),
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
        })()`,
        true
      )) as Nullable<{ x?: number; y?: number; width?: number; height?: number }>
      if (
        resolved &&
        Number.isFinite(resolved.x) &&
        Number.isFinite(resolved.y) &&
        Number.isFinite(resolved.width) &&
        Number.isFinite(resolved.height)
      )
        return {
          x: resolved.x!,
          y: resolved.y!,
          width: resolved.width!,
          height: resolved.height!,
        }
      return null
    }

    if (
      Number.isFinite(region.x) &&
      Number.isFinite(region.y) &&
      Number.isFinite(region.width) &&
      Number.isFinite(region.height)
    )
      return {
        x: region.x!,
        y: region.y!,
        width: region.width!,
        height: region.height!,
      }

    return null
  }

  private async buildScreenshotModelImage(
    image: Electron.NativeImage,
    options: BrowserCaptureScreenshotOptions['includeModelImage'],
    capture: BrowserScreenshotCaptureRegion
  ): Promise<Nullable<BrowserScreenshotModelImage>> {
    const modelOptions = this.resolveScreenshotModelImageOptions(options)
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
    const coordinateMap = this.buildScreenshotModelCoordinateMap(capture, targetWidth, targetHeight)
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
      for (const quality of ModelImageQualityLadder) {
        if (bytes.byteLength <= ModelImageByteBudget || quality >= effectiveQuality) continue
        bytes = effectiveImage.toJPEG(quality)
        effectiveQuality = quality
      }
      if (bytes.byteLength > ModelImageByteBudget) {
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
        coordinateMap: this.buildScreenshotModelCoordinateMap(
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

  private async writeScreenshotModelImage(
    workspaceRoot: string,
    originalRelativePath: string,
    modelImage: BrowserScreenshotModelImage
  ): Promise<BrowserScreenshotModelImage> {
    const extension = modelImage.mediaType === 'image/jpeg' ? 'jpg' : 'png'
    const originalName = basename(originalRelativePath.replace(/\\/g, '/'))
    const stem = originalName.replace(/\.[^.]*$/, '') || `screenshot-${Date.now()}`
    const relativePath = `artifacts/screenshots/model/${stem}-model.${extension}`
    const path = resolve(workspaceRoot, relativePath)

    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, Buffer.from(modelImage.data, 'base64'))

    return {
      ...modelImage,
      path,
      relativePath,
    }
  }

  private buildScreenshotModelCoordinateMap(
    capture: BrowserScreenshotCaptureRegion,
    imageWidth: number,
    imageHeight: number
  ): NonNullable<BrowserScreenshotModelImage['coordinateMap']> {
    const pageToImageScaleX = imageWidth / Math.max(1, capture.width)
    const pageToImageScaleY = imageHeight / Math.max(1, capture.height)
    const viewportX = clampNumber(
      capture.viewport.x,
      capture.x,
      capture.x + capture.width,
      capture.x
    )
    const viewportY = clampNumber(
      capture.viewport.y,
      capture.y,
      capture.y + capture.height,
      capture.y
    )
    const viewport = {
      x: viewportX,
      y: viewportY,
      width: Math.max(1, Math.min(capture.viewport.width, capture.x + capture.width - viewportX)),
      height: Math.max(
        1,
        Math.min(capture.viewport.height, capture.y + capture.height - viewportY)
      ),
    }
    const viewportRectInImage = {
      x: Math.round((viewport.x - capture.x) * pageToImageScaleX),
      y: Math.round((viewport.y - capture.y) * pageToImageScaleY),
      width: Math.max(1, Math.round(viewport.width * pageToImageScaleX)),
      height: Math.max(1, Math.round(viewport.height * pageToImageScaleY)),
    }

    return {
      coordinateSpace: 'page-css-px',
      pageToImageScaleX,
      pageToImageScaleY,
      imageToPageScaleX: Math.max(1, capture.width) / imageWidth,
      imageToPageScaleY: Math.max(1, capture.height) / imageHeight,
      viewportRectInImage,
      visibleViewport: {
        x: capture.viewport.x,
        y: capture.viewport.y,
        width: capture.viewport.width,
        height: capture.viewport.height,
      },
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
    const sample = this.buildScreenshotDiffSample(image)
    const previousFrame = toNullable(this.screenshotDiffFrames.get(sessionId))
    this.screenshotDiffFrames.set(sessionId, { fingerprint, sample })

    const changed = previousFrame?.fingerprint !== fingerprint
    const pixelDiff = previousFrame
      ? this.compareScreenshotDiffSamples(previousFrame.sample, sample)
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

  private buildScreenshotDiffSample(image: Electron.NativeImage): Buffer {
    return image
      .resize({
        width: 64,
        height: 64,
        quality: 'good',
      })
      .toBitmap()
  }

  private compareScreenshotDiffSamples(
    previousSample: Buffer,
    sample: Buffer
  ): {
    changedPixels: number
    totalPixels: number
    changedRatio: number
  } {
    const totalPixels = Math.floor(Math.min(previousSample.byteLength, sample.byteLength) / 4)
    let changedPixels = 0

    for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex += 1) {
      const offset = pixelIndex * 4
      const delta =
        Math.abs((previousSample[offset] ?? 0) - (sample[offset] ?? 0)) +
        Math.abs((previousSample[offset + 1] ?? 0) - (sample[offset + 1] ?? 0)) +
        Math.abs((previousSample[offset + 2] ?? 0) - (sample[offset + 2] ?? 0)) +
        Math.abs((previousSample[offset + 3] ?? 0) - (sample[offset + 3] ?? 0))

      if (delta > 28) {
        changedPixels += 1
      }
    }

    return {
      changedPixels,
      totalPixels,
      changedRatio:
        totalPixels > 0 ? Math.round((changedPixels / totalPixels) * 10_000) / 10_000 : 0,
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
        this.buildScreenshotElementLabelsScript(
          options.maxElements ?? DefaultScreenshotElementLabelLimit
        ),
        true
      )
      return this.normalizeScreenshotElementLabels(labels)
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
          this.buildScreenshotMetadataScript(),
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
      cursor: this.normalizeScreenshotCursor(pageMetadata.cursor),
      elementLabels,
      elementLegend: this.buildScreenshotElementLegend(elementLabels),
      stability,
      recentEvents: this.readRecentBrowserEvents(session),
      login: this.normalizeLoginDetection(pageMetadata.login),
    }
  }

  private async readExternalScreenshotMetadata(
    session: ExternalBrowserPageSession
  ): Promise<BrowserScreenshotMetadata> {
    let pageMetadata: Record<string, unknown> = {}

    if (!session.driver.isDestroyed()) {
      try {
        const rawPageMetadata = await session.driver.executeJavaScript(
          this.buildScreenshotMetadataScript(),
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
      cursor: this.normalizeScreenshotCursor(pageMetadata.cursor),
      elementLabels: [],
      elementLegend: [],
      stability: null,
      recentEvents: [],
      login: this.normalizeLoginDetection(pageMetadata.login),
    }
  }

  private async resolveExternalScreenshotRegionRect(
    session: ExternalBrowserPageSession,
    region: BrowserScreenshotRegionOptions
  ): Promise<Nullable<{ x: number; y: number; width: number; height: number }>> {
    if (region.selector?.trim()) {
      const selectorLiteral = JSON.stringify(region.selector.trim())
      const resolved = await session.driver.executeJavaScript<
        Nullable<{ x?: number; y?: number; width?: number; height?: number }>
      >(
        `(() => {
          const el = document.querySelector(${selectorLiteral});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            x: Math.round(window.scrollX + r.x),
            y: Math.round(window.scrollY + r.y),
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
        })()`,
        true
      )
      if (
        resolved &&
        Number.isFinite(resolved.x) &&
        Number.isFinite(resolved.y) &&
        Number.isFinite(resolved.width) &&
        Number.isFinite(resolved.height)
      )
        return {
          x: resolved.x!,
          y: resolved.y!,
          width: resolved.width!,
          height: resolved.height!,
        }
      return null
    }

    if (
      Number.isFinite(region.x) &&
      Number.isFinite(region.y) &&
      Number.isFinite(region.width) &&
      Number.isFinite(region.height)
    )
      return {
        x: region.x!,
        y: region.y!,
        width: region.width!,
        height: region.height!,
      }

    return null
  }

  private readRecentBrowserEvents(
    session: BrowserSession
  ): BrowserScreenshotMetadata['recentEvents'] {
    return session.diagnostics
      .filter((entry) => entry.kind !== 'console')
      .slice(-8)
      .map((entry) => ({ ...entry }))
  }

  private buildScreenshotElementLegend(
    labels: BrowserScreenshotElementLabel[]
  ): BrowserScreenshotElementLegendItem[] {
    return labels.map((label) => {
      const role = label.role || label.tagName || 'element'
      const quotedText = label.text ? ` "${label.text}"` : ''
      const selectorText = label.selector ? ` (${label.selector})` : ''
      const target: BrowserElementTargetHint = {
        ref: `@e${label.index}`,
        css: label.selector,
        role: label.role,
        text: label.text,
        name: null,
        attributes: {},
      }

      return {
        index: label.index,
        label: `[${label.index}]`,
        role: label.role,
        text: label.text,
        selector: label.selector,
        description: `[${label.index}] ${role}${quotedText}${selectorText}`,
        target,
      }
    })
  }

  private normalizeScreenshotElementLabels(value: unknown): BrowserScreenshotElementLabel[] {
    if (!isArray(value)) return []

    return value
      .map((item): Nullable<BrowserScreenshotElementLabel> => {
        if (!isPlainObject(item)) return null

        const index = clampInteger(readFiniteNumber(item.index), 1, 10_000, 1)
        const x = Math.round(readFiniteNumber(item.x) ?? 0)
        const y = Math.round(readFiniteNumber(item.y) ?? 0)
        const width = Math.max(1, Math.round(readFiniteNumber(item.width) ?? 1))
        const height = Math.max(1, Math.round(readFiniteNumber(item.height) ?? 1))

        return {
          index,
          tagName: readBoundedString(item.tagName, 32) ?? 'element',
          role: readBoundedString(item.role, 80),
          text: readBoundedString(item.text, 120),
          selector: readBoundedString(item.selector, 240),
          x,
          y,
          width,
          height,
        }
      })
      .filter((label): label is BrowserScreenshotElementLabel => !!label)
  }

  private normalizeScreenshotCursor(value: unknown): BrowserScreenshotMetadata['cursor'] {
    if (!isPlainObject(value)) return null

    const x = readFiniteNumber(value.x)
    const y = readFiniteNumber(value.y)

    // readFiniteNumber 已保证有限，缺席即非法坐标。
    if (!isPresent(x) || !isPresent(y)) return null

    return {
      x: Math.round(x),
      y: Math.round(y),
      pressed: !!value.pressed,
    }
  }

  private normalizeLoginDetection(value: unknown): BrowserLoginDetection {
    if (!isPlainObject(value)) return this.createEmptyLoginDetection()

    const confidence = clampNumber(readFiniteNumber(value.confidence), 0, 1, 0)
    const signals = isArray(value.signals) ? value.signals.filter(isString).slice(0, 12) : []

    return {
      requiresLogin: isTrue(value.requiresLogin) && confidence >= 0.62,
      confidence: Math.round(confidence * 100) / 100,
      reason: readBoundedString(value.reason, 180) ?? '未检测到明确登录墙。',
      signals,
      passwordInputs: clampInteger(readFiniteNumber(value.passwordInputs), 0, 50, 0),
      usernameInputs: clampInteger(readFiniteNumber(value.usernameInputs), 0, 50, 0),
      loginButtons: clampInteger(readFiniteNumber(value.loginButtons), 0, 50, 0),
      loginLinks: clampInteger(readFiniteNumber(value.loginLinks), 0, 50, 0),
      forms: clampInteger(readFiniteNumber(value.forms), 0, 50, 0),
    }
  }

  private createEmptyLoginDetection(): BrowserLoginDetection {
    return {
      requiresLogin: false,
      confidence: 0,
      reason: '未检测到明确登录墙。',
      signals: [],
      passwordInputs: 0,
      usernameInputs: 0,
      loginButtons: 0,
      loginLinks: 0,
      forms: 0,
    }
  }

  private buildScreenshotMetadataScript(): string {
    return `(() => {
  const pointer = document.getElementById('__velaros_virtual_pointer__');
${browserLoginDetectionScriptFragment}
  const readPointerNumber = (name) => {
    if (!pointer) return null;
    const value = Number(pointer.dataset[name]);
    return Number.isFinite(value) ? value : null;
  };
  const pointerX = readPointerNumber('x');
  const pointerY = readPointerNumber('y');
  const root = document.documentElement;
  const body = document.body;
  const viewportWidth = Math.max(1, Math.round(window.innerWidth || root.clientWidth || 1));
  const viewportHeight = Math.max(1, Math.round(window.innerHeight || root.clientHeight || 1));
  const documentWidth = Math.max(
    viewportWidth,
    Math.round(root.scrollWidth || 0),
    Math.round(root.offsetWidth || 0),
    Math.round(root.clientWidth || 0),
    body ? Math.round(body.scrollWidth || 0) : 0,
    body ? Math.round(body.offsetWidth || 0) : 0
  );
  const documentHeight = Math.max(
    viewportHeight,
    Math.round(root.scrollHeight || 0),
    Math.round(root.offsetHeight || 0),
    Math.round(root.clientHeight || 0),
    body ? Math.round(body.scrollHeight || 0) : 0,
    body ? Math.round(body.offsetHeight || 0) : 0
  );
  return {
    viewportWidth,
    viewportHeight,
    scrollX: Math.max(0, Math.round(window.scrollX || root.scrollLeft || 0)),
    scrollY: Math.max(0, Math.round(window.scrollY || root.scrollTop || 0)),
    documentWidth,
    documentHeight,
    deviceScaleFactor: Number(window.devicePixelRatio) || 1,
    cursor: pointerX === null || pointerY === null ? null : {
      x: Math.round(pointerX),
      y: Math.round(pointerY),
      pressed: pointer.dataset.pressed === 'true',
    },
    login: detectLogin(),
  };
})()`
  }

  private buildScreenshotElementLabelsScript(maxElements: number): string {
    const payload = JSON.stringify({
      maxElements: clampInteger(maxElements, 1, 120, DefaultScreenshotElementLabelLimit),
    })

    return `(() => {
  const payload = ${payload};
  const overlayId = '__velaros_screenshot_labels__';
  const existing = document.getElementById(overlayId);
  if (existing) existing.remove();

  const selector = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
    '[onclick]'
  ].join(',');
  const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
  const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
  const candidates = Array.from(document.querySelectorAll(selector));
  const seen = new Set();
  const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  const quoteAttr = (value) => String(value || '').replace(/"/g, '\\\\"');
  const labelFor = (element) =>
    normalizeText(
      element.getAttribute('aria-label') ||
      element.getAttribute('placeholder') ||
      element.getAttribute('title') ||
      element.innerText ||
      element.value ||
      element.textContent
    );
  const selectorFor = (element) => {
    const tagName = element.tagName ? element.tagName.toLowerCase() : 'element';
    const testId = element.getAttribute('data-testid') || element.getAttribute('data-test');
    const name = element.getAttribute('name');
    const id = element.getAttribute('id');
    if (id) return '#' + id;
    if (testId) return tagName + '[data-testid="' + quoteAttr(testId) + '"]';
    if (name) return tagName + '[name="' + quoteAttr(name) + '"]';
    return tagName;
  };
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width < 6 || rect.height < 6) return false;
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= viewportWidth || rect.top >= viewportHeight) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.03;
  };
  const items = [];
  for (const element of candidates) {
    if (!(element instanceof Element) || seen.has(element) || !isVisible(element)) continue;
    seen.add(element);
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(viewportWidth, rect.right);
    const bottom = Math.min(viewportHeight, rect.bottom);
    items.push({
      element,
      tagName: element.tagName ? element.tagName.toLowerCase() : 'element',
      role: element.getAttribute('role') || null,
      text: labelFor(element) || null,
      selector: selectorFor(element),
      x: Math.round(left),
      y: Math.round(top),
      width: Math.max(1, Math.round(right - left)),
      height: Math.max(1, Math.round(bottom - top)),
    });
  }

  items.sort((a, b) => a.y - b.y || a.x - b.x);
  const labels = items.slice(0, payload.maxElements).map((item, index) => ({
    index: index + 1,
    tagName: item.tagName,
    role: item.role,
    text: item.text,
    selector: item.selector,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
  }));

  const overlay = document.createElement('div');
  overlay.id = overlayId;
  overlay.setAttribute('aria-hidden', 'true');
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483645',
    pointerEvents: 'none',
    overflow: 'hidden',
    font: '700 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  });

  for (const label of labels) {
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed',
      left: label.x + 'px',
      top: label.y + 'px',
      width: label.width + 'px',
      height: label.height + 'px',
      border: '2px solid rgba(10, 132, 255, 0.88)',
      borderRadius: '5px',
      background: 'rgba(10, 132, 255, 0.08)',
      boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.72)',
      boxSizing: 'border-box',
    });
    const badge = document.createElement('div');
    badge.textContent = String(label.index);
    Object.assign(badge.style, {
      position: 'fixed',
      left: Math.min(viewportWidth - 26, Math.max(2, label.x - 1)) + 'px',
      top: Math.max(2, label.y - 12) + 'px',
      minWidth: '18px',
      height: '18px',
      padding: '0 5px',
      borderRadius: '999px',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0a84ff',
      color: '#ffffff',
      border: '1px solid rgba(255, 255, 255, 0.94)',
      boxShadow: '0 4px 12px rgba(15, 23, 42, 0.22)',
      boxSizing: 'border-box',
    });
    overlay.appendChild(box);
    overlay.appendChild(badge);
  }

  (document.body || document.documentElement).appendChild(overlay);
  return labels;
})()`
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
