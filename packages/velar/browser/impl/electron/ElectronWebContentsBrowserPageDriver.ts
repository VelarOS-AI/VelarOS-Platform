import type electron from 'electron'

import { isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Log } from '@velaros-ai/core/logger'

import type { BrowserPageDriver, BrowserProtocolChannel } from '../../contract/requires.js'
import type {
  BrowserFrameInfo,
  BrowserNetworkControlOptions,
  BrowserNetworkRequestDetailsOptions,
  BrowserNetworkResponseBodyOptions,
  BrowserPageDiagnosticEntry,
  BrowserViewportOptions,
} from '../../types/browser'
import type { CdpScreencastConsumerOptions, CdpScreencastStartOptions, CdpSend,ScreencastCapturedFrame } from '../../types/cdp.js'
import type { BrowserPageDriverClickCoordinatesOptions, BrowserPageDriverDiagnosticsOptions, BrowserPageDriverDragCoordinatesOptions, BrowserPageDriverKeyEvent, BrowserPageDriverMouseEvent, BrowserPageDriverMoveMouseOptions, BrowserPageDriverNetworkCaptureState, BrowserPageDriverNetworkControlState, BrowserPageDriverNetworkIdleOptions, BrowserPageDriverNetworkRequestDetailsResult, BrowserPageDriverNetworkResponseBodyResult, BrowserPageDriverState } from '../../types/driver'
import { captureCdpHeapSnapshot, createWebContentsCdpTraceTransport } from '../../utils/cdp/tracing.js'
import { clearBrowserDiagnosticEntries, takeBrowserDiagnosticWindow } from '../../utils/diagnostics.js'
import { evaluateInFrame } from '../../utils/electron/evaluate'
import { cdpMouseButtonsMask, clampEmbeddedDiagnosticLimit, listWebContentsFrames } from '../../utils/electron/webcontents'
import { BrowserTuning } from '../../utils/tuning'
import { buildBrowserViewportDeviceMetrics } from '../../utils/viewport'
import { BrowserCdpNetworkController } from '../cdp/BrowserCdpNetworkController'
import { CdpScreencastRecorder } from '../cdp/CdpScreencastRecorder'
import { CdpTraceCollector } from '../cdp/CdpTraceCollector'

import { electronDebuggerHolds } from './ElectronDebuggerHolds'
import { ElectronProtocolChannel } from './ElectronProtocolChannel'

/** 嵌入式网络诊断缓冲上限,与外部 CDP driver 的诊断窗口一致。 */

