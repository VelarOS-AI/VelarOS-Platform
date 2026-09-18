// 域：外部 Chrome 页面的驱动——纯 CDP 实现的 `BrowserPageDriver`。
//
// **为什么需要这份导览**：本文件是「一个 CDP target = 一个 driver 实例」这条不变量的载体，
// 同时承载订阅生命周期、下载状态机、对话框拦截与诊断缓冲四条独立时序。任一条单独读都会得出
// 错误结论——最典型的是以为 `switchPageTarget` 在切换当前实例，实际它新建了一个。
//
// ## 两份实现、一条接口
// `BrowserPageDriver` 有两个实现：本文件（外部浏览器，CDP WebSocket）与
// `runtime/ElectronWebContentsBrowserPageDriver`（内嵌 WebContents，`webContents.debugger`）。
// 上层 engine 只认接口，**新增页面能力必须两边都落**，否则外部/内嵌两种浏览器行为分叉。
//
// ## 生命周期与不变量（改这些会破什么）
//  - **实例绑定 target，不可重绑**：`switchPageTarget` **返回一个新 driver**（对新 target 重新
//    connect），不是把自己指向新页面。理由：事件订阅、下载表、诊断缓冲全是 per-target 状态，
//    就地重绑必然残留上一个 target 的事件。调用方必须替换自己持有的引用。
//  - **构造即订阅、`dispose` 即退订**：四组订阅（诊断 / 网络 / 下载 / 对话框）在构造函数里一次
//    装好，退订函数进 `eventUnsubscribers`；transport 关闭会回调 `dispose`——socket 断开与显式
//    dispose 因此走同一条清理路径，`destroyed` 标志保证幂等。漏退订 = transport 复用时事件串台。
//  - **本地页面状态是影子不是权威**：`currentUrl` / `currentTitle` / `currentZoomFactor` 只在我们
//    自己发起的操作后更新；页面自发跳转不会同步。需要真值的地方必须显式回读。
//  - **对话框必须被拦截并主动处置**：收到 `Page.javascriptDialogOpening` 后不 handle，页面会
//    **永久卡死**（alert 阻塞渲染主线程）。这是本驱动最容易被误删的一段。
//  - **诊断缓冲有界**：console / exception / 网络记录写入定长缓冲，长会话不得无界增长。
//
// ## 类型边界
// CDP 是无 schema 的 JSON-RPC，`transport.send<T>()` 的 `T` 是**断言不是校验**（§1.4 白名单②，
// 无泛型的原生驱动返回）。所以每个 `normalize*` 私有方法都必须自己收窄，不能假设字段存在。

import {
  isArray,
  isEmpty,
  isFiniteNumber,
  isNonBlankString,
  isNotNull,
  isObject,
  isPresent,
  isString,
  isTrue,
  optionalWhen,
  toNullable,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserPageDriver } from '../../contract/requires.js'
import type { BrowserEmulationOptions, BrowserGeolocationState, BrowserNetworkControlOptions, BrowserNetworkRequestDetailsOptions, BrowserNetworkResponseBodyOptions, BrowserNetworkThrottlingPreset, BrowserOriginStorage, BrowserPageDiagnosticEntry, BrowserPageTargetInfo, BrowserPressKeyOptions, BrowserStorageEntry, BrowserSwitchPageTargetOptions, BrowserTypeTextOptions, BrowserViewportOptions } from '../../types/browser.js'
import type { CdpBrowserPageDriverTransport, CdpCaptureScreenshotResponse, CdpDomDocumentResponse, CdpDomQuerySelectorResponse, CdpDomStorageItemsResponse, CdpDownloadProgressEvent, CdpDownloadWillBeginEvent, CdpFetchResourcePayload, CdpJavascriptDialogOpeningEvent, CdpLayoutMetricsResponse, CdpNetworkGetCookiesResponse, CdpPageFrame, CdpPageFrameTree, CdpPageGetFrameTreeResponse, CdpPageTargetDescription, CdpPrintToPdfResponse, CdpRuntimeConsoleAPICalledEvent, CdpRuntimeEvaluateResponse, CdpRuntimeExceptionDetails, CdpRuntimeExceptionThrownEvent, CdpRuntimeRemoteObject, CdpScreencastConsumerOptions, CdpScreencastStartOptions, CdpTargetListEntry, ScreencastCapturedFrame } from '../../types/cdp.js'
import type { BrowserPageDriverClickCoordinatesOptions, BrowserPageDriverCookie, BrowserPageDriverCookieOptions, BrowserPageDriverDiagnosticsOptions, BrowserPageDriverDownloadEvent, BrowserPageDriverDownloadListener, BrowserPageDriverDragCoordinatesOptions, BrowserPageDriverEmulationState, BrowserPageDriverFetchResourceOptions, BrowserPageDriverFetchResourceResult, BrowserPageDriverFileInputOptions, BrowserPageDriverMoveMouseOptions, BrowserPageDriverNetworkControlState, BrowserPageDriverNetworkIdleOptions, BrowserPageDriverNetworkRequestDetailsResult, BrowserPageDriverNetworkResponseBodyResult, BrowserPageDriverPdfOptions, BrowserPageDriverScreenshot, BrowserPageDriverScreenshotOptions, BrowserPageDriverState, BrowserPageDriverStorageOriginOptions } from '../../types/driver'
import { buildFetchResourceScript, buildViewportRect, clampPageZoomFactor, clampPositiveInteger, cloneGeolocation, normalizeCpuThrottlingRate, normalizeGeolocation, normalizeNullableEmulationString, readConsoleSource, readNodeId, resolveConsoleLevel, resolveConsoleTimestamp, resolveKeyboardModifiers, resolveKeyCode, resolveMouseButton, resolveTargetListEntryId, unwrapRuntimeEvaluateValue } from '../../utils/cdp/driver'
import { normalizeDomStorageEntry, normalizeNetworkCookie, normalizePageTargetDescription, resolveConsoleMessage, resolveRegionScreenshotInput } from '../../utils/cdp/driver'
import { resolveCdpTargetListUrl } from '../../utils/cdp/driver'
import { resolveCdpTargetId } from '../../utils/cdp/driver.js'
import { captureCdpHeapSnapshot } from '../../utils/cdp/tracing.js'
import { openCdpWebSocket } from '../../utils/cdp/transport.js'
import { clearBrowserDiagnosticEntries, takeBrowserDiagnosticWindow } from '../../utils/diagnostics.js'
import { normalizeBrowserPressKeyOptions } from '../../utils/keyboard'
import { BrowserTuning } from '../../utils/tuning'
import { buildBrowserViewportDeviceMetrics } from '../../utils/viewport'

