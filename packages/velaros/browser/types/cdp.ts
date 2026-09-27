import type { TimerLease } from '@velaros-ai/core/utils/TimerScope'

import type { BrowserPageDriver } from '../contract/requires.js'

import type { BrowserFrameInfo, BrowserPageDiagnosticEntry } from './browser.js'

export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>

export interface CdpWebSocketLike {
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: Event) => void): void
  removeEventListener(type: string, listener: (event: Event) => void): void
}

export interface CdpPendingRequest {
  /** 这条命令的方法名：协议报错时写进错误的 context。 */
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: TimerLease
}

export interface CdpJsonRpcMessage {
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  /** flatten 模式下子会话的消息带着它的 sessionId；页面本身的消息没有。 */
  sessionId?: unknown
  error?: {
    code?: unknown
    message?: unknown
  }
}

/** 采集器需要的最小 CDP 会话面。 */
export interface CdpTraceTransport {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  /** 订阅 CDP 事件；返回退订函数。 */
  onEvent<T = unknown>(method: string, listener: (params: T) => void): () => void
}

/** electron.WebContents 的最小 debugger 面（避免此文件依赖 electron 类型）。 */
export interface WebContentsDebuggerLike {
  debugger: {
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
    on(
      event: 'message',
      listener: (event: unknown, method: string, params: unknown, sessionId?: string) => void
    ): void
    off(
      event: 'message',
      listener: (event: unknown, method: string, params: unknown, sessionId?: string) => void
    ): void
  }
}

export interface CdpTracingCompleteEvent {
  stream?: string
  dataLossOccurred?: boolean
}

export interface CdpIoReadResult {
  data: string
  base64Encoded?: boolean
  eof: boolean
}

export interface CdpHeapSnapshotChunkEvent {
  chunk?: string
}

export interface ScreencastCapturedFrame {
  /** JPEG 帧字节。 */
  bytes: Buffer
  /** CDP 帧时间戳（epoch 秒）。 */
  timestamp: number
  /** CDP 报告的页面画面宽度。 */
  width: number
  /** CDP 报告的页面画面高度。 */
  height: number
}

export interface CdpScreencastConsumerOptions {
  /** false 时不在主进程累计帧，只把最新画面交给消费者。 */
  retainFrames?: boolean
  /** 实时帧消费者；异常与 CDP ack 隔离，不能阻断后续画面。 */
  onFrame?: (frame: ScreencastCapturedFrame) => void
  /** CDP JPEG 编码质量。 */
  quality?: number
}

export interface CdpScreencastStartOptions {
  /** 帧最大宽度（CDP 侧缩放）。 */
  maxWidth: number
  /** 帧最大高度。 */
  maxHeight: number
  /** 每 N 帧取 1 帧，降低帧率与体积。 */
  everyNthFrame: number
  /** 帧数上限；达到后自动停止采集（防忘 stop 撑爆内存）。 */
  maxFrames: number
}

export interface CdpScreencastFrameEvent {
  data?: string
  sessionId?: number
  metadata?: {
    timestamp?: number
    deviceWidth?: number
    deviceHeight?: number
  }
}

/** 帧图像解码器：把 JPEG 帧解成 RGBA。实现端负责等比缩到 maxWidth 内。 */
export type ScreencastFrameDecoder = (
  bytes: Buffer,
  maxWidth: number
) => Nullable<{ width: number; height: number; rgba: Buffer }>

export interface EncodeScreencastGifOptions {
  decode: ScreencastFrameDecoder
  /** 输出 GIF 最大宽度。 */
  maxWidth?: number
}

/**
 * 在外部浏览器里开一页的参数。找浏览器的先后：用户自己开着的 Chrome（`preferRunningBrowser`）→ `userDataDir` 上还开着的
 * → 都没有才拉起一个。接上已经在跑的浏览器时，只管拉起的那几项（可执行文件、命令行参数、环境变量、钥匙串）不起作用。
 */
