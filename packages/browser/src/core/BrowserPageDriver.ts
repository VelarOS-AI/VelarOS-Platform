import type {
  CdpScreencastConsumerOptions,
  CdpScreencastStartOptions,
  ScreencastCapturedFrame,
} from './BrowserScreencastRecorder'
import type { BrowserClickCoordinatesOptions, BrowserDragCoordinatesOptions, BrowserEmulationOptions, BrowserGeolocationState, BrowserMouseButton, BrowserMoveMouseOptions, BrowserNetworkControlOptions, BrowserNetworkRequestDetailsOptions, BrowserNetworkRequestDetailsResult, BrowserNetworkResponseBodyOptions, BrowserNetworkThrottlingPreset, BrowserOriginStorage, BrowserPageDiagnosticEntry, BrowserPageTargetInfo, BrowserPressKeyOptions, BrowserScreenshotCaptureRegion, BrowserScreenshotMetadata, BrowserScreenshotRect, BrowserSwitchPageTargetOptions, BrowserTypeTextOptions, BrowserViewportOptions } from './types.js'

export type BrowserPageDriverKind = 'webview' | 'external'

export interface BrowserPageDriverState {
  url: string
  title: string
}

export interface BrowserPageDriverPointerEvent {
  x: number
  y: number
  phase: 'move' | 'down' | 'up'
  button?: LooseOptional<BrowserMouseButton>
}

export type BrowserPageDriverPointerListener = (
  event: BrowserPageDriverPointerEvent
) => void

export interface BrowserPageDriverMoveMouseOptions extends BrowserMoveMouseOptions {
  onPointerEvent?: LooseOptional<BrowserPageDriverPointerListener>
}

export interface BrowserPageDriverClickCoordinatesOptions extends BrowserClickCoordinatesOptions {
  onPointerEvent?: LooseOptional<BrowserPageDriverPointerListener>
}

export interface BrowserPageDriverDragCoordinatesOptions extends BrowserDragCoordinatesOptions {
  onPointerEvent?: LooseOptional<BrowserPageDriverPointerListener>
}

export interface BrowserPageDriverScreenshotOptions {
  mode: 'viewport' | 'full-page' | 'region'
  metadata: BrowserScreenshotMetadata
  clip?: LooseOptional<BrowserScreenshotRect>
  maxWidth?: LooseOptional<number>
  maxHeight?: LooseOptional<number>
}

export interface BrowserPageDriverScreenshot {
  bytes: Buffer
  capture: BrowserScreenshotCaptureRegion
}

export interface BrowserPageDriverFileInputOptions {
  selector: string
  files: string[]
}

export interface BrowserPageDriverPdfOptions {
  printBackground: boolean
}

export interface BrowserPageDriverFetchResourceOptions {
  url: string
  referer?: LooseOptional<string>
}

export interface BrowserPageDriverFetchResourceResult {
  ok: boolean
  status: number
  mimeType: Nullable<string>
  contentLength?: LooseOptional<number>
  bytes: Buffer
}

export interface BrowserPageDriverDiagnosticsOptions {
  limit: number
  clear?: boolean
}

export interface BrowserPageDriverCookie {
  name: string
  value: string
  domain?: LooseOptional<string>
  path?: LooseOptional<string>
  expires?: LooseOptional<number>
  size?: LooseOptional<number>
  httpOnly?: LooseOptional<boolean>
  secure?: LooseOptional<boolean>
  session?: LooseOptional<boolean>
  sameSite?: LooseOptional<string>
}

export interface BrowserPageDriverCookieOptions {
  scope?: LooseOptional<'current-url' | 'all'>
}

export interface BrowserPageDriverStorageOriginOptions {
  includeLocalStorage?: boolean
  includeSessionStorage?: boolean
  limit: number
  maxValueChars: number
}

export interface BrowserPageDriverNetworkControlState {
  offline: boolean
  extraHTTPHeaders: Record<string, string>
  blockedURLPatterns: string[]
  blockedResourceTypes: string[]
  mockResponses: NonNullable<BrowserNetworkControlOptions['mockResponses']>
}

export interface BrowserPageDriverNetworkResponseBodyResult {
  requestId: string
  body: string
  base64Encoded: boolean
  bodyLength: number
  returnedChars: number
  bodyTruncated: boolean
}

export type BrowserPageDriverNetworkRequestDetailsResult = Omit<
  BrowserNetworkRequestDetailsResult,
  'url' | 'capturedAt'
>

export interface BrowserPageDriverNetworkIdleOptions {
  idleMs: number
  timeoutMs: number
}