import { BrowserCdpNetworkController } from './BrowserCdpNetworkController'
import { CdpBrowserPageDownloadItem } from './CdpBrowserPageDownloadItem.js'
import { CdpScreencastRecorder } from './CdpScreencastRecorder'
import { CdpTraceCollector } from './CdpTraceCollector'
import {
  CdpWebSocketTransport,
  type CdpWebSocketTransportConnectOptions,
} from './CdpWebSocketTransport'

export interface CdpBrowserPageDriverOptions {
  transport: CdpBrowserPageDriverTransport
  initialUrl?: LooseOptional<string>
  initialTitle?: LooseOptional<string>
  downloadPath?: LooseOptional<string>
  targetListUrl?: LooseOptional<string>
  activeTargetId?: LooseOptional<string>
  fetch?: LooseOptional<typeof fetch>
  connectPageDriver?: LooseOptional<
    (
      webSocketDebuggerUrl: string,
      options: CdpBrowserPageDriverConnectOptions
    ) => Promise<BrowserPageDriver>
  >
  onDispose?: LooseOptional<() => void>
}

export interface CdpBrowserPageDriverConnectOptions extends CdpWebSocketTransportConnectOptions {
  initialUrl?: LooseOptional<string>
  initialTitle?: LooseOptional<string>
  downloadPath?: LooseOptional<string>
  fetch?: LooseOptional<typeof fetch>
  onDispose?: LooseOptional<() => void>
}

class CdpBrowserPageDriver implements BrowserPageDriver {
  public readonly kind = 'external'
  private currentUrl: string
  private currentTitle: string
  private currentZoomFactor = 1
  private readonly diagnostics: BrowserPageDiagnosticEntry[] = []
  private readonly eventUnsubscribers: Array<() => void> = []
  private readonly downloadListeners = new Set<BrowserPageDriverDownloadListener>()
  private readonly downloads = new Map<string, CdpBrowserPageDownloadItem>()
  private networkThrottling: BrowserNetworkThrottlingPreset = 'none'
  private cpuThrottlingRate = 1
  private traceCollector: Nullable<CdpTraceCollector> = null
  private screencastRecorder: Nullable<CdpScreencastRecorder> = null
  private colorScheme: BrowserPageDriverEmulationState['colorScheme'] = 'no-preference'
  private reducedMotion: BrowserPageDriverEmulationState['reducedMotion'] = 'no-preference'
  private timezoneId: Nullable<string> = null
  private locale: Nullable<string> = null
  private geolocation: Nullable<BrowserGeolocationState> = null
  private destroyed = false
  /** 网络子系统共享控制器:记账 / 详情读取 / Fetch 拦截,与嵌入式 webview 共用同一套逻辑。 */
  private readonly networkController = new BrowserCdpNetworkController({
    send: (method, params) => this.options.transport.send(method, params),
    appendDiagnostic: (entry) => this.appendDiagnostic(entry),
    getCurrentUrl: () => this.currentUrl,
    getNetworkThrottling: () => this.networkThrottling,
  })

  /** 给同一个浏览器里的另一个 target 连一个兄弟驱动：socket、target 坐标与依赖都沿用本实例的。 */
  private async connectSiblingDriver(
    webSocketUrl: string,
    options: CdpBrowserPageDriverConnectOptions = {}
  ): Promise<CdpBrowserPageDriver> {
    const socket = await openCdpWebSocket(webSocketUrl, options)
    const transport = new CdpWebSocketTransport({ socket, timeoutMs: options.timeoutMs })
    const driver = new CdpBrowserPageDriver({
      transport,
      initialUrl: options.initialUrl,
      initialTitle: options.initialTitle,
      downloadPath: options.downloadPath ?? this.options.downloadPath,
      targetListUrl: resolveCdpTargetListUrl(webSocketUrl),
      activeTargetId: resolveCdpTargetId(webSocketUrl),
      fetch: options.fetch ?? this.options.fetch,
      onDispose: options.onDispose,
    })
    await driver.resumeTargetIfWaitingForDebugger()
    return driver
  }

  constructor(private readonly options: CdpBrowserPageDriverOptions) {
    this.currentUrl = options.initialUrl?.trim() || ''
    this.currentTitle = options.initialTitle?.trim() || ''
    const unsubscribeClose = options.transport.onClose?.(() => this.dispose())
    if (unsubscribeClose) this.eventUnsubscribers.push(unsubscribeClose)
    this.subscribeToDiagnosticsEvents()
    this.subscribeToNetworkEvents()
    this.subscribeToDownloadEvents()
    this.subscribeToDialogEvents()
  }

  public async executeJavaScript<T = unknown>(script: string, userGesture?: boolean): Promise<T> {
    const response = await this.options.transport.send<CdpRuntimeEvaluateResponse>(
      'Runtime.evaluate',
      {
        expression: script,
        awaitPromise: true,
        returnByValue: true,
        userGesture: !!userGesture,
      }
    )

    if (response.exceptionDetails) {
      const message =
        response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        'unknown exception'
      throw new AppError('EXECUTION_FAILED', `浏览器 CDP 脚本执行失败：${message}`, undefined, {
        cdpMethod: 'Runtime.evaluate',
      })
    }

    const value = unwrapRuntimeEvaluateValue(response)
    this.updateCachedPageState(value)
    return value as T
  }

  public async navigateTo(url: string): Promise<BrowserPageDriverState> {
    if (!isNonBlankString(url)) {
      throw new AppError('VALIDATION', '浏览器 CDP 导航 URL 不能为空。')
    }

    await this.options.transport.send('Page.navigate', { url })
    this.currentUrl = url
    return this.refreshPageState()
  }

  public async refreshPageState(): Promise<BrowserPageDriverState> {
    await this.executeJavaScript<BrowserPageDriverState>(
      '(() => ({ url: location.href, title: document.title || "" }))()'
    )
    return {
      url: this.currentUrl,
      title: this.currentTitle,
    }
  }

