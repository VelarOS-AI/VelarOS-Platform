import type electron from 'electron'

import { isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import type { BrowserEmulationOptions, BrowserMouseButton, BrowserNetworkControlOptions, BrowserNetworkRequestDetailsOptions, BrowserNetworkResponseBodyOptions, BrowserPageDiagnosticEntry, BrowserViewportOptions } from '../core'
import {
  applyCdpEmulation,
  BrowserCdpNetworkController,
  type BrowserPageDriver,
  type BrowserPageDriverClickCoordinatesOptions,
  type BrowserPageDriverDiagnosticsOptions,
  type BrowserPageDriverDragCoordinatesOptions,
  type BrowserPageDriverEmulationState,
  type BrowserPageDriverMoveMouseOptions,
  type BrowserPageDriverNetworkControlState,
  type BrowserPageDriverNetworkIdleOptions,
  type BrowserPageDriverNetworkRequestDetailsResult,
  type BrowserPageDriverNetworkResponseBodyResult,
  type BrowserPageDriverState,
  captureCdpHeapSnapshot,
  type CdpScreencastConsumerOptions,
  CdpScreencastRecorder,
  type CdpScreencastStartOptions,
  type CdpSend,
  CdpTraceCollector,
  createDefaultCdpEmulationState,
  createWebContentsCdpTraceTransport,
  type ScreencastCapturedFrame,
} from '../core'

export interface BrowserPageDriverFactoryInput {
  sessionId: string
  webContents: electron.WebContents
}

export type BrowserPageDriverFactory = (input: BrowserPageDriverFactoryInput) => BrowserPageDriver

/**
 * 嵌入式页面的 trace 状态。
 *
 * driver 实例按调用临时创建，而录制跨多次工具调用，所以状态挂在 WebContents 上。
 */
const webContentsTraceSessions = new WeakMap<
  electron.WebContents,
  { collector: CdpTraceCollector; detachAfterStop: boolean }
>()

/** 嵌入式页面的录屏状态（同 trace：状态随 WebContents,不随瞬时 driver 实例）。 */
const webContentsScreencastSessions = new WeakMap<
  electron.WebContents,
  { recorder: CdpScreencastRecorder; detachAfterStop: boolean }
>()

/**
 * 嵌入式页面的环境模拟状态。
 *
 * CDP Emulation override 在 debugger detach 后失效,所以模拟一旦配置就需要**持久
 * attach** —— 有此登记项即表示 debugger 由模拟持有,trace/截图等临时操作不得 detach。
 */
const webContentsEmulationHolds = new WeakMap<
  electron.WebContents,
  { state: BrowserPageDriverEmulationState; networkEnabled: boolean }
>()

/**
 * 嵌入式页面的网络采集状态(同 emulation:随 WebContents 持久,不随瞬时 driver 实例)。
 *
 * driver 实例按调用临时创建,而网络记录 / Fetch 拦截规则要跨多次工具调用累积,所以控制器与
 * 诊断缓冲挂在 WebContents 上。采集从首次网络操作起惰性建立(在此之前发生的请求不回填)。
 */
const webContentsNetworkHolds = new WeakMap<
  electron.WebContents,
  {
    controller: BrowserCdpNetworkController
    diagnostics: BrowserPageDiagnosticEntry[]
    messageListener: (event: electron.Event, method: string, params: unknown) => void
  }
>()

/** 嵌入式网络诊断缓冲上限,与外部 CDP driver 的诊断窗口一致。 */
const MaxEmbeddedNetworkDiagnostics = 300

const embeddedDriverLog = logRuntime.tag('ElectronWebContentsBrowserPageDriver')

/** CDP MouseEvent buttons 位掩码：left=1、right=2、middle=4。 */
function cdpMouseButtonsMask(button: BrowserMouseButton): number {
  if (button === 'right') return 2
  if (button === 'middle') return 4
  return 1
}

function clampEmbeddedDiagnosticLimit(value: unknown): number {
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) return 100

  return Math.max(1, Math.min(MaxEmbeddedNetworkDiagnostics, Math.round(numberValue)))
}

