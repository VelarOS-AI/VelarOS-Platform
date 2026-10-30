// 域：外部 Chrome 页面的驱动——纯 CDP 实现的 `BrowserPageDriver`。
//
// **为什么需要这份导览**：本文件是「一个 CDP target = 一个 driver 实例」这条不变量的载体，
// 同时承载订阅生命周期、下载状态机、对话框拦截与诊断缓冲四条独立时序。任一条单独读都会得出
// 错误结论——最典型的是以为 `switchPageTarget` 在切换当前实例，实际它新建了一个。
//
// ## 两份实现、一条接口
// `BrowserPageDriver` 有两个实现：本文件（外部浏览器：共用的浏览器级 CDP 连接上这一页的 flatten 会话）与
// `runtime/ElectronWebContentsBrowserPageDriver`（内嵌 WebContents，`webContents.debugger`）。
// 上层 engine 只认接口，**新增页面能力必须两边都落**，否则外部/内嵌两种浏览器行为分叉。
//
// ## 生命周期与不变量（改这些会破什么）
//  - **实例绑定 target，不可重绑**：`switchPageTarget` **返回一个新 driver**（经标签页目录在新 target 上
//    另挂一条会话），不是把自己指向新页面。理由：事件订阅、下载表、诊断缓冲全是 per-target 状态，
//    就地重绑必然残留上一个 target 的事件。调用方必须替换自己持有的引用。
//  - **标签页目录是唯一的找页面入口**：列标签页、切过去、给模型单开会话都经 `targets`（浏览器级连接上的
//    Target 域），不碰 HTTP 的 /json 端点——用户放进来的 Chrome 只开浏览器级 WebSocket。
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
  isEmpty,
  isFiniteNumber,
  isNonBlankString,
  isNotNull,
  isObject,
  isString,
  isTrue,
  Log,
  optionalWhen,
  toNullable,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { BrowserErrorCodes } from '../../contract/constants.js'
import type { BrowserPageDriver, BrowserProtocolChannel } from '../../contract/requires.js'
import type {
  BrowserFrameInfo,
  BrowserInsertTextOptions,
  BrowserNetworkControlOptions,
  BrowserNetworkRequestDetailsOptions,
  BrowserNetworkResponseBodyOptions,
  BrowserPageDiagnosticEntry,
  BrowserPageTargetInfo,
  BrowserSwitchPageTargetOptions,
  BrowserViewportOptions,
} from '../../types/browser.js'
import type {
  CdpBrowserPageDriverTransport,
  CdpCaptureScreenshotResponse,
  CdpDomDocumentResponse,
  CdpDomQuerySelectorResponse,
  CdpDownloadProgressEvent,
  CdpDownloadWillBeginEvent,
  CdpFetchResourcePayload,
  CdpJavascriptDialogOpeningEvent,
  CdpLayoutMetricsResponse,
  CdpPageTarget,
  CdpPrintToPdfResponse,
  CdpRuntimeConsoleAPICalledEvent,
  CdpRuntimeEvaluateResponse,
  CdpRuntimeExceptionDetails,
  CdpRuntimeExceptionThrownEvent,
  CdpRuntimeRemoteObject,
  CdpScreencastConsumerOptions,
  CdpScreencastStartOptions,
  ScreencastCapturedFrame,
} from '../../types/cdp.js'
import type {
  BrowserPageDriverClickCoordinatesOptions,
  BrowserPageDriverDiagnosticsOptions,
  BrowserPageDriverDownloadEvent,
  BrowserPageDriverDownloadListener,
  BrowserPageDriverDragCoordinatesOptions,
  BrowserPageDriverFetchResourceOptions,
  BrowserPageDriverFetchResourceResult,
  BrowserPageDriverFileInputOptions,
  BrowserPageDriverKeyEvent,
  BrowserPageDriverMouseEvent,
  BrowserPageDriverMoveMouseOptions,
  BrowserPageDriverNetworkControlState,
  BrowserPageDriverNetworkIdleOptions,
  BrowserPageDriverNetworkRequestDetailsResult,
  BrowserPageDriverNetworkResponseBodyResult,
  BrowserPageDriverPdfOptions,
  BrowserPageDriverScreenshot,
  BrowserPageDriverScreenshotOptions,
  BrowserPageDriverState,
} from '../../types/driver'
import {
  buildFetchResourceScript,
  buildViewportRect,
  readConsoleSource,
  readNodeId,
  readRuntimeEvaluateValue,
  resolveConsoleLevel,
  resolveConsoleTimestamp,
  resolveMouseButton,
} from '../../utils/cdp/driver'
import { resolveConsoleMessage, resolveRegionScreenshotInput } from '../../utils/cdp/driver'
import { captureCdpHeapSnapshot } from '../../utils/cdp/tracing.js'
import {
  clearBrowserDiagnosticEntries,
  takeBrowserDiagnosticWindow,
} from '../../utils/diagnostics.js'
import { clampPositiveInteger, clampZoomFactor } from '../../utils/numbers.js'
import { BrowserTuning } from '../../utils/tuning'
import { buildBrowserViewportDeviceMetrics } from '../../utils/viewport'