  public async listPageTargets(): Promise<BrowserPageTargetInfo[]> {
    const targetListUrl = this.options.targetListUrl?.trim()
    if (!targetListUrl) return [this.buildCurrentPageTarget()]

    const targetFetch = this.options.fetch ?? globalThis.fetch
    if (!targetFetch) {
      this.appendDiagnostic({
        kind: 'network',
        level: 'warning',
        message: 'CDP target list 读取失败：当前运行时没有 fetch 能力。',
        url: toNullable(this.currentUrl),
        line: null,
        column: null,
        code: null,
        capturedAt: Date.now(),
        details: { targetListUrl },
      })
      return [this.buildCurrentPageTarget()]
    }

    const response = await targetFetch(targetListUrl)
    if (!response.ok) {
      this.appendDiagnostic({
        kind: 'network',
        level: 'warning',
        message: `CDP target list 读取失败：${response.status} ${response.statusText}`,
        url: toNullable(this.currentUrl),
        line: null,
        column: null,
        code: response.status,
        capturedAt: Date.now(),
        details: { targetListUrl },
      })
      return [this.buildCurrentPageTarget()]
    }

    const targets = this.normalizeTargetListPayload(await response.json())
    if (!targets.at(0)) return [this.buildCurrentPageTarget()]

    return targets
  }

  public async switchPageTarget(
    options: BrowserSwitchPageTargetOptions
  ): Promise<BrowserPageDriver> {
    const targetId = options.targetId.trim()
    if (!targetId) throw new AppError('VALIDATION', 'CDP page target id 不能为空。')

    const activeTargetId = this.options.activeTargetId?.trim()
    if (activeTargetId && targetId === activeTargetId) return this

    const target = await this.findPageTargetDescription(targetId)
    const connectPageDriver =
      this.options.connectPageDriver ??
      ((webSocketDebuggerUrl: string, connectOptions: CdpBrowserPageDriverConnectOptions) =>
        this.connectSiblingDriver(webSocketDebuggerUrl, connectOptions))

    return connectPageDriver(target.webSocketDebuggerUrl, {
      initialUrl: target.url,
      initialTitle: target.title,
      downloadPath: this.options.downloadPath,
      fetch: this.options.fetch,
    })
  }

  public async bringToFront(): Promise<void> {
    await this.options.transport.send('Page.bringToFront')
  }

  public async captureScreenshot(
    options: BrowserPageDriverScreenshotOptions
  ): Promise<BrowserPageDriverScreenshot> {
    const input = await this.resolveScreenshotInput(options)
    const captured = await this.options.transport.send<CdpCaptureScreenshotResponse>(
      'Page.captureScreenshot',
      input.params
    )
    if (!isString(captured.data) || !captured.data.trim()) {
      throw new AppError('EXECUTION_FAILED', '浏览器 CDP 截图未返回有效图像数据。')
    }

    return {
      bytes: Buffer.from(captured.data, 'base64'),
      capture: input.capture,
    }
  }

  public async typeText(options: BrowserTypeTextOptions): Promise<void> {
    await this.options.transport.send('Input.insertText', {
      text: options.text,
    })
  }