class ElectronWebContentsBrowserPageDriver implements BrowserPageDriver {
  public readonly kind = 'webview'

  constructor(private readonly webContents: electron.WebContents) {}

  /** trace/堆快照共用：确保 debugger 已 attach，返回是否由本次调用负责 detach。 */
  private attachDebugger(): boolean {
    const wasAttached = this.webContents.debugger.isAttached()
    if (!wasAttached) {
      this.webContents.debugger.attach('1.3')
    }
    return !wasAttached
  }

  private detachDebugger(shouldDetach: boolean): void {
    if (!shouldDetach || this.webContents.isDestroyed()) return
    // 模拟或网络采集持有 debugger 时,临时操作不得 detach(否则 override / 事件订阅失效)。
    if (webContentsEmulationHolds.has(this.webContents)) return
    if (webContentsNetworkHolds.has(this.webContents)) return
    if (!this.webContents.debugger.isAttached()) return
    try {
      this.webContents.debugger.detach()
    } catch {
      // arch-guard:silent-catch-ok detach 与页面销毁天然竞态：isAttached() 通过到真正 detach 之间
      // 页面可能已经没了。这是清理路径，抛出去没有任何调用方能处理。
    }
  }

  private debuggerSend: CdpSend = (method, params) =>
    this.webContents.debugger.sendCommand(method, params)

  /** 配置环境模拟(CPU/网络节流、色彩、时区、locale、地理位置)。需持久 attach。 */
  public async configureEmulation(
    options: BrowserEmulationOptions
  ): Promise<BrowserPageDriverEmulationState> {
    // 持久 attach:不经 attachDebugger 的临时语义,attach 后由 emulation hold 持有。
    if (!this.webContents.debugger.isAttached()) {
      this.webContents.debugger.attach('1.3')
    }
    let hold = webContentsEmulationHolds.get(this.webContents)
    if (!hold) {
      hold = { state: createDefaultCdpEmulationState(), networkEnabled: false }
      webContentsEmulationHolds.set(this.webContents, hold)
    }
    // Network.emulateNetworkConditions 需要 Network domain;只 enable 一次。
    if (isPresent(options.networkThrottling) && !hold.networkEnabled) {
      await this.debuggerSend('Network.enable')
      hold.networkEnabled = true
    }

    hold.state = await applyCdpEmulation(this.debuggerSend, hold.state, options)
    return hold.state
  }

  public getEmulationState(): BrowserPageDriverEmulationState {
    return webContentsEmulationHolds.get(this.webContents)?.state ?? createDefaultCdpEmulationState()
  }

  /**
   * 惰性建立嵌入式网络采集:持久 attach debugger、登记 message 监听把 Network/Fetch 事件路由进
   * 共享控制器、enable Network domain。采集从首次网络操作起生效,与外部 CDP driver 共用同一套
   * 记账 / 详情读取 / Fetch 拦截逻辑(BrowserCdpNetworkController)。
   */
  private async ensureNetworkHold(): Promise<{
    controller: BrowserCdpNetworkController
    diagnostics: BrowserPageDiagnosticEntry[]
  }> {
    if (!this.webContents.debugger.isAttached()) {
      this.webContents.debugger.attach('1.3')
    }
    const existing = webContentsNetworkHolds.get(this.webContents)
    if (existing) return existing

    const diagnostics: BrowserPageDiagnosticEntry[] = []
    const controller = new BrowserCdpNetworkController({
      send: this.debuggerSend,
      appendDiagnostic: (entry) => {
        diagnostics.push(entry)
        if (diagnostics.length > MaxEmbeddedNetworkDiagnostics) {
          diagnostics.splice(0, diagnostics.length - MaxEmbeddedNetworkDiagnostics)
        }
      },
      getCurrentUrl: () => this.webContents.getURL(),
      getNetworkThrottling: () =>
        webContentsEmulationHolds.get(this.webContents)?.state.networkThrottling ?? 'none',
    })
    const messageListener = (
      _event: electron.Event,
      method: string,
      params: unknown
    ): void => {
      controller.handleCdpEvent(method, params)
    }
    this.webContents.debugger.on('message', messageListener)
    const hold = { controller, diagnostics, messageListener }
    webContentsNetworkHolds.set(this.webContents, hold)
    await controller.enableNetworkCapture()
    return hold
  }