import { BrowserCdpNetworkController } from './BrowserCdpNetworkController'
import { CdpBrowserPageDownloadItem } from './CdpBrowserPageDownloadItem.js'
import { CdpFrameSessions } from './CdpFrameSessions'
import { CdpProtocolChannel } from './CdpProtocolChannel'
import { CdpScreencastRecorder } from './CdpScreencastRecorder'
import { CdpTraceCollector } from './CdpTraceCollector'
import type { CdpWebSocketTransportApi } from './CdpWebSocketTransport'

/** 页面驱动所在浏览器的标签页目录：驱动挂在哪一页、还能切到哪些页、怎么在某一页上另挂一条会话。 */
export interface CdpBrowserPageDriverTargets {
  /** 驱动自己挂着的那一页。 */
  targetId: string
  /** 列出能切过去的标签页。 */
  list(): Promise<CdpPageTarget[]>
  /** 在一个标签页上另挂一条会话，交回它的传输；timeoutMs 是这条会话上单条命令等回包的毫秒数。 */
  attach(
    targetId: string,
    options?: { timeoutMs?: LooseOptional<number> }
  ): Promise<CdpWebSocketTransportApi>
}

/** 建一个外部浏览器页面驱动的参数。 */
export interface CdpBrowserPageDriverOptions {
  /** 这一页的 CDP 传输：命令、事件与关闭都经它，驱动释放时一并释放。 */
  transport: CdpBrowserPageDriverTransport
  /** 这一页眼下的地址（影子状态的初值）。 */
  initialUrl?: LooseOptional<string>
  /** 这一页眼下的标题。 */
  initialTitle?: LooseOptional<string>
  /** 浏览器把下载先落在哪个目录（整个浏览器的下载行为由拥有浏览器的一方设好）；不给就不接管下载。 */
  downloadPath?: LooseOptional<string>
  /** 所在浏览器的标签页目录；不给就只认这一页：列标签页只有它、切不走、开不了模型的单独会话。 */
  targets?: LooseOptional<CdpBrowserPageDriverTargets>
  /** 驱动释放时回调。 */
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
  private traceCollector: Nullable<CdpTraceCollector> = null
  private screencastRecorder: Nullable<CdpScreencastRecorder> = null
  private destroyed = false
  /** 框架树与在子框架里跑脚本，含跨进程的 iframe（第一次要框架时才在这条连接上挂子会话）。 */
  private readonly frameSessions: CdpFrameSessions
  /** 网络子系统共享控制器:记账 / 详情读取 / Fetch 拦截,与嵌入式 webview 共用同一套逻辑。 */
  private readonly networkController = new BrowserCdpNetworkController({
    send: (method, params) => this.options.transport.send(method, params),
    appendDiagnostic: (entry) => this.appendDiagnostic(entry),
    getCurrentUrl: () => this.currentUrl,
  })

  constructor(private readonly options: CdpBrowserPageDriverOptions) {
    this.currentUrl = options.initialUrl?.trim() || ''
    this.currentTitle = options.initialTitle?.trim() || ''
    this.frameSessions = new CdpFrameSessions(options.transport)
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

    const value = readRuntimeEvaluateValue(response)
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
    const targets = this.options.targets
    if (!targets) return [this.buildCurrentPageTarget()]

    const pages = await targets.list()
    if (!pages.at(0)) return [this.buildCurrentPageTarget()]

    return pages.map((page) => ({
      id: page.targetId,
      type: 'page',
      url: page.url,
      title: page.title,
      active: page.targetId === targets.targetId,
    }))
  }