const embeddedDriverLog = Log.tag('ElectronWebContentsBrowserPageDriver')

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
    // 模拟、网络采集或模型的 CDP 会话持有 debugger 时,临时操作不得 detach(否则 override、事件订阅与子会话一起失效)。
    if (electronDebuggerHolds.hasPersistentHold(this.webContents)) return
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
    const existing = electronDebuggerHolds.getNetwork(this.webContents)
    if (existing) return existing

    const diagnostics: BrowserPageDiagnosticEntry[] = []
    const controller = new BrowserCdpNetworkController({
      send: this.debuggerSend,
      appendDiagnostic: (entry) => {
        diagnostics.push(entry)
        if (diagnostics.length > BrowserTuning.cdp.embeddedNetworkDiagnostics) {
          diagnostics.splice(0, diagnostics.length - BrowserTuning.cdp.embeddedNetworkDiagnostics)
        }
      },
      getCurrentUrl: () => this.webContents.getURL(),
    })
    const messageListener = (
      _event: electron.Event,
      method: string,
      params: unknown,
      sessionId?: string
    ): void => {
      // 子会话（模型自己的那条 CDP 会话与它挂出来的）的网络事件不是宿主这条的：混进来会把同一个请求记两遍。
      if (sessionId) return
      controller.handleCdpEvent(method, params)
    }
    this.webContents.debugger.on('message', messageListener)
    const hold = { controller, diagnostics, messageListener }
    electronDebuggerHolds.setNetwork(this.webContents, hold)
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

  public async waitForNetworkIdle(options: BrowserPageDriverNetworkIdleOptions): Promise<boolean> {
    const hold = await this.ensureNetworkHold()
    return hold.controller.waitForNetworkIdle(options)
  }

  /**
   * 确保网络采集已经在跑：没有采集时当场建立,并如实回报「这次才开始」。
   *
   * 采集要 attach debugger。attach 失败(多半是 DevTools 已经接管)不该让读诊断整个失败——
   * 那是一次「看看有什么」的读操作;把原因带回去,让回执说清楚为什么列不到网络事件。
   */
  public async ensureNetworkCapture(): Promise<BrowserPageDriverNetworkCaptureState> {
    if (electronDebuggerHolds.hasNetwork(this.webContents))
      return { startedNow: false, unavailableReason: null }

    try {
      await this.ensureNetworkHold()
      return { startedNow: true, unavailableReason: null }
    } catch (error) {
      const reason = AppError.from(error).message
      embeddedDriverLog.debug('内嵌页面的网络采集未能建立', {
        error: AppError.from(error).message,
      })
      return { startedNow: false, unavailableReason: reason }
    }
  }

  /**
   * 返回已采集的网络诊断(list_network_events 的嵌入式数据源)。
   * 网络采集未建立时返回空;控制台诊断走 session.diagnostics,由数据引擎合并。
   */
  public readDiagnostics(
    options: BrowserPageDriverDiagnosticsOptions
  ): BrowserPageDiagnosticEntry[] {
    const hold = electronDebuggerHolds.getNetwork(this.webContents)
    if (!hold) return []

    const limit = clampEmbeddedDiagnosticLimit(options.limit)
    const entries = takeBrowserDiagnosticWindow(hold.diagnostics, limit, options.kinds)
    if (options.clear) {
      clearBrowserDiagnosticEntries(hold.diagnostics, options.kinds)
    }
    return entries
  }

  public async startTracing(): Promise<void> {
    if (electronDebuggerHolds.getTrace(this.webContents)?.collector.isRunning()) {
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
    electronDebuggerHolds.setTrace(this.webContents, { collector, detachAfterStop })
  }

  public async stopTracing(): Promise<unknown[]> {
    const session = electronDebuggerHolds.getTrace(this.webContents)
    if (!session) {
      throw new AppError('VALIDATION', '当前没有正在录制的性能 trace。')
    }
    try {
      return await session.collector.stop()
    } finally {
      electronDebuggerHolds.deleteTrace(this.webContents)
      this.detachDebugger(session.detachAfterStop)
    }
  }

  public isTracing(): boolean {
    return !!electronDebuggerHolds.getTrace(this.webContents)?.collector.isRunning()
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
    if (electronDebuggerHolds.getScreencast(this.webContents)?.recorder.isRunning()) {
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
    electronDebuggerHolds.setScreencast(this.webContents, { recorder, detachAfterStop })
  }

  public async stopScreencast(): Promise<{
    frames: ScreencastCapturedFrame[]
    frameLimitReached: boolean
  }> {
    const session = electronDebuggerHolds.getScreencast(this.webContents)
    if (!session) {
      throw new AppError('VALIDATION', '当前没有正在进行的页面录屏。')
    }
    try {
      return await session.recorder.stop()
    } finally {
      electronDebuggerHolds.deleteScreencast(this.webContents)
      this.detachDebugger(session.detachAfterStop)
    }
  }

  public isScreencasting(): boolean {
    return !!electronDebuggerHolds.getScreencast(this.webContents)?.recorder.isRunning()
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
    const modifiers = options.modifiers ?? 0
    this.webContents.focus()

    const buttons = cdpMouseButtonsMask(button)
    const dispatched = await this.dispatchCdpMouseEvents([
      { type: 'mouseMoved', x, y, button: 'none', buttons: 0, modifiers },
      { type: 'mousePressed', x, y, button, buttons, clickCount, modifiers },
      { type: 'mouseReleased', x, y, button, buttons: 0, clickCount, modifiers },
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
    const steps = Math.max(1, Math.round(options.steps ?? BrowserTuning.page.dragSteps))

    const path: Array<{ x: number; y: number }> = []
    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps
      path.push({
        x: Math.round(startX + (endX - startX) * progress),
        y: Math.round(startY + (endY - startY) * progress),
      })
    }

    const modifiers = options.modifiers ?? 0
    this.webContents.focus()
    const dispatched = await this.dispatchCdpMouseEvents([
      { type: 'mouseMoved', x: startX, y: startY, button: 'none', buttons: 0, modifiers },
      { type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1, modifiers },
      ...path.map((point) => ({
        type: 'mouseMoved',
        x: point.x,
        y: point.y,
        button: 'left',
        buttons: 1,
        modifiers,
      })),
      { type: 'mouseReleased', x: endX, y: endY, button: 'left', buttons: 0, clickCount: 1, modifiers },
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

  /** 键盘事件走 CDP：键位、上屏文字与修饰键由交互引擎拼好；debugger 持久 attach，与鼠标同一条路。 */
  public async dispatchKeyEvent(event: BrowserPageDriverKeyEvent): Promise<void> {
    this.ensureInputDebugger()
    await this.debuggerSend('Input.dispatchKeyEvent', { ...event })
  }

  /** 鼠标原子（按下、松开、分步移动、滚轮）走 CDP，失败就抛：原子没有退回 sendInputEvent 的余地，坐标系不一样。 */
  public async dispatchMouseEvent(event: BrowserPageDriverMouseEvent): Promise<void> {
    this.ensureInputDebugger()
    this.webContents.focus()
    await this.debuggerSend('Input.dispatchMouseEvent', { ...event })
  }

  public listFrames(): Promise<BrowserFrameInfo[]> {
    return Promise.resolve(listWebContentsFrames(this.webContents))
  }

  public executeJavaScriptInFrame<T = unknown>(frameId: string, script: string, userGesture?: boolean): Promise<T> {
    return evaluateInFrame<T>(this.webContents, frameId, script, userGesture)
  }

  /** 给模型单开一条 CDP 会话：debugger 上用 Target.attachToTarget 连页面自己，挂出一条 flatten 子会话。 */
  public async openProtocolChannel(): Promise<BrowserProtocolChannel> {
    this.ensureInputDebugger()
    const info = (await this.debuggerSend('Target.getTargetInfo')) as { targetInfo?: { targetId?: unknown } }
    const targetId = info.targetInfo?.targetId
    if (!isString(targetId)) throw new AppError('EXECUTION_FAILED', '读不到页面的 target id，开不了单独的 CDP 会话。')
    const attached = (await this.debuggerSend('Target.attachToTarget', { targetId, flatten: true })) as { sessionId?: unknown }
    if (!isString(attached.sessionId)) throw new AppError('EXECUTION_FAILED', 'Target.attachToTarget 没有交回会话 id。')
    return new ElectronProtocolChannel(this.webContents, attached.sessionId)
  }

  /** 输入与模型会话要一直挂着的 debugger：没 attach 就 attach，不主动 detach（与模拟、网络采集同样的持久语义）。 */
  private ensureInputDebugger(): void {
    if (this.webContents.isDestroyed()) throw new AppError('VALIDATION', '页面已销毁，发不了输入事件。')
    if (!this.webContents.debugger.isAttached()) this.webContents.debugger.attach('1.3')
  }

  public async setViewport(options: BrowserViewportOptions): Promise<void> {
    // Device metrics override 依赖持续存在的 debugger 连接：登记成 Emulation 占用，
    // 免得之后截图、trace 的临时 driver 收尾时把连接 detach，视口悄悄丢掉。
    if (!this.webContents.debugger.isAttached()) {
      this.webContents.debugger.attach('1.3')
    }
    electronDebuggerHolds.holdEmulation(this.webContents)

    const metrics = buildBrowserViewportDeviceMetrics(options)
    await this.debuggerSend('Emulation.setDeviceMetricsOverride', { ...metrics })
    await this.debuggerSend('Emulation.setTouchEmulationEnabled', {
      enabled: metrics.mobile,
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

export { ElectronWebContentsBrowserPageDriver }