  public async configureNetwork(
    options: BrowserNetworkControlOptions
  ): Promise<BrowserPageDriverNetworkControlState> {
    const hold = await this.ensureNetworkHold()
    return hold.controller.configureNetwork(options)
  }

  public async readNetworkResponseBody(
    options: BrowserNetworkResponseBodyOptions
  ): Promise<BrowserPageDriverNetworkResponseBodyResult> {
    const hold = await this.ensureNetworkHold()
    return hold.controller.readNetworkResponseBody(options)
  }

  public async readNetworkRequestDetails(
    options: BrowserNetworkRequestDetailsOptions
  ): Promise<BrowserPageDriverNetworkRequestDetailsResult> {
    const hold = await this.ensureNetworkHold()
    return hold.controller.readNetworkRequestDetails(options)
  }

  public async waitForNetworkIdle(options: BrowserPageDriverNetworkIdleOptions): Promise<void> {
    const hold = await this.ensureNetworkHold()
    await hold.controller.waitForNetworkIdle(options)
  }

  /**
   * 返回已采集的网络诊断(list_network_events 的嵌入式数据源)。
   * 网络采集未建立时返回空;控制台诊断走 session.diagnostics,由数据引擎合并。
   */
  public readDiagnostics(
    options: BrowserPageDriverDiagnosticsOptions
  ): BrowserPageDiagnosticEntry[] {
    const hold = webContentsNetworkHolds.get(this.webContents)
    if (!hold) return []

    const limit = clampEmbeddedDiagnosticLimit(options.limit)
    const entries = hold.diagnostics.slice(-limit)
    if (options.clear) {
      hold.diagnostics.splice(0, hold.diagnostics.length)
    }
    return entries
  }

  public async startTracing(): Promise<void> {
    if (webContentsTraceSessions.get(this.webContents)?.collector.isRunning()) {
      throw new AppError('VALIDATION', '性能 trace 已在录制中，请先 stop_trace。')
    }

    const detachAfterStop = this.attachDebugger()
    const collector = new CdpTraceCollector(createWebContentsCdpTraceTransport(this.webContents))
    try {
      await collector.start()
    } catch (error) {
      this.detachDebugger(detachAfterStop)
      throw error
    }
    webContentsTraceSessions.set(this.webContents, { collector, detachAfterStop })
  }

  public async stopTracing(): Promise<unknown[]> {
    const session = webContentsTraceSessions.get(this.webContents)
    if (!session) {
      throw new AppError('VALIDATION', '当前没有正在录制的性能 trace。')
    }
    try {
      return await session.collector.stop()
    } finally {
      webContentsTraceSessions.delete(this.webContents)
      this.detachDebugger(session.detachAfterStop)
    }
  }

  public isTracing(): boolean {
    return !!webContentsTraceSessions.get(this.webContents)?.collector.isRunning()
  }

  public async captureHeapSnapshot(
    sink: (chunk: string) => void
  ): Promise<{ chunks: number; bytes: number }> {
    const detachAfter = this.attachDebugger()
    try {
      return await captureCdpHeapSnapshot(
        createWebContentsCdpTraceTransport(this.webContents),
        sink
      )
    } finally {
      this.detachDebugger(detachAfter)
    }
  }

  public async startScreencast(
    options: CdpScreencastStartOptions,
    consumer: CdpScreencastConsumerOptions = {}
  ): Promise<void> {
    if (webContentsScreencastSessions.get(this.webContents)?.recorder.isRunning()) {
      throw new AppError('VALIDATION', '页面录屏已在进行中，请先 stop。')
    }

    const detachAfterStop = this.attachDebugger()
    const recorder = new CdpScreencastRecorder(
      createWebContentsCdpTraceTransport(this.webContents),
      consumer
    )
    try {
      await recorder.start(options)
    } catch (error) {
      this.detachDebugger(detachAfterStop)
      throw error
    }
    webContentsScreencastSessions.set(this.webContents, { recorder, detachAfterStop })
  }