export interface CdpExternalBrowserLaunchOptions {
  /** 拉起用的可执行文件；不给按平台找本机的 Chrome / Chromium。 */
  executablePath?: LooseOptional<string>
  /** 用户数据目录：先接这个目录上已经开着的浏览器，没有才在它上面拉起，目录一直留着；不给就拉在启动器自己建、收尾删掉的临时目录上。 */
  userDataDir?: LooseOptional<string>
  /** 用户数据目录里的哪个配置（`--profile-directory`）。 */
  profileDirectory?: LooseOptional<string>
  /** 用系统钥匙串，不加 `--use-mock-keychain`；给了 profileDirectory 也按用系统钥匙串算。 */
  useRealKeychain?: LooseOptional<boolean>
  /** 页面下载先落进哪个目录（整个浏览器共用，按第一次拉起或接上时定）；不给是用户数据目录下的 Downloads。用户自己的 Chrome 不改它的下载行为。 */
  downloadPath?: LooseOptional<string>
  /** 新标签页打开的地址；不给是 about:blank。 */
  url?: LooseOptional<string>
  /** 拉起时追加的命令行参数。 */
  args?: LooseOptional<string[]>
  /** 拉起时追加的环境变量。 */
  env?: LooseOptional<Record<string, string | undefined>>
  /** 按哪个平台找可执行文件与用户的 Chrome 配置目录；不给是当前进程的平台。 */
  platform?: LooseOptional<NodeJS.Platform>
  /** 拉起之后等它写出调试端口的毫秒数；不给用 `BrowserTuning.externalBrowser.launchTimeoutMs`。 */
  timeoutMs?: LooseOptional<number>
  /**
   * 先接用户自己开着的 Chrome：默认配置目录里有 DevToolsActivePort 的（用户在 chrome://inspect/#remote-debugging 打开了远程调试），
   * Chrome 会弹窗请用户允许。缺省是；false 时一概不碰用户的 Chrome。
   */
  preferRunningBrowser?: LooseOptional<boolean>
  /**
   * 找不到开着的浏览器时拉起一个。缺省是；false 时只接开着的，接不上就报
   * `ExternalBrowserUnavailableReason`，由宿主决定怎么办（比如把要网页的活交给别处）。
   */
  spawnIfNoneRunning?: LooseOptional<boolean>
}

/** 一次 launch 在外部浏览器里开的那一页：驱动挂在它上面。 */
export interface CdpExternalBrowserSession {
  /** 挂在这一页上的页面驱动。 */
  driver: BrowserPageDriver
  /** 断开驱动、关掉这一页；浏览器与别的会话照旧，从不关浏览器。 */
  dispose(): void
}

export interface CdpExternalBrowserSpawnOptions {
  detached: boolean
  env: Record<string, string | undefined>
  stdio: ['ignore', 'ignore', 'pipe']
}

export interface CdpExternalBrowserChildProcess {
  pid?: LooseOptional<number>
  exitCode?: LooseOptional<number>
  signalCode?: LooseOptional<string>
  killed?: boolean
  stderr?: LooseOptional<NodeJS.ReadableStream>
  kill(signal?: NodeJS.Signals | number): boolean
  /** 进程退出时通知一次（删临时配置目录要等浏览器退干净）；给不了就当场删。 */
  once?(event: 'exit', listener: () => void): unknown
}

export type CdpExternalBrowserSpawn = (
  command: string,
  args: string[],
  options: CdpExternalBrowserSpawnOptions
) => CdpExternalBrowserChildProcess

/** Chrome 写在用户数据目录里的 DevToolsActivePort：第一行端口，第二行浏览器级 WebSocket 的路径。 */
export interface CdpDevToolsActivePort {
  port: number
  /** `/devtools/browser/<id>`。 */
  browserWebSocketPath: string
}

/** Target.getTargets 回包里的一条 target（形状照协议，字段存在与否要自己判）。 */
export interface CdpTargetInfoEntry {
  targetId?: unknown
  type?: unknown
  url?: unknown
  title?: unknown
  browserContextId?: unknown
}

