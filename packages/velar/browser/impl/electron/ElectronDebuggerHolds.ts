import type electron from 'electron'

import type { BrowserPageDiagnosticEntry } from '../../types/browser'
import type { BrowserCdpNetworkController } from '../cdp/BrowserCdpNetworkController'
import type { CdpScreencastRecorder } from '../cdp/CdpScreencastRecorder'
import type { CdpTraceCollector } from '../cdp/CdpTraceCollector'

/** 一条 WebContents 上正在跑的 trace 录制。 */
export interface ElectronDebuggerHoldsTrace {
  /** 采集器本身；`isRunning()` 决定还能不能再开一次。 */
  collector: CdpTraceCollector
  /** 停录之后要不要顺手 detach debugger（视口覆盖或网络采集占着就不能 detach）。 */
  detachAfterStop: boolean
}

/** 一条 WebContents 上正在跑的录屏。 */
export interface ElectronDebuggerHoldsScreencast {
  /** 录屏器本身。 */
  recorder: CdpScreencastRecorder
  /** 停录之后要不要顺手 detach debugger。 */
  detachAfterStop: boolean
}

/** 一条 WebContents 上开着的模型 CDP 会话：debugger 上挂出来的子会话，断了 debugger 它就没了。 */
export interface ElectronDebuggerHoldsProtocol {
  /** 子会话的 id。 */
  sessionId: string
}

/** 一条 WebContents 上持久生效的网络采集。 */
export interface ElectronDebuggerHoldsNetwork {
  /** 网络控制器：离线、请求头、拦截与 mock 都经它下发。 */
  controller: BrowserCdpNetworkController
  /** 这条 WebContents 累积的网络诊断，跨多次工具调用留着。 */
  diagnostics: BrowserPageDiagnosticEntry[]
  /** 挂在 debugger 上的消息监听器，拆除时要用同一个引用摘掉。 */
  messageListener: (event: electron.Event, method: string, params: unknown) => void
}

/**
 * 内嵌页面挂在 WebContents 上的 debugger 占用登记。
 *
 * 为什么不放在驱动实例里：内嵌页面的 `BrowserPageDriver` 是**每次调用临时包一个**的，而 trace 录制、录屏、
 * 视口覆盖、网络采集与模型的 CDP 会话都跨多次工具调用；状态只能按 WebContents 存。五类占用共用一个登记处还有一层意思：
 * CDP 的 Emulation override、Fetch 拦截与挂在 debugger 上的子会话在 detach 之后都失效，所以只要有一项还占着，
 * 临时操作（截图、一次 trace）收尾时就**不许** detach——判断「现在能不能 detach」要一次看全五类。
 *
 * 实例归进程：WeakMap、WeakSet 以 WebContents 为键，页面销毁后自动释放；文件末尾给出进程唯一的一份。
 */
export interface ElectronDebuggerHoldsApi {
  /** 这条 WebContents 上是不是有任何一类持久占用（有就不许 detach debugger）。 */
  hasPersistentHold(webContents: electron.WebContents): boolean
  /** 读 trace 占用；没有返回 undefined。 */
  getTrace(webContents: electron.WebContents): ElectronDebuggerHoldsTrace | undefined
  /** 登记一次 trace 录制。 */
  setTrace(webContents: electron.WebContents, hold: ElectronDebuggerHoldsTrace): void
  /** 撤销 trace 登记。 */
  deleteTrace(webContents: electron.WebContents): void
  /** 读录屏占用；没有返回 undefined。 */
  getScreencast(webContents: electron.WebContents): ElectronDebuggerHoldsScreencast | undefined
  /** 登记一次录屏。 */
  setScreencast(webContents: electron.WebContents, hold: ElectronDebuggerHoldsScreencast): void
  /** 撤销录屏登记。 */
  deleteScreencast(webContents: electron.WebContents): void
  /** 登记 Emulation 占用（视口的设备尺寸覆盖）；登记过就不再重复记。 */
  holdEmulation(webContents: electron.WebContents): void
  /** 读网络采集占用；没有返回 undefined。 */
  getNetwork(webContents: electron.WebContents): ElectronDebuggerHoldsNetwork | undefined
  /** 这条 WebContents 上有没有网络采集占用。 */
  hasNetwork(webContents: electron.WebContents): boolean
  /** 登记网络采集。 */
  setNetwork(webContents: electron.WebContents, hold: ElectronDebuggerHoldsNetwork): void
  /** 读模型 CDP 会话的占用；没有返回 undefined。 */
  getProtocol(webContents: electron.WebContents): ElectronDebuggerHoldsProtocol | undefined
  /** 登记模型的 CDP 会话。 */
  setProtocol(webContents: electron.WebContents, hold: ElectronDebuggerHoldsProtocol): void
  /** 撤销模型 CDP 会话的登记。 */
  deleteProtocol(webContents: electron.WebContents): void
}

export class ElectronDebuggerHolds implements ElectronDebuggerHoldsApi {
  private readonly traces = new WeakMap<electron.WebContents, ElectronDebuggerHoldsTrace>()
  private readonly screencasts = new WeakMap<electron.WebContents, ElectronDebuggerHoldsScreencast>()
  private readonly emulations = new WeakSet<electron.WebContents>()
  private readonly networks = new WeakMap<electron.WebContents, ElectronDebuggerHoldsNetwork>()
  private readonly protocols = new WeakMap<electron.WebContents, ElectronDebuggerHoldsProtocol>()

  public hasPersistentHold(webContents: electron.WebContents): boolean {
    return this.emulations.has(webContents) || this.networks.has(webContents) || this.protocols.has(webContents)
  }

  public getTrace(webContents: electron.WebContents): ElectronDebuggerHoldsTrace | undefined {
    return this.traces.get(webContents)
  }

  public setTrace(webContents: electron.WebContents, hold: ElectronDebuggerHoldsTrace): void {
    this.traces.set(webContents, hold)
  }

  public deleteTrace(webContents: electron.WebContents): void {
    this.traces.delete(webContents)
  }

  public getScreencast(
    webContents: electron.WebContents
  ): ElectronDebuggerHoldsScreencast | undefined {
    return this.screencasts.get(webContents)
  }

  public setScreencast(
    webContents: electron.WebContents,
    hold: ElectronDebuggerHoldsScreencast
  ): void {
    this.screencasts.set(webContents, hold)
  }

  public deleteScreencast(webContents: electron.WebContents): void {
    this.screencasts.delete(webContents)
  }

  public holdEmulation(webContents: electron.WebContents): void {
    this.emulations.add(webContents)
  }

  public getNetwork(webContents: electron.WebContents): ElectronDebuggerHoldsNetwork | undefined {
    return this.networks.get(webContents)
  }

  public hasNetwork(webContents: electron.WebContents): boolean {
    return this.networks.has(webContents)
  }

  public setNetwork(webContents: electron.WebContents, hold: ElectronDebuggerHoldsNetwork): void {
    this.networks.set(webContents, hold)
  }

  public getProtocol(webContents: electron.WebContents): ElectronDebuggerHoldsProtocol | undefined {
    return this.protocols.get(webContents)
  }

  public setProtocol(webContents: electron.WebContents, hold: ElectronDebuggerHoldsProtocol): void {
    this.protocols.set(webContents, hold)
  }

  public deleteProtocol(webContents: electron.WebContents): void {
    this.protocols.delete(webContents)
  }
}

/** 进程唯一的一份：键是 WebContents，页面销毁后自动释放。 */
export const electronDebuggerHolds: ElectronDebuggerHoldsApi = new ElectronDebuggerHolds()