  public async stopScreencast(): Promise<{
    frames: ScreencastCapturedFrame[]
    frameLimitReached: boolean
  }> {
    const session = webContentsScreencastSessions.get(this.webContents)
    if (!session) {
      throw new AppError('VALIDATION', '当前没有正在进行的页面录屏。')
    }
    try {
      return await session.recorder.stop()
    } finally {
      webContentsScreencastSessions.delete(this.webContents)
      this.detachDebugger(session.detachAfterStop)
    }
  }

  public isScreencasting(): boolean {
    return !!webContentsScreencastSessions.get(this.webContents)?.recorder.isRunning()
  }

  public executeJavaScript<T = unknown>(script: string, userGesture?: boolean): Promise<T> {
    return this.webContents.executeJavaScript(script, userGesture) as Promise<T>
  }

  public async navigateTo(url: string): Promise<BrowserPageDriverState> {
    await this.webContents.loadURL(url)
    return this.refreshPageState()
  }

  public refreshPageState(): Promise<BrowserPageDriverState> {
    return Promise.resolve({
      url: this.getURL(),
      title: this.getTitle(),
    })
  }

  public bringToFront(): Promise<void> {
    this.webContents.focus()
    return Promise.resolve()
  }

  /**
   * 嵌入式鼠标输入统一走 CDP Input.dispatchMouseEvent。
   *
   * sendInputEvent 对 <webview> guest 的坐标按嵌入方/物理像素空间解释，受
   * devicePixelRatio、页面缩放与 device metrics override 复合缩放，实际命中点
   * 会整体偏移（曾把页面脚本校验过的正确坐标点进导航栏）。CDP 坐标是页面 CSS
   * 视口空间，与页面内 getBoundingClientRect/elementFromPoint 同一坐标系。
   * 持久 attach、不主动 detach（与 emulation/network hold 的语义一致）。
   */
  private async dispatchCdpMouseEvents(events: Array<Record<string, unknown>>): Promise<boolean> {
    if (this.webContents.isDestroyed()) return false

    try {
      if (!this.webContents.debugger.isAttached()) {
        this.webContents.debugger.attach('1.3')
      }
      for (const event of events) {
        await this.debuggerSend('Input.dispatchMouseEvent', event)
      }
      return true
    } catch (error) {
      embeddedDriverLog.debug('CDP 鼠标事件派发失败，回退 sendInputEvent', {
        error: AppError.from(error).message,
      })
      return false
    }
  }

  public async clickCoordinates(options: BrowserPageDriverClickCoordinatesOptions): Promise<void> {
    const x = Math.round(options.x)
    const y = Math.round(options.y)
    const button = options.button ?? 'left'
    const clickCount = Math.max(1, Math.round(options.clickCount ?? 1))
    this.webContents.focus()

    const buttons = cdpMouseButtonsMask(button)
    const dispatched = await this.dispatchCdpMouseEvents([
      { type: 'mouseMoved', x, y, button: 'none', buttons: 0 },
      { type: 'mousePressed', x, y, button, buttons, clickCount },
      { type: 'mouseReleased', x, y, button, buttons: 0, clickCount },
    ])
    if (!dispatched) {
      this.webContents.sendInputEvent({
        type: 'mouseMove',
        x,
        y,
        button,
        clickCount,
      })
      this.webContents.sendInputEvent({
        type: 'mouseDown',
        x,
        y,
        button,
        clickCount,
      })
      this.webContents.sendInputEvent({
        type: 'mouseUp',
        x,
        y,
        button,
        clickCount,
      })
    }

    options.onPointerEvent?.({ x, y, phase: 'down', button })
    options.onPointerEvent?.({ x, y, phase: 'up', button })
  }