/** Target.getTargets 的回包。 */
export interface CdpGetTargetsResponse {
  targetInfos?: unknown
}

/** Target.createTarget 的回包。 */
export interface CdpCreateTargetResponse {
  targetId?: unknown
}

/** Target.attachToTarget 的回包。 */
export interface CdpAttachToTargetResponse {
  sessionId?: unknown
}

/** 浏览器里的一个标签页：Target.getTargets 里 type 为 page 的一条，归一过。 */
export interface CdpPageTarget {
  /** 标签页的 targetId（也是它主框架的 frameId）。 */
  targetId: string
  url: string
  title: string
  /** 它在哪个浏览器上下文里（每个配置、每个无痕窗口各是一个）；协议没给是空字符串。 */
  browserContextId: string
}

export interface CdpChromeStderrDiagnostics {
  lines: string[]
  pending: string
}

export type CdpExternalBrowserLaunchEnv = Record<string, string | undefined>

/** CDP 传输：驱动只经它收发命令与事件，不关心底下是 WebSocket 还是 Electron 的 debugger。 */
export interface CdpBrowserPageDriverTransport {
  /** 下发一条 CDP 命令并等回包；sessionId 给 flatten 模式下的子会话。 */
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<T>
  /** 订阅一类 CDP 事件；返回取消订阅的函数。传输不支持事件时可以不实现。 */
  onEvent?<T = unknown>(method: string, listener: (params: T) => void): () => void
  /** 订阅全部 CDP 事件，含 flatten 子会话上的（sessionId 标出是哪条，这条连接自己的是 undefined）；传输不支持时可以不实现。 */
  onAnyEvent?(
    listener: (method: string, params: unknown, sessionId: Optional<string>) => void
  ): () => void
  /** 订阅传输关闭；返回取消订阅的函数。 */
  onClose?(listener: () => void): () => void
}

export interface CdpRuntimeEvaluateResponse {
  result?: {
    type?: string
    value?: unknown
    unserializableValue?: string
    description?: string
  }
  exceptionDetails?: {
    text?: string
    exception?: {
      description?: string
      value?: unknown
    }
  }
}

export interface CdpCaptureScreenshotResponse {
  data?: unknown
}

export interface CdpPrintToPdfResponse {
  data?: unknown
}

export interface CdpLayoutMetricsResponse {
  cssContentSize?: {
    x?: unknown
    y?: unknown
    width?: unknown
    height?: unknown
  }
  contentSize?: {
    x?: unknown
    y?: unknown
    width?: unknown
    height?: unknown
  }
}

export interface CdpDomDocumentResponse {
  root?: {
    nodeId?: unknown
  }
}

export interface CdpDomQuerySelectorResponse {
  nodeId?: unknown
}

export interface CdpFetchResourcePayload {
  ok?: unknown
  status?: unknown
  mimeType?: unknown
  contentLength?: unknown
  data?: unknown
}

export interface CdpPageFrame {
  id?: unknown
  parentId?: unknown
  url?: unknown
  name?: unknown
  securityOrigin?: unknown
}

export interface CdpPageFrameTree {
  frame?: unknown
  childFrames?: unknown
}

export interface CdpPageGetFrameTreeResponse {
  frameTree?: unknown
}

/**
 * 外部浏览器页面里的一个框架与它归哪条会话：驱动那条连接上的 session 是 null，跨进程 iframe 里的是挂出来的子会话；
 * sessionRoot 为真是那条会话的顶层框架（驱动连接上就是页面本身）。
 */
export interface CdpSessionFrame {
  info: BrowserFrameInfo
  session: Nullable<string>
  sessionRoot: boolean
}

export interface CdpTargetAttachedEvent {
  sessionId?: unknown
  targetInfo?: {
    type?: unknown
  }
}

export interface CdpTargetDetachedEvent {
  sessionId?: unknown
  targetId?: unknown
}

export interface CdpDomFrameOwnerResponse {
  backendNodeId?: unknown
}