  public async pressKey(options: BrowserPressKeyOptions): Promise<void> {
    const normalized = normalizeBrowserPressKeyOptions(options)
    const repeat = clampPositiveInteger(normalized.repeat, 1)
    const modifiers = resolveKeyboardModifiers(normalized.modifiers ?? [])
    const code = resolveKeyCode(normalized.key)

    for (let index = 0; index < repeat; index += 1) {
      await this.options.transport.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: normalized.key,
        code,
        modifiers,
      })
      await this.options.transport.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: normalized.key,
        code,
        modifiers,
      })
    }
  }

  public async moveMouse(options: BrowserPageDriverMoveMouseOptions): Promise<void> {
    const x = Math.round(options.x)
    const y = Math.round(options.y)
    await this.options.transport.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      clickCount: 0,
    })
    options.onPointerEvent?.({ x, y, phase: 'move' })
  }

  public async clickCoordinates(
    options: BrowserPageDriverClickCoordinatesOptions
  ): Promise<void> {
    const x = Math.round(options.x)
    const y = Math.round(options.y)
    const button = resolveMouseButton(options.button ?? 'left')
    const clickCount = clampPositiveInteger(options.clickCount, 1)

    await this.options.transport.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      clickCount,
    })
    options.onPointerEvent?.({ x, y, phase: 'down', button: options.button ?? 'left' })
    await this.options.transport.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      clickCount,
    })
    options.onPointerEvent?.({ x, y, phase: 'up', button: options.button ?? 'left' })
  }

  public async dragCoordinates(
    options: BrowserPageDriverDragCoordinatesOptions
  ): Promise<void> {
    const startX = Math.round(options.startX)
    const startY = Math.round(options.startY)
    const endX = Math.round(options.endX)
    const endY = Math.round(options.endY)
    const steps = clampPositiveInteger(options.steps, 10)

    await this.options.transport.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX,
      y: startY,
    })
    options.onPointerEvent?.({ x: startX, y: startY, phase: 'move' })
    await this.options.transport.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: startX,
      y: startY,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    })
    options.onPointerEvent?.({ x: startX, y: startY, phase: 'down', button: 'left' })

    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps
      const x = Math.round(startX + (endX - startX) * progress)
      const y = Math.round(startY + (endY - startY) * progress)
      await this.options.transport.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'left',
        buttons: 1,
      })
      options.onPointerEvent?.({ x, y, phase: 'move', button: 'left' })
    }

    await this.options.transport.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: endX,
      y: endY,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    })
    options.onPointerEvent?.({ x: endX, y: endY, phase: 'up', button: 'left' })
  }

  public async setViewport(options: BrowserViewportOptions): Promise<void> {
    const metrics = buildBrowserViewportDeviceMetrics(options)
    await this.options.transport.send('Emulation.setDeviceMetricsOverride', {
      ...metrics,
    })
    await this.options.transport.send('Emulation.setTouchEmulationEnabled', {
      enabled: metrics.mobile,
    })
  }

  public async setFileInputFiles(options: BrowserPageDriverFileInputOptions): Promise<boolean> {
    await this.options.transport.send('DOM.enable')
    const document = await this.options.transport.send<CdpDomDocumentResponse>('DOM.getDocument')
    const rootNodeId = readNodeId(document.root?.nodeId)
    if (!isNotNull(rootNodeId)) {
      throw new AppError('VALIDATION', '无法定位页面 DOM 根节点。')
    }

    const query = await this.options.transport.send<CdpDomQuerySelectorResponse>(
      'DOM.querySelector',
      {
        nodeId: rootNodeId,
        selector: options.selector,
      }
    )
    const nodeId = readNodeId(query.nodeId)
    if (!isNotNull(nodeId)) return false

    await this.options.transport.send('DOM.setFileInputFiles', {
      nodeId,
      files: options.files,
    })
    return true
  }

  public async printToPdf(options: BrowserPageDriverPdfOptions): Promise<Buffer> {
    const printed = await this.options.transport.send<CdpPrintToPdfResponse>('Page.printToPDF', {
      printBackground: options.printBackground,
    })
    if (!isString(printed.data) || !printed.data.trim()) {
      throw new AppError('EXECUTION_FAILED', '浏览器 CDP PDF 导出未返回有效数据。')
    }

    return Buffer.from(printed.data, 'base64')
  }

  public async fetchResource(
    options: BrowserPageDriverFetchResourceOptions
  ): Promise<BrowserPageDriverFetchResourceResult> {
    const payload = await this.executeJavaScript<CdpFetchResourcePayload>(
      buildFetchResourceScript(options),
      true
    )
    if (!isObject(payload) || !isString(payload.data) || !payload.data.trim()) {
      throw new AppError('EXECUTION_FAILED', '浏览器 CDP 资源抓取未返回有效数据。')
    }

    return {
      ok: isTrue(payload.ok),
      status: isFiniteNumber(payload.status) ? Math.round(payload.status) : 0,
      mimeType: isString(payload.mimeType) ? payload.mimeType : null,
      contentLength: isFiniteNumber(payload.contentLength)
        ? Math.max(0, Math.round(payload.contentLength))
        : null,
      bytes: Buffer.from(payload.data, 'base64'),
    }
  }

  public getPageZoomFactor(): number {
    return this.currentZoomFactor
  }

  public async setPageZoomFactor(zoomFactor: number): Promise<void> {
    const normalizedZoomFactor = clampPageZoomFactor(zoomFactor)
    await this.options.transport.send('Emulation.setPageScaleFactor', {
      pageScaleFactor: normalizedZoomFactor,
    })
    this.currentZoomFactor = normalizedZoomFactor
  }

  public async configureNetwork(
    options: BrowserNetworkControlOptions
  ): Promise<BrowserPageDriverNetworkControlState> {
    return this.networkController.configureNetwork(options)
  }

  public async readNetworkResponseBody(
    options: BrowserNetworkResponseBodyOptions
  ): Promise<BrowserPageDriverNetworkResponseBodyResult> {
    return this.networkController.readNetworkResponseBody(options)
  }

  public async readNetworkRequestDetails(
    options: BrowserNetworkRequestDetailsOptions
  ): Promise<BrowserPageDriverNetworkRequestDetailsResult> {
    return this.networkController.readNetworkRequestDetails(options)
  }

  public async waitForNetworkIdle(options: BrowserPageDriverNetworkIdleOptions): Promise<void> {
    await this.networkController.waitForNetworkIdle(options)
  }

  public async configureEmulation(
    options: BrowserEmulationOptions
  ): Promise<BrowserPageDriverEmulationState> {
    const shouldConfigureMedia = isPresent(options.colorScheme) || isPresent(options.reducedMotion)
    if (isPresent(options.colorScheme)) this.colorScheme = options.colorScheme
    if (isPresent(options.reducedMotion)) this.reducedMotion = options.reducedMotion

    if (shouldConfigureMedia) {
      await this.options.transport.send('Emulation.setEmulatedMedia', {
        features: [
          { name: 'prefers-color-scheme', value: this.colorScheme },
          { name: 'prefers-reduced-motion', value: this.reducedMotion },
        ],
      })
    }

    if (isPresent(options.timezoneId)) {
      this.timezoneId = normalizeNullableEmulationString(options.timezoneId)
      await this.options.transport.send('Emulation.setTimezoneOverride', {
        timezoneId: this.timezoneId ?? '',
      })
    }

    if (isPresent(options.locale)) {
      this.locale = normalizeNullableEmulationString(options.locale)
      await this.options.transport.send('Emulation.setLocaleOverride', {
        locale: this.locale ?? '',
      })
    }

    if (isPresent(options.geolocation)) {
      this.geolocation = normalizeGeolocation(options.geolocation)
      await this.options.transport.send('Emulation.setGeolocationOverride', {
        ...this.geolocation,
      })
    }

    if (isPresent(options.cpuThrottlingRate)) {
      this.cpuThrottlingRate = normalizeCpuThrottlingRate(options.cpuThrottlingRate)
      await this.options.transport.send('Emulation.setCPUThrottlingRate', {
        rate: this.cpuThrottlingRate,
      })
    }

    if (isPresent(options.networkThrottling)) {
      this.networkThrottling = options.networkThrottling
      // offline↔节流合流由控制器统一下发(读本 driver 的 networkThrottling + 控制器的 offline)。
      await this.networkController.syncNetworkConditions()
    }

    return {
      colorScheme: this.colorScheme,
      reducedMotion: this.reducedMotion,
      timezoneId: this.timezoneId,
      locale: this.locale,
      geolocation: cloneGeolocation(this.geolocation),
      cpuThrottlingRate: this.cpuThrottlingRate,
      networkThrottling: this.networkThrottling,
    }
  }

  /** 开始录制性能 trace（CDP Tracing domain）。 */
  public async startTracing(): Promise<void> {
    if (this.traceCollector?.isRunning()) {
      throw new AppError('VALIDATION', '性能 trace 已在录制中，请先 stop_trace。')
    }
    if (!this.options.transport.onEvent) {
      throw new AppError('VALIDATION', '当前外部浏览器连接不支持事件订阅，无法录制性能 trace。')
    }
    this.traceCollector = new CdpTraceCollector({
      send: (method, params) => this.options.transport.send(method, params),
      onEvent: (method, listener) => this.options.transport.onEvent!(method, listener),
    })
    await this.traceCollector.start()
  }

  /** 停止录制并读回全部 trace 事件。 */
  public async stopTracing(): Promise<unknown[]> {
    if (!this.traceCollector) {
      throw new AppError('VALIDATION', '当前没有正在录制的性能 trace。')
    }
    try {
      return await this.traceCollector.stop()
    } finally {
      this.traceCollector = null
    }
  }

  public isTracing(): boolean {
    return !!this.traceCollector?.isRunning()
  }

  /** 采集 V8 堆快照，流式写入 sink。 */
  public async captureHeapSnapshot(
    sink: (chunk: string) => void
  ): Promise<{ chunks: number; bytes: number }> {
    if (!this.options.transport.onEvent) {
      throw new AppError('VALIDATION', '当前外部浏览器连接不支持事件订阅，无法采集堆快照。')
    }
    return captureCdpHeapSnapshot(
      {
        send: (method, params) => this.options.transport.send(method, params),
        onEvent: (method, listener) => this.options.transport.onEvent!(method, listener),
      },
      sink
    )
  }

  /** 开始页面录屏。 */
  public async startScreencast(
    options: CdpScreencastStartOptions,
    consumer: CdpScreencastConsumerOptions = {}
  ): Promise<void> {
    if (this.screencastRecorder?.isRunning()) {
      throw new AppError('VALIDATION', '页面录屏已在进行中，请先 stop。')
    }
    if (!this.options.transport.onEvent) {
      throw new AppError('VALIDATION', '当前外部浏览器连接不支持事件订阅，无法录屏。')
    }
    this.screencastRecorder = new CdpScreencastRecorder(
      {
        send: (method, params) => this.options.transport.send(method, params),
        onEvent: (method, listener) => this.options.transport.onEvent!(method, listener),
      },
      consumer
    )
    await this.screencastRecorder.start(options)
  }

  /** 停止录屏并取回帧序列。 */
  public async stopScreencast(): Promise<{
    frames: ScreencastCapturedFrame[]
    frameLimitReached: boolean
  }> {
    if (!this.screencastRecorder) {
      throw new AppError('VALIDATION', '当前没有正在进行的页面录屏。')
    }
    try {
      return await this.screencastRecorder.stop()
    } finally {
      this.screencastRecorder = null
    }
  }

  public isScreencasting(): boolean {
    return !!this.screencastRecorder?.isRunning()
  }

  /** 读取当前环境模拟状态（trace 元数据等旁路消费，不触发 CDP 调用）。 */
  public getEmulationState(): BrowserPageDriverEmulationState {
    return {
      colorScheme: this.colorScheme,
      reducedMotion: this.reducedMotion,
      timezoneId: this.timezoneId,
      locale: this.locale,
      geolocation: cloneGeolocation(this.geolocation),
      cpuThrottlingRate: this.cpuThrottlingRate,
      networkThrottling: this.networkThrottling,
    }
  }

  

  /**
   * offline 与网络节流共用 Network.emulateNetworkConditions，
   * 统一在这里按当前状态合成下发，避免互相覆盖。
   * 预设数值与 DevTools「Network conditions」面板同源（吸收自 chrome-devtools-mcp）。
   */
  public readDiagnostics(options: BrowserPageDriverDiagnosticsOptions): BrowserPageDiagnosticEntry[] {
    const limit = Math.min(
      BrowserTuning.cdp.diagnosticEntries,
      clampPositiveInteger(options.limit, 100)
    )
    // 先按种类挑，再取窗口；clear 只清这次读的种类，别顺手吃掉别人的证据。
    const entries = takeBrowserDiagnosticWindow(this.diagnostics, limit, options.kinds)
    if (options.clear) {
      clearBrowserDiagnosticEntries(this.diagnostics, options.kinds)
    }

    return entries
  }

  public onDownload(listener: BrowserPageDriverDownloadListener): () => void {
    this.downloadListeners.add(listener)
    return () => {
      this.downloadListeners.delete(listener)
    }
  }

  public async grantPermissions(
    permissions: string[],
    origin?: LooseOptional<string>
  ): Promise<void> {
    const normalizedPermissions = permissions
      .map((permission) => permission.trim())
      .filter(isNonBlankString)
    if (isEmpty(normalizedPermissions)) {
      throw new AppError('VALIDATION', 'CDP 权限列表不能为空。')
    }

    await this.options.transport.send('Browser.grantPermissions', {
      permissions: normalizedPermissions,
      origin: optionalWhen(isNonBlankString, origin?.trim()),
    })
  }

  public async readCookies(
    options: BrowserPageDriverCookieOptions = {}
  ): Promise<BrowserPageDriverCookie[]> {
    if (options.scope === 'all') {
      const response = await this.options.transport.send<CdpNetworkGetCookiesResponse>(
        'Network.getAllCookies'
      )
      if (!isArray(response.cookies)) return []

      return response.cookies
        .map((cookie) => normalizeNetworkCookie(cookie))
        .filter(isNotNull)
    }

    const url = this.currentUrl.trim()
    const response = await this.options.transport.send<CdpNetworkGetCookiesResponse>(
      'Network.getCookies',
      url ? { urls: [url] } : {}
    )
    if (!isArray(response.cookies)) return []

    return response.cookies
      .map((cookie) => normalizeNetworkCookie(cookie))
      .filter(isNotNull)
  }

  public async readStorageOrigins(
    options: BrowserPageDriverStorageOriginOptions
  ): Promise<BrowserOriginStorage[]> {
    const includeLocalStorage = options.includeLocalStorage ?? true
    const includeSessionStorage = options.includeSessionStorage ?? true
    if (!includeLocalStorage && !includeSessionStorage) return []

    const frameTree = await this.options.transport.send<CdpPageGetFrameTreeResponse>('Page.getFrameTree')
    const origins = this.collectFrameOrigins(frameTree.frameTree)
    if (isEmpty(origins)) return []

    await this.options.transport.send('DOMStorage.enable')
    const limit = clampPositiveInteger(options.limit, 100)
    const maxValueChars = clampPositiveInteger(options.maxValueChars, 4_000)
    const result: BrowserOriginStorage[] = []

    for (const origin of origins) {
      const entry: BrowserOriginStorage = { origin }
      if (includeLocalStorage) {
        entry.localStorage = await this.readDomStorageItems({
          origin,
          isLocalStorage: true,
          limit,
          maxValueChars,
        })
      }
      if (includeSessionStorage) {
        entry.sessionStorage = await this.readDomStorageItems({
          origin,
          isLocalStorage: false,
          limit,
          maxValueChars,
        })
      }
      result.push(entry)
    }

    return result
  }

  public getURL(): string {
    return this.currentUrl
  }

  public getTitle(): string {
    return this.currentTitle
  }

  public isDestroyed(): boolean {
    return this.destroyed
  }

  private normalizeTargetListPayload(payload: unknown): BrowserPageTargetInfo[] {
    if (!isArray(payload)) return []

    return payload
      .map((entry) => this.normalizeTargetListEntry(entry))
      .filter(isNotNull)
  }

  private async findPageTargetDescription(targetId: string): Promise<CdpPageTargetDescription> {
    const targetListUrl = this.options.targetListUrl?.trim()
    if (!targetListUrl) {
      throw new AppError('VALIDATION', '当前 CDP driver 没有 target list URL，无法切换 page target。')
    }

    const targetFetch = this.options.fetch ?? globalThis.fetch
    if (!targetFetch) {
      throw new AppError('EXECUTION_FAILED', '当前运行时没有 fetch 能力，无法读取 CDP target list。')
    }

    const response = await targetFetch(targetListUrl)
    if (!response.ok) {
      throw new AppError(
        'EXECUTION_FAILED',
        `CDP target list 读取失败：${response.status} ${response.statusText}`
      )
    }

    const payload = await response.json()
    if (!isArray(payload)) {
      throw new AppError('EXECUTION_FAILED', 'CDP target list 返回值不是数组。')
    }

    const target = payload
      .map((entry) => normalizePageTargetDescription(entry))
      .find((entry): entry is CdpPageTargetDescription => entry?.id === targetId)
    if (!target) throw new AppError('NOT_FOUND', `CDP page target 不存在：${targetId}`)

    return target
  }

  private normalizeTargetListEntry(entry: unknown): Nullable<BrowserPageTargetInfo> {
    if (!isObject(entry)) return null

    const target = entry as CdpTargetListEntry
    if (target.type !== 'page') return null

    const id = resolveTargetListEntryId(target)
    if (!id) return null

    const url = isString(target.url) ? target.url : ''
    const title = isString(target.title) ? target.title : ''
    const activeTargetId = this.options.activeTargetId?.trim()

    return {
      id,
      type: 'page',
      url,
      title,
      active: activeTargetId ? id === activeTargetId : url === this.currentUrl,
    }
  }

  

  

  private buildCurrentPageTarget(): BrowserPageTargetInfo {
    return {
      id: this.options.activeTargetId?.trim() || 'current',
      type: 'page',
      url: this.currentUrl,
      title: this.currentTitle,
      active: true,
    }
  }

  private async resumeTargetIfWaitingForDebugger(): Promise<void> {
    try {
      await this.options.transport.send('Runtime.runIfWaitingForDebugger')
    } catch (error) {
      this.appendDiagnostic({
        kind: 'network',
        level: 'debug',
        message: 'CDP 调试等待恢复命令不可用，已继续连接。',
        url: toNullable(this.currentUrl),
        line: null,
        column: null,
        code: null,
        capturedAt: Date.now(),
        details: {
          command: 'Runtime.runIfWaitingForDebugger',
          error: AppError.from(error).message,
        },
      })
    }
  }

  public dispose(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.traceCollector) {
      void this.traceCollector.abort()
      this.traceCollector = null
    }
    if (this.screencastRecorder) {
      void this.screencastRecorder.abort()
      this.screencastRecorder = null
    }
    for (const unsubscribe of this.eventUnsubscribers) {
      unsubscribe()
    }
    this.eventUnsubscribers.splice(0, this.eventUnsubscribers.length)
    this.downloadListeners.clear()
    this.downloads.clear()
    this.networkController.reset()
    const disposable = this.options.transport as CdpBrowserPageDriverTransport & {
      dispose?: () => void
    }
    disposable.dispose?.()
    this.options.onDispose?.()
  }

  

  private subscribeToDiagnosticsEvents(): void {
    if (!this.options.transport.onEvent) return

    const unsubscribeConsole = this.options.transport.onEvent<CdpRuntimeConsoleAPICalledEvent>(
      'Runtime.consoleAPICalled',
      (event) => this.recordConsoleDiagnostic(event)
    )
    const unsubscribeException = this.options.transport.onEvent<CdpRuntimeExceptionThrownEvent>(
      'Runtime.exceptionThrown',
      (event) => this.recordPageExceptionDiagnostic(event)
    )

    this.eventUnsubscribers.push(unsubscribeConsole)
    this.eventUnsubscribers.push(unsubscribeException)
    void this.options.transport.send('Runtime.enable').catch((error) => {
      this.appendDiagnostic({
        kind: 'console',
        level: 'warning',
        message: 'CDP 页面诊断事件初始化失败。',
        url: toNullable(this.currentUrl),
        line: null,
        column: null,
        code: null,
        capturedAt: Date.now(),
        details: { error: AppError.from(error).message },
      })
    })
  }

  private subscribeToDownloadEvents(): void {
    const downloadPath = this.options.downloadPath?.trim()
    if (!downloadPath || !this.options.transport.onEvent) return

    this.eventUnsubscribers.push(
      this.options.transport.onEvent<CdpDownloadWillBeginEvent>(
        'Browser.downloadWillBegin',
        (event) => this.recordDownloadWillBegin(event)
      ),
      this.options.transport.onEvent<CdpDownloadProgressEvent>(
        'Browser.downloadProgress',
        (event) => this.recordDownloadProgress(event)
      ),
      this.options.transport.onEvent<CdpDownloadWillBeginEvent>(
        'Page.downloadWillBegin',
        (event) => this.recordDownloadWillBegin(event)
      ),
      this.options.transport.onEvent<CdpDownloadProgressEvent>(
        'Page.downloadProgress',
        (event) => this.recordDownloadProgress(event)
      )
    )

    void this.options.transport
      .send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath,
        eventsEnabled: true,
      })
      .catch((error) => {
        this.appendDiagnostic({
          kind: 'download',
          level: 'warning',
          message: 'CDP 下载事件初始化失败。',
          url: toNullable(this.currentUrl),
          line: null,
          column: null,
          code: null,
          capturedAt: Date.now(),
          details: {
            error: AppError.from(error).message,
          },
        })
      })
  }

  private subscribeToNetworkEvents(): void {
    if (!this.options.transport.onEvent) return

    // 网络/Fetch 事件统一路由进共享控制器(与嵌入式 webview 同一套记账/拦截逻辑)。
    const routeToController = (method: string) => (event: unknown) =>
      this.networkController.handleCdpEvent(method, event)
    this.eventUnsubscribers.push(
      this.options.transport.onEvent('Network.requestWillBeSent', routeToController('Network.requestWillBeSent')),
      this.options.transport.onEvent('Network.responseReceived', routeToController('Network.responseReceived')),
      this.options.transport.onEvent('Network.loadingFinished', routeToController('Network.loadingFinished')),
      this.options.transport.onEvent('Network.loadingFailed', routeToController('Network.loadingFailed')),
      this.options.transport.onEvent('Fetch.requestPaused', routeToController('Fetch.requestPaused'))
    )

    void this.networkController.enableNetworkCapture().catch((error) => {
      this.appendDiagnostic({
        kind: 'network',
        level: 'warning',
        message: 'CDP 网络事件初始化失败。',
        url: toNullable(this.currentUrl),
        line: null,
        column: null,
        code: null,
        capturedAt: Date.now(),
        details: {
          error: AppError.from(error).message,
        },
      })
    })
  }

  private subscribeToDialogEvents(): void {
    const unsubscribeDialog = this.options.transport.onEvent?.<CdpJavascriptDialogOpeningEvent>(
      'Page.javascriptDialogOpening',
      (event) => this.handleJavascriptDialogOpening(event)
    )
    if (!unsubscribeDialog) return

    this.eventUnsubscribers.push(unsubscribeDialog)
    void this.options.transport.send('Page.enable').catch((error) => {
      this.appendDiagnostic({
        kind: 'dialog',
        level: 'warning',
        message: 'CDP 对话框事件初始化失败。',
        url: toNullable(this.currentUrl),
        line: null,
        column: null,
        code: null,
        capturedAt: Date.now(),
        details: {
          error: AppError.from(error).message,
        },
      })
    })
  }

  private handleJavascriptDialogOpening(event: CdpJavascriptDialogOpeningEvent): void {
    const type = isString(event.type) ? event.type : ''
    if (type !== 'alert' && type !== 'beforeunload') return

    const message = isString(event.message) ? event.message : ''
    const url = isString(event.url) ? event.url : toNullable(this.currentUrl)
    void this.options.transport
      .send('Page.handleJavaScriptDialog', { accept: true })
      .then(() => {
        this.appendDiagnostic({
          kind: 'dialog',
          level: 'info',
          message: `CDP 自动接受 ${type} 对话框。`,
          url,
          line: null,
          column: null,
          code: null,
          capturedAt: Date.now(),
          details: {
            type,
            message,
            autoAccepted: true,
          },
        })
      })
      .catch((error) => {
        this.appendDiagnostic({
          kind: 'dialog',
          level: 'warning',
          message: `CDP 自动接受 ${type} 对话框失败。`,
          url,
          line: null,
          column: null,
          code: null,
          capturedAt: Date.now(),
          details: {
            type,
            message,
            autoAccepted: false,
            error: AppError.from(error).message,
          },
        })
      })
  }

  private recordDownloadWillBegin(event: CdpDownloadWillBeginEvent): void {
    const downloadPath = this.options.downloadPath?.trim()
    if (!downloadPath || !isNonBlankString(event.guid)) return

    const url = isNonBlankString(event.url) ? event.url : toNullable(this.currentUrl)
    const filename = isNonBlankString(event.suggestedFilename)
      ? event.suggestedFilename
      : event.guid
    const item = new CdpBrowserPageDownloadItem({
      transport: this.options.transport,
      guid: event.guid,
      url,
      filename,
      downloadPath,
      appendDiagnostic: (entry) => this.appendDiagnostic(entry),
    })
    this.downloads.set(event.guid, item)
    this.appendDiagnostic({
      kind: 'download',
      level: 'info',
      message: `页面下载等待处理：${filename}`,
      url,
      line: null,
      column: null,
      code: null,
      capturedAt: Date.now(),
      details: {
        guid: event.guid,
        filename,
        pending: true,
      },
    })
    this.emitDownload({
      url,
      item,
    })
  }

  private recordDownloadProgress(event: CdpDownloadProgressEvent): void {
    if (!isNonBlankString(event.guid)) return

    const item = this.downloads.get(event.guid)
    if (!item) return

    const state = item.updateProgress(event)
    if (!state) return

    this.downloads.delete(event.guid)
    this.appendDiagnostic({
      kind: 'download',
      level: state === 'completed' ? 'info' : 'warning',
      message: `页面下载${state === 'completed' ? '完成' : '取消'}：${item.getFilename()}`,
      url: item.getURL(),
      line: null,
      column: null,
      code: null,
      capturedAt: Date.now(),
      details: {
        guid: event.guid,
        filename: item.getFilename(),
        totalBytes: item.getTotalBytes(),
        receivedBytes: item.getReceivedBytes(),
        savePath: item.getSavePath() || null,
        state,
        pending: false,
      },
    })
  }

  private emitDownload(event: BrowserPageDriverDownloadEvent): void {
    for (const listener of this.downloadListeners) {
      listener(event)
    }
  }

  private recordConsoleDiagnostic(event: CdpRuntimeConsoleAPICalledEvent): void {
    const source = readConsoleSource(event.stackTrace)
    this.appendDiagnostic({
      kind: 'console',
      level: resolveConsoleLevel(event.type),
      message: resolveConsoleMessage(event.args),
      url: source.url ?? toNullable(this.currentUrl),
      line: source.line,
      column: source.column,
      code: null,
      capturedAt: resolveConsoleTimestamp(event.timestamp),
      details: {
        type: isString(event.type) ? event.type : 'console',
      },
    })
  }

  private recordPageExceptionDiagnostic(event: CdpRuntimeExceptionThrownEvent): void {
    if (!isObject(event.exceptionDetails)) return

    const details = event.exceptionDetails as CdpRuntimeExceptionDetails
    const exception = isObject(details.exception)
      ? (details.exception as CdpRuntimeRemoteObject)
      : null
    const message = isNonBlankString(exception?.description)
      ? exception.description
      : isNonBlankString(details.text)
        ? details.text
        : 'page exception'
    const diagnosticDetails: Record<string, unknown> = {}
    if (isString(details.text)) diagnosticDetails.text = details.text
    if (isString(exception?.type)) diagnosticDetails.exceptionType = exception.type

    this.appendDiagnostic({
      kind: 'page-error',
      level: 'error',
      message,
      url: isNonBlankString(details.url) ? details.url : toNullable(this.currentUrl),
      line: isFiniteNumber(details.lineNumber) ? Math.round(details.lineNumber) + 1 : null,
      column: isFiniteNumber(details.columnNumber) ? Math.round(details.columnNumber) + 1 : null,
      code: null,
      capturedAt: resolveConsoleTimestamp(event.timestamp),
      details: diagnosticDetails,
    })
  }

  private appendDiagnostic(entry: BrowserPageDiagnosticEntry): void {
    this.diagnostics.push(entry)
    if (this.diagnostics.length > BrowserTuning.cdp.diagnosticEntries) {
      this.diagnostics.splice(0, this.diagnostics.length - BrowserTuning.cdp.diagnosticEntries)
    }
  }

  

  

  

  

  

  private collectFrameOrigins(frameTree: unknown): string[] {
    const origins: string[] = []
    const seen = new Set<string>()
    const visit = (entry: unknown): void => {
      if (!isObject(entry)) return

      const tree = entry as CdpPageFrameTree
      const frame = isObject(tree.frame) ? tree.frame as CdpPageFrame : null
      const origin = this.parseFrameOrigin(frame?.url)
      if (origin && !seen.has(origin)) {
        seen.add(origin)
        origins.push(origin)
      }

      if (!isArray(tree.childFrames)) return
      for (const child of tree.childFrames) {
        visit(child)
      }
    }

    visit(frameTree)
    return origins
  }

  private parseFrameOrigin(url: unknown): Nullable<string> {
    if (!isNonBlankString(url)) return null

    try {
      const origin = new URL(url).origin
      return origin && origin !== 'null' ? origin : null
    } catch (error) {
      this.appendDiagnostic({
        kind: 'storage',
        level: 'debug',
        message: 'CDP frame URL origin 解析失败。',
        url: toNullable(this.currentUrl),
        line: null,
        column: null,
        code: null,
        capturedAt: Date.now(),
        details: {
          frameUrl: url,
          error: AppError.from(error).message,
        },
      })
      return null
    }
  }

  private async readDomStorageItems(options: {
    origin: string
    isLocalStorage: boolean
    limit: number
    maxValueChars: number
  }): Promise<BrowserStorageEntry[]> {
    try {
      const response = await this.options.transport.send<CdpDomStorageItemsResponse>(
        'DOMStorage.getDOMStorageItems',
        {
          storageId: {
            securityOrigin: options.origin,
            isLocalStorage: options.isLocalStorage,
          },
        }
      )
      if (!isArray(response.entries)) return []

      return response.entries
        .map((entry) => normalizeDomStorageEntry(entry, options.maxValueChars))
        .filter(isNotNull)
        .slice(0, options.limit)
    } catch (error) {
      this.appendDiagnostic({
        kind: 'storage',
        level: 'warning',
        message: `CDP DOMStorage 读取失败：${options.origin}`,
        url: toNullable(this.currentUrl),
        line: null,
        column: null,
        code: null,
        capturedAt: Date.now(),
        details: {
          origin: options.origin,
          storage: options.isLocalStorage ? 'localStorage' : 'sessionStorage',
          error: AppError.from(error).message,
        },
      })
      return []
    }
  }

  

  

  

  

  

  

  

  private updateCachedPageState(value: unknown): void {
    if (!isObject(value)) return

    const record = value as { url?: unknown; title?: unknown }
    if (isNonBlankString(record.url)) {
      this.currentUrl = record.url
    }
    if (isString(record.title)) {
      this.currentTitle = record.title
    }
  }

  private async resolveScreenshotInput(
    options: BrowserPageDriverScreenshotOptions
  ): Promise<{
    params: Record<string, unknown>
    capture: BrowserPageDriverScreenshot['capture']
  }> {
    if (options.mode === 'full-page') return this.resolveFullPageScreenshotInput(options)
    if (options.mode === 'region' && options.clip) return resolveRegionScreenshotInput(options)

    return {
      params: {
        format: 'png',
        fromSurface: true,
      },
      capture: {
        mode: 'viewport',
        coordinateSpace: 'page-css-px',
        x: Math.max(0, Math.round(options.metadata.scrollX)),
        y: Math.max(0, Math.round(options.metadata.scrollY)),
        width: Math.max(1, Math.round(options.metadata.viewportWidth)),
        height: Math.max(1, Math.round(options.metadata.viewportHeight)),
        documentWidth: Math.max(1, Math.round(options.metadata.documentWidth)),
        documentHeight: Math.max(1, Math.round(options.metadata.documentHeight)),
        viewport: buildViewportRect(options),
        clipped: false,
      },
    }
  }

  private async resolveFullPageScreenshotInput(
    options: BrowserPageDriverScreenshotOptions
  ): Promise<{
    params: Record<string, unknown>
    capture: BrowserPageDriverScreenshot['capture']
  }> {
    const metrics = await this.options.transport.send<CdpLayoutMetricsResponse>(
      'Page.getLayoutMetrics'
    )
    const content = metrics.cssContentSize ?? metrics.contentSize
    const documentWidth = clampPositiveInteger(content?.width, options.metadata.documentWidth)
    const documentHeight = clampPositiveInteger(
      content?.height,
      options.metadata.documentHeight
    )
    const captureWidth = Math.min(
      documentWidth,
      clampPositiveInteger(options.maxWidth, documentWidth)
    )
    const captureHeight = Math.min(
      documentHeight,
      clampPositiveInteger(options.maxHeight, documentHeight)
    )

    return {
      params: {
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
      },
      capture: {
        mode: 'full-page',
        coordinateSpace: 'page-css-px',
        x: 0,
        y: 0,
        width: captureWidth,
        height: captureHeight,
        documentWidth,
        documentHeight,
        viewport: buildViewportRect(options),
        clipped: captureWidth < documentWidth || captureHeight < documentHeight,
      },
    }
  }

  

  

  

  

  

  

  

  

  

  

  

  
}

export { CdpBrowserPageDriver }