  public async moveMouse(options: BrowserPageDriverMoveMouseOptions): Promise<void> {
    const x = Math.round(options.x)
    const y = Math.round(options.y)
    this.webContents.focus()

    const dispatched = await this.dispatchCdpMouseEvents([
      { type: 'mouseMoved', x, y, button: 'none', buttons: 0 },
    ])
    if (!dispatched) {
      this.webContents.sendInputEvent({
        type: 'mouseMove',
        x,
        y,
        button: 'left',
        clickCount: 1,
      })
    }

    options.onPointerEvent?.({ x, y, phase: 'move' })
  }

  public async dragCoordinates(options: BrowserPageDriverDragCoordinatesOptions): Promise<void> {
    const startX = Math.round(options.startX)
    const startY = Math.round(options.startY)
    const endX = Math.round(options.endX)
    const endY = Math.round(options.endY)
    const steps = Math.max(1, Math.round(options.steps ?? 10))

    const path: Array<{ x: number; y: number }> = []
    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps
      path.push({
        x: Math.round(startX + (endX - startX) * progress),
        y: Math.round(startY + (endY - startY) * progress),
      })
    }

    this.webContents.focus()
    const dispatched = await this.dispatchCdpMouseEvents([
      { type: 'mouseMoved', x: startX, y: startY, button: 'none', buttons: 0 },
      { type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1 },
      ...path.map((point) => ({
        type: 'mouseMoved',
        x: point.x,
        y: point.y,
        button: 'left',
        buttons: 1,
      })),
      { type: 'mouseReleased', x: endX, y: endY, button: 'left', buttons: 0, clickCount: 1 },
    ])
    if (!dispatched) {
      this.webContents.sendInputEvent({
        type: 'mouseMove',
        x: startX,
        y: startY,
        button: 'left',
        clickCount: 1,
      })
      this.webContents.sendInputEvent({
        type: 'mouseDown',
        x: startX,
        y: startY,
        button: 'left',
        clickCount: 1,
      })
      for (const point of path) {
        this.webContents.sendInputEvent({
          type: 'mouseMove',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1,
        })
      }
      this.webContents.sendInputEvent({
        type: 'mouseUp',
        x: endX,
        y: endY,
        button: 'left',
        clickCount: 1,
      })
    }

    options.onPointerEvent?.({ x: startX, y: startY, phase: 'move' })
    options.onPointerEvent?.({ x: startX, y: startY, phase: 'down', button: 'left' })
    for (const point of path) {
      options.onPointerEvent?.({ x: point.x, y: point.y, phase: 'move', button: 'left' })
    }
    options.onPointerEvent?.({ x: endX, y: endY, phase: 'up', button: 'left' })
  }

  public async setViewport(options: BrowserViewportOptions): Promise<void> {
    // Device metrics override 依赖持续存在的 debugger 连接。复用 emulation hold，
    // 避免后续截图/trace 的临时 driver 把连接 detach 后悄悄丢失 viewport。
    if (!this.webContents.debugger.isAttached()) {
      this.webContents.debugger.attach('1.3')
    }
    if (!webContentsEmulationHolds.has(this.webContents)) {
      webContentsEmulationHolds.set(this.webContents, {
        state: createDefaultCdpEmulationState(),
        networkEnabled: false,
      })
    }

    const width = Math.max(1, Math.round(options.width))
    const height = Math.max(1, Math.round(options.height))
    await this.debuggerSend('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      screenWidth: width,
      screenHeight: height,
      deviceScaleFactor: 1,
      mobile: false,
    })
  }

  public getPageZoomFactor(): number {
    return this.webContents.getZoomFactor()
  }

  public setPageZoomFactor(zoomFactor: number): Promise<void> {
    this.webContents.setZoomFactor(zoomFactor)
    return Promise.resolve()
  }

  public getURL(): string {
    return this.webContents.getURL()
  }

  public getTitle(): string {
    return this.webContents.getTitle()
  }

  public isDestroyed(): boolean {
    return this.webContents.isDestroyed()
  }
}

const createElectronWebContentsBrowserPageDriver: BrowserPageDriverFactory = ({ webContents }) =>
  new ElectronWebContentsBrowserPageDriver(webContents)

export { createElectronWebContentsBrowserPageDriver,ElectronWebContentsBrowserPageDriver }
