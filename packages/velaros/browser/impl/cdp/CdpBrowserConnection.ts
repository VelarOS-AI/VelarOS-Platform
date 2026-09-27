// 域：一个外部浏览器的浏览器级 CDP 连接——这个浏览器里所有会话共用的那一条 WebSocket。
//
// ## 为什么只连一条、一直开着
// 用户在 chrome://inspect/#remote-debugging 放进来的 Chrome 每来一条新连接都要用户点一次「允许」，而且这种模式只开浏览器级的
// WebSocket（HTTP 的 /json 端点一律 404）。所以这里不碰 HTTP：标签页的列、建、挂、关都走 Target 域，每个标签页是这条连接上的
// 一条 flatten 会话（CdpSessionTransport），连接开着给后来的会话复用，浏览器退出了才断。
//
// ## 下载目录设在浏览器级会话上
// Browser.setDownloadBehavior 管的是整个浏览器上下文，而且设它的那条会话一脱开，Chrome 就把下载行为复原。所以下载目录只在这条
// 浏览器级会话上设（标签页会话来去不影响），标签页会话只收 Page.download* 事件；有会话脱开时再补设一遍，防着别的会话设过又脱开。
import { isNonBlankString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Log } from '@velaros-ai/core/logger'

import type {
  CdpAttachToTargetResponse,
  CdpCreateTargetResponse,
  CdpGetTargetsResponse,
  CdpPageTarget,
  CdpWebSocketLike,
} from '../../types/cdp.js'
import { normalizePageTargets } from '../../utils/cdp/connection.js'
import { openCdpWebSocket } from '../../utils/cdp/transport.js'
import { BrowserTuning } from '../../utils/tuning'

import { CdpSessionTransport, type CdpSessionTransportApi } from './CdpSessionTransport'
import { CdpWebSocketTransport } from './CdpWebSocketTransport'

/** 连浏览器级 WebSocket 的参数。 */
export interface CdpBrowserConnectionConnectOptions {
  /** 自己造 socket 的口子；不给就用运行环境的 WebSocket。 */
  createSocket?: LooseOptional<(url: string) => CdpWebSocketLike>
  /** 连上并核实对面是浏览器最多等多少毫秒（用户自己的 Chrome 要等用户点「允许」）；不给用 `BrowserTuning.externalBrowser.connectTimeoutMs`。 */
  timeoutMs?: LooseOptional<number>
}

/** 挂到一个标签页上的参数。 */
export interface CdpBrowserConnectionAttachOptions {
  /** 这条会话上单条命令等回包的毫秒数；不给用 `BrowserTuning.cdp.commandTimeoutMs`。 */
  timeoutMs?: LooseOptional<number>
}

/** 一个外部浏览器的浏览器级 CDP 连接：一条 WebSocket，这个浏览器里的标签页会话都挂在它上面。 */
export interface CdpBrowserConnectionApi {
  /**
   * 连上浏览器级 WebSocket（`ws://127.0.0.1:<端口>/devtools/browser/<id>`），用 Browser.getVersion 核实对面真是浏览器，交回自己。
   * 连不上、被拒、超时都抛，抛之前把 socket 关掉；一个实例只连一次。
   */
  connect(
    browserWebSocketUrl: string,
    options?: CdpBrowserConnectionConnectOptions
  ): Promise<CdpBrowserConnectionApi>
  /** 列出浏览器里的标签页（Target.getTargets 里 type 为 page 的）；给了 browserContextId 就只列这个上下文里的。 */
  listPageTargets(browserContextId?: LooseOptional<string>): Promise<CdpPageTarget[]>
  /** 开一个新标签页打开 url，交回它的 targetId。 */
  createPage(url: string): Promise<string>
  /** 挂到一个标签页上（flatten 会话），交回这条会话的传输。 */
  attach(
    targetId: string,
    options?: CdpBrowserConnectionAttachOptions
  ): Promise<CdpSessionTransportApi>
  /** 关掉一个标签页；它已经没了、连接已经断了都不算错。 */
  closePage(targetId: string): Promise<void>
  /** 让整个浏览器的下载先落进这个目录、按 guid 起名；之后有会话脱开就补设一遍。 */
  setDownloadBehavior(downloadPath: string): Promise<void>
  /** 订阅连接关闭（浏览器退出、socket 断开、连接被释放）；已经关了就在下一个微任务里通知。返回取消订阅的函数。 */
  onClose(listener: () => void): () => void
  /** 连接是不是已经关了（还没连上也算）。 */
  isClosed(): boolean
  /** 关掉这条连接：挂在上面的会话一并收到关闭。 */
  dispose(): void
}

/** 见 {@link CdpBrowserConnectionApi}。 */
export class CdpBrowserConnection implements CdpBrowserConnectionApi {
  private readonly log = Log.tag('CdpBrowserConnection')
  private transport: Nullable<CdpWebSocketTransport> = null
  private closed = false
  private readonly closeListeners = new Set<() => void>()
  /** 浏览器级会话上设过的下载目录；有会话脱开时照它补设。 */
  private downloadPath: Nullable<string> = null