export interface CdpDomDescribeNodeResponse {
  node?: {
    contentDocument?: {
      backendNodeId?: unknown
    }
  }
}

export interface CdpDomResolveNodeResponse {
  object?: {
    objectId?: unknown
  }
}

export interface CdpJavascriptDialogOpeningEvent {
  type?: unknown
  message?: unknown
  url?: unknown
}

export interface CdpRuntimeConsoleAPICalledEvent {
  type?: unknown
  args?: unknown
  stackTrace?: unknown
  timestamp?: unknown
}

export interface CdpRuntimeExceptionThrownEvent {
  timestamp?: unknown
  exceptionDetails?: unknown
}

export interface CdpRuntimeExceptionDetails {
  text?: unknown
  url?: unknown
  lineNumber?: unknown
  columnNumber?: unknown
  exception?: unknown
}

export interface CdpRuntimeRemoteObject {
  type?: unknown
  value?: unknown
  unserializableValue?: unknown
  description?: unknown
}

export interface CdpDownloadWillBeginEvent {
  guid?: unknown
  url?: unknown
  suggestedFilename?: unknown
}

export interface CdpNetworkRequestPayload {
  headers?: unknown
  method?: unknown
  postData?: unknown
  url?: unknown
}

export interface CdpFetchRequestPausedEvent {
  requestId?: unknown
  resourceType?: unknown
  request?: unknown
}

export interface CdpNetworkRequestWillBeSentEvent {
  requestId?: unknown
  type?: unknown
  request?: unknown
  timestamp?: unknown
  wallTime?: unknown
}

export interface CdpNetworkResponsePayload {
  encodedDataLength?: unknown
  headers?: unknown
  protocol?: unknown
  remoteIPAddress?: unknown
  remotePort?: unknown
  url?: unknown
  status?: unknown
  statusText?: unknown
  mimeType?: unknown
  fromDiskCache?: unknown
  fromServiceWorker?: unknown
  timing?: unknown
}

export interface CdpNetworkResponseReceivedEvent {
  requestId?: unknown
  type?: unknown
  response?: unknown
}

export interface CdpNetworkLoadingFinishedEvent {
  requestId?: unknown
  encodedDataLength?: unknown
  timestamp?: unknown
}

export interface CdpNetworkLoadingFailedEvent {
  requestId?: unknown
  type?: unknown
  errorText?: unknown
  canceled?: unknown
  timestamp?: unknown
}

export interface CdpNetworkGetResponseBodyResponse {
  body?: unknown
  base64Encoded?: unknown
}

export interface CdpNetworkRequestRecord {
  requestId: string
  method: string
  url: string
  headers: Record<string, string>
  postData: Nullable<string>
  resourceType: string
  timestamp: Nullable<number>
  wallTime: Nullable<number>
  response: Nullable<{
    status: number
    statusText: string
    headers: Record<string, string>
    mimeType: Nullable<string>
    protocol: Nullable<string>
    fromDiskCache: boolean
    fromServiceWorker: boolean
    encodedDataLength: Nullable<number>
    remoteIPAddress: Nullable<string>
    remotePort: Nullable<number>
    timing: Nullable<Record<string, unknown>>
  }>
  failure: Nullable<{
    errorText: string
    canceled: boolean
  }>
  finishedTimestamp: Nullable<number>
}

export interface CdpDownloadProgressEvent {
  guid?: unknown
  totalBytes?: unknown
  receivedBytes?: unknown
  state?: unknown
}

/**
 * 网络节流预设 → CDP Network.emulateNetworkConditions 参数。
 * 吞吐单位 bytes/s，-1 表示不限速；数值与 DevTools 前端预设保持一致。
 */
export type CdpDownloadDoneState = 'completed' | 'cancelled'

export interface CdpBrowserPageDownloadItemOptions {
  transport: CdpBrowserPageDriverTransport
  guid: string
  url: Nullable<string>
  filename: string
  downloadPath: string
  appendDiagnostic: (entry: BrowserPageDiagnosticEntry) => void
}