  /** 切到同一个浏览器里的另一页：经标签页目录在那一页上另挂一条会话，交回挂在它上面的新驱动（目录沿用，换成那一页）。 */
  public async switchPageTarget(
    options: BrowserSwitchPageTargetOptions
  ): Promise<BrowserPageDriver> {
    const targetId = options.targetId.trim()
    if (!targetId) throw new AppError('VALIDATION', 'CDP page target id 不能为空。')

    const targets = this.options.targets
    if (!targets)
      throw new AppError(
        'VALIDATION',
        '这个外部浏览器驱动没有标签页目录，只认它自己这一页，切不到别的标签页。'
      )
    if (targetId === targets.targetId) return this

    const target = await this.findPageTarget(targetId)
    const driver = new CdpBrowserPageDriver({
      transport: await targets.attach(targetId),
      initialUrl: target.url,
      initialTitle: target.title,
      downloadPath: this.options.downloadPath,
      targets: {
        targetId,
        list: () => targets.list(),
        attach: (id, attachOptions) => targets.attach(id, attachOptions),
      },
    })
    await driver.resumeTargetIfWaitingForDebugger()
    return driver
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

  public async insertText(options: BrowserInsertTextOptions): Promise<void> {
    await this.options.transport.send('Input.insertText', {
      text: options.text,
    })
  }

  public async dispatchKeyEvent(event: BrowserPageDriverKeyEvent): Promise<void> {
    await this.options.transport.send('Input.dispatchKeyEvent', { ...event })
  }

  public async dispatchMouseEvent(event: BrowserPageDriverMouseEvent): Promise<void> {
    await this.options.transport.send('Input.dispatchMouseEvent', { ...event })
  }

  public async listFrames(): Promise<BrowserFrameInfo[]> {
    return (await this.frameSessions.listFrames()).map((frame) => frame.info)
  }

  /**
   * 在一个框架里跑脚本，框架自己的主世界（与内嵌页面同一口径）：顶层页面就是 executeJavaScript；子框架与跨进程的 iframe 交给 {@link CdpFrameSessions}。
   */
  public async executeJavaScriptInFrame<T = unknown>(
    frameId: string,
    script: string,
    userGesture?: boolean
  ): Promise<T> {
    const frame = (await this.frameSessions.listFrames()).find(
      (candidate) => candidate.info.id === frameId
    )
    if (!frame)
      throw new AppError(
        BrowserErrorCodes.frameNotFound,
        `框架 ${frameId} 不在当前页面的框架树里（页面跳转之后旧 id 作废）：重新 frames()。`
      )
    if (!frame.info.parentId) return this.executeJavaScript<T>(script, userGesture)
    return (await this.frameSessions.evaluateInFrame(frame, script, !!userGesture)) as T
  }

  /** 给模型单开一条 CDP 会话：同一条浏览器连接上、挂到这一页的第二条会话。 */
  public async openProtocolChannel(): Promise<BrowserProtocolChannel> {
    const targets = this.options.targets
    if (!targets)
      throw new AppError(
        'VALIDATION',
        '这个外部浏览器驱动不知道自己挂在哪个标签页上，开不了单独的 CDP 会话。'
      )
    return new CdpProtocolChannel(
      await targets.attach(targets.targetId, { timeoutMs: BrowserTuning.protocol.commandTimeoutMs })
    )
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

  public async clickCoordinates(options: BrowserPageDriverClickCoordinatesOptions): Promise<void> {
    const x = Math.round(options.x)
    const y = Math.round(options.y)
    const button = resolveMouseButton(options.button ?? 'left')
    const clickCount = clampPositiveInteger(options.clickCount, 1)

    const modifiers = options.modifiers ?? 0
    await this.options.transport.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      clickCount,
      modifiers,
    })
    options.onPointerEvent?.({ x, y, phase: 'down', button: options.button ?? 'left' })
    await this.options.transport.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      clickCount,
      modifiers,
    })
    options.onPointerEvent?.({ x, y, phase: 'up', button: options.button ?? 'left' })
  }

  public async dragCoordinates(options: BrowserPageDriverDragCoordinatesOptions): Promise<void> {
    const startX = Math.round(options.startX)
    const startY = Math.round(options.startY)
    const endX = Math.round(options.endX)
    const endY = Math.round(options.endY)
    const steps = clampPositiveInteger(options.steps, 10)
    const modifiers = options.modifiers ?? 0

    await this.options.transport.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX,
      y: startY,
      modifiers,
    })
    options.onPointerEvent?.({ x: startX, y: startY, phase: 'move' })
    await this.options.transport.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: startX,
      y: startY,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      modifiers,
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
        modifiers,
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
      modifiers,
    })
    options.onPointerEvent?.({ x: endX, y: endY, phase: 'up', button: 'left' })
  }

  public async setViewport(options: BrowserViewportOptions): Promise<void> {
    const metrics = buildBrowserViewportDeviceMetrics(options)
    // 外部窗口按真实内容区设置尺寸，避免设备模拟视口被工具栏和系统边框裁掉。
    // 无窗口的远端/旧版浏览器仍可进行设备模拟，明确记录窗口适配失败。
    if (this.options.targets) {
      try {
        const window = await this.options.transport.send<{ windowId?: number }>(
          'Browser.getWindowForTarget',
          { targetId: this.options.targets.targetId }
        )
        if (isFiniteNumber(window.windowId))
          await this.options.transport.send('Browser.setContentsSize', {
            windowId: window.windowId,
            width: metrics.width,
            height: metrics.height,
          })
      } catch (error) {
        Log.tag('CdpBrowserPageDriver').debug('外部窗口内容区无法适配，保留设备模拟视口', {
          error: AppError.getMessage(error),
        })
      }
    }
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
    const normalizedZoomFactor = clampZoomFactor(zoomFactor, 1)
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

  public async waitForNetworkIdle(options: BrowserPageDriverNetworkIdleOptions): Promise<boolean> {
    return this.networkController.waitForNetworkIdle(options)
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

  public readDiagnostics(
    options: BrowserPageDriverDiagnosticsOptions
  ): BrowserPageDiagnosticEntry[] {
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

  public getURL(): string {
    return this.currentUrl
  }

  public getTitle(): string {
    return this.currentTitle
  }

  public isDestroyed(): boolean {
    return this.destroyed
  }

  /** 在标签页目录里找一页；不在（关了、不在这个浏览器上下文里）抛 NOT_FOUND。 */
  private async findPageTarget(targetId: string): Promise<CdpPageTarget> {
    const pages = (await this.options.targets?.list()) ?? []
    const target = pages.find((entry) => entry.targetId === targetId)
    if (!target) throw new AppError('NOT_FOUND', `CDP page target 不存在：${targetId}`)

    return target
  }

  private buildCurrentPageTarget(): BrowserPageTargetInfo {
    return {
      id: this.options.targets?.targetId || 'current',
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
    this.frameSessions.dispose()
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

  /**
   * 接管下载：浏览器把下载按 guid 落进 downloadPath（整个浏览器的下载行为由拥有浏览器的一方在浏览器级会话上设好，
   * 不在这条会话上设——设它的会话一脱开，Chrome 就把整个上下文的下载行为复原）。这一页的下载经 Page.download* 事件来；
   * 某条会话自己开了 Browser 级下载事件时同一个下载会报两遍，按 guid 只认一次。
   */
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
      this.options.transport.onEvent<CdpDownloadWillBeginEvent>('Page.downloadWillBegin', (event) =>
        this.recordDownloadWillBegin(event)
      ),
      this.options.transport.onEvent<CdpDownloadProgressEvent>('Page.downloadProgress', (event) =>
        this.recordDownloadProgress(event)
      )
    )
  }

  private subscribeToNetworkEvents(): void {
    if (!this.options.transport.onEvent) return

    // 网络/Fetch 事件统一路由进共享控制器(与嵌入式 webview 同一套记账/拦截逻辑)。
    const routeToController = (method: string) => (event: unknown) =>
      this.networkController.handleCdpEvent(method, event)
    this.eventUnsubscribers.push(
      this.options.transport.onEvent(
        'Network.requestWillBeSent',
        routeToController('Network.requestWillBeSent')
      ),
      this.options.transport.onEvent(
        'Network.responseReceived',
        routeToController('Network.responseReceived')
      ),
      this.options.transport.onEvent(
        'Network.loadingFinished',
        routeToController('Network.loadingFinished')
      ),
      this.options.transport.onEvent(
        'Network.loadingFailed',
        routeToController('Network.loadingFailed')
      ),
      this.options.transport.onEvent(
        'Fetch.requestPaused',
        routeToController('Fetch.requestPaused')
      )
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
    if (!downloadPath || !isNonBlankString(event.guid) || this.downloads.has(event.guid)) return

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

  private async resolveScreenshotInput(options: BrowserPageDriverScreenshotOptions): Promise<{
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
    const metrics =
      await this.options.transport.send<CdpLayoutMetricsResponse>('Page.getLayoutMetrics')
    const content = metrics.cssContentSize ?? metrics.contentSize
    const documentWidth = clampPositiveInteger(content?.width, options.metadata.documentWidth)
    const documentHeight = clampPositiveInteger(content?.height, options.metadata.documentHeight)
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