  public async connect(
    browserWebSocketUrl: string,
    options: CdpBrowserConnectionConnectOptions = {}
  ): Promise<CdpBrowserConnectionApi> {
    if (this.transport || this.closed)
      throw new AppError('VALIDATION', '一条浏览器级 CDP 连接只连一次：断了就换一条新的。')

    const timeoutMs = options.timeoutMs ?? BrowserTuning.externalBrowser.connectTimeoutMs
    const deadline = Date.now() + timeoutMs
    const socket = await openCdpWebSocket(browserWebSocketUrl, {
      createSocket: options.createSocket,
      timeoutMs,
    })
    const transport = new CdpWebSocketTransport({ socket })
    try {
      // 用户自己的 Chrome 可能在用户点「允许」之前压着命令不回：核实沿用同一个期限。
      await transport.send('Browser.getVersion', {}, undefined, Math.max(1, deadline - Date.now()))
    } catch (error) {
      transport.dispose()
      throw new AppError(
        AppError.from(error).code,
        `连上了 ${browserWebSocketUrl} 却核实不了对面是浏览器：${AppError.from(error).message}`,
        error
      )
    }
    if (this.closed) {
      transport.dispose()
      throw new AppError('EXECUTION_ABORTED', '浏览器级 CDP 连接还没连上就被释放了。')
    }

    this.transport = transport
    transport.onClose(() => this.markClosed())
    transport.onAnyEvent((method, _params, sessionId) => {
      if (method === 'Target.detachedFromTarget' && !sessionId) this.reapplyDownloadBehavior()
    })
    return this
  }

  public async listPageTargets(browserContextId?: LooseOptional<string>): Promise<CdpPageTarget[]> {
    const response =
      await this.requireTransport('Target.getTargets').send<CdpGetTargetsResponse>(
        'Target.getTargets'
      )
    return normalizePageTargets(response.targetInfos, browserContextId)
  }

  public async createPage(url: string): Promise<string> {
    const response = await this.requireTransport(
      'Target.createTarget'
    ).send<CdpCreateTargetResponse>('Target.createTarget', { url })
    if (!isNonBlankString(response.targetId))
      throw new AppError('EXECUTION_FAILED', '浏览器没有交回新标签页的 targetId。')
    return response.targetId
  }

  public async attach(
    targetId: string,
    options: CdpBrowserConnectionAttachOptions = {}
  ): Promise<CdpSessionTransportApi> {
    const transport = this.requireTransport('Target.attachToTarget')
    const response = await transport.send<CdpAttachToTargetResponse>('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    if (!isNonBlankString(response.sessionId))
      throw new AppError('EXECUTION_FAILED', `浏览器没有交回标签页 ${targetId} 的会话。`)
    // 回包之后连接刚好断了：这条会话等不到关闭通知，不交出去。
    if (this.closed)
      throw new AppError('EXECUTION_ABORTED', `浏览器连接已经断开：挂不上标签页 ${targetId}。`)

    return new CdpSessionTransport({
      connection: {
        send: async (method, params, sessionId, timeoutMs) =>
          this.requireTransport(method).send(method, params, sessionId, timeoutMs),
        onAnyEvent: (listener) => transport.onAnyEvent(listener),
        onClose: (listener) => this.onClose(listener),
      },
      targetId,
      sessionId: response.sessionId,
      timeoutMs: options.timeoutMs,
    })
  }

  public async closePage(targetId: string): Promise<void> {
    if (this.isClosed()) return
    try {
      await this.requireTransport('Target.closeTarget').send('Target.closeTarget', { targetId })
    } catch (error) {
      this.log.debug('标签页没关成：多半已经被关掉了，或者连接正好断了', {
        targetId,
        error: AppError.from(error).message,
      })
    }
  }

  public async setDownloadBehavior(downloadPath: string): Promise<void> {
    await this.requireTransport('Browser.setDownloadBehavior').send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath,
      eventsEnabled: false,
    })
    this.downloadPath = downloadPath
  }

  public onClose(listener: () => void): () => void {
    if (this.closed) {
      queueMicrotask(listener)
      return () => undefined
    }
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  public isClosed(): boolean {
    return this.closed || !this.transport
  }

  public dispose(): void {
    const transport = this.transport
    this.markClosed()
    transport?.dispose()
  }

  /** 要发命令时取传输；连接已经断了（或还没连上）就抛 EXECUTION_ABORTED，点名是哪条命令。 */
  private requireTransport(method: string): CdpWebSocketTransport {
    if (this.closed || !this.transport)
      throw new AppError('EXECUTION_ABORTED', `浏览器连接已经断开：${method}`)
    return this.transport
  }

  /** 有会话脱开时补设下载目录：设过它的会话一脱开，Chrome 就把整个上下文的下载行为复原了。 */
  private reapplyDownloadBehavior(): void {
    if (!this.downloadPath || this.closed) return
    void this.setDownloadBehavior(this.downloadPath).catch((error) => {
      this.log.debug('补设下载目录没成', { error: AppError.from(error).message })
    })
  }

  private markClosed(): void {
    if (this.closed) return
    this.closed = true
    const listeners = [...this.closeListeners]
    this.closeListeners.clear()
    for (const listener of listeners) listener()
  }
}