export interface BrowserPageDriverEmulationState {
  colorScheme: 'light' | 'dark' | 'no-preference'
  reducedMotion: 'reduce' | 'no-preference'
  timezoneId: Nullable<string>
  locale: Nullable<string>
  geolocation: Nullable<BrowserGeolocationState>
  cpuThrottlingRate: number
  networkThrottling: BrowserNetworkThrottlingPreset
}

export interface BrowserPageDriverDownloadItem {
  getFilename(): string
  getMimeType(): string
  getTotalBytes(): number
  getReceivedBytes(): number
  getSavePath(): string
  pause(): void
  cancel(): void
  setSavePath(path: string): void
  resume(): void
  once(event: 'done', listener: (_event: unknown, state: string) => void): unknown
}

export interface BrowserPageDriverDownloadEvent {
  url: Nullable<string>
  item: BrowserPageDriverDownloadItem
}

export type BrowserPageDriverDownloadListener = (
  event: BrowserPageDriverDownloadEvent
) => void

export interface BrowserPageDriver {
  kind: BrowserPageDriverKind
  executeJavaScript<T = unknown>(script: string, userGesture?: boolean): Promise<T>
  navigateTo(url: string): Promise<BrowserPageDriverState>
  refreshPageState(): Promise<BrowserPageDriverState>
  bringToFront(): Promise<void>
  captureScreenshot?(
    options: BrowserPageDriverScreenshotOptions
  ): Promise<BrowserPageDriverScreenshot>
  typeText?(options: BrowserTypeTextOptions): Promise<void>
  pressKey?(options: BrowserPressKeyOptions): Promise<void>
  moveMouse?(options: BrowserPageDriverMoveMouseOptions): Promise<void>
  clickCoordinates?(options: BrowserPageDriverClickCoordinatesOptions): Promise<void>
  dragCoordinates?(options: BrowserPageDriverDragCoordinatesOptions): Promise<void>
  setViewport?(options: BrowserViewportOptions): Promise<void>
  setFileInputFiles?(options: BrowserPageDriverFileInputOptions): Promise<boolean>
  printToPdf?(options: BrowserPageDriverPdfOptions): Promise<Buffer>
  fetchResource?(
    options: BrowserPageDriverFetchResourceOptions
  ): Promise<BrowserPageDriverFetchResourceResult>
  getPageZoomFactor?(): number
  setPageZoomFactor?(zoomFactor: number): Promise<void>
  readDiagnostics?(options: BrowserPageDriverDiagnosticsOptions): BrowserPageDiagnosticEntry[]
  listPageTargets?(): Promise<BrowserPageTargetInfo[]>
  switchPageTarget?(options: BrowserSwitchPageTargetOptions): Promise<BrowserPageDriver>
  onDownload?(listener: BrowserPageDriverDownloadListener): () => void
  grantPermissions?(permissions: string[], origin?: LooseOptional<string>): Promise<void>
  readCookies?(options?: BrowserPageDriverCookieOptions): Promise<BrowserPageDriverCookie[]>
  readStorageOrigins?(
    options: BrowserPageDriverStorageOriginOptions
  ): Promise<BrowserOriginStorage[]>
  configureNetwork?(
    options: BrowserNetworkControlOptions
  ): Promise<BrowserPageDriverNetworkControlState>
  readNetworkResponseBody?(
    options: BrowserNetworkResponseBodyOptions
  ): Promise<BrowserPageDriverNetworkResponseBodyResult>
  readNetworkRequestDetails?(
    options: BrowserNetworkRequestDetailsOptions
  ): Promise<BrowserPageDriverNetworkRequestDetailsResult>
  waitForNetworkIdle?(options: BrowserPageDriverNetworkIdleOptions): Promise<void>
  configureEmulation?(
    options: BrowserEmulationOptions
  ): Promise<BrowserPageDriverEmulationState>
  getEmulationState?(): BrowserPageDriverEmulationState
  /** 开始录制性能 trace（CDP Tracing domain）。 */
  startTracing?(): Promise<void>
  /** 停止录制并返回全部 trace 事件。 */
  stopTracing?(): Promise<unknown[]>
  isTracing?(): boolean
  /** 采集 V8 堆快照，流式写入 sink。 */
  captureHeapSnapshot?(sink: (chunk: string) => void): Promise<{ chunks: number; bytes: number }>
  /** 开始页面录屏（CDP Page.startScreencast）。 */
  startScreencast?(
    options: CdpScreencastStartOptions,
    consumer?: CdpScreencastConsumerOptions
  ): Promise<void>
  /** 停止录屏并取回帧序列。 */
  stopScreencast?(): Promise<{ frames: ScreencastCapturedFrame[]; frameLimitReached: boolean }>
  isScreencasting?(): boolean
  getURL(): string
  getTitle(): string
  isDestroyed(): boolean
  dispose?(): void
}
