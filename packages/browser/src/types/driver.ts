import type { BrowserPageDriverDownloadItem } from '../contract/requires.js'

import type { BrowserClickCoordinatesOptions, BrowserDragCoordinatesOptions, BrowserGeolocationState, BrowserMouseButton, BrowserMoveMouseOptions, BrowserNetworkControlOptions, BrowserNetworkRequestDetailsResult, BrowserNetworkThrottlingPreset, BrowserPageDiagnosticKind, BrowserScreenshotCaptureRegion, BrowserScreenshotMetadata, BrowserScreenshotRect } from './browser.js'

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

/** 页面 CSS 坐标已经换算为桌面逻辑坐标后的系统指针移动请求。 */
export interface BrowserSystemPointerMoveOptions {
  x: number
  y: number
  durationMs: number
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

/** 网络采集的建立结果（内嵌页面是惰性建立的）。 */
export interface BrowserPageDriverNetworkCaptureState {
  /** 采集是不是在这次调用里才建立；true 表示在这之前发出的请求没有记录。 */
  startedNow: boolean
  /** 采集没能建立时的原因（例如 DevTools 已经接管调试器）；正常时为 null。 */
  unavailableReason: Nullable<string>
}

export interface BrowserPageDriverDiagnosticsOptions {
  /** 按种类过滤之后最多返回几条。 */
  limit: number
  /** 只要这些种类；缺席表示全部种类。过滤在取窗口之前，clear 也只清这些种类。 */
  kinds?: readonly BrowserPageDiagnosticKind[]
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

export interface BrowserPageDriverDownloadEvent {
  url: Nullable<string>
  item: BrowserPageDriverDownloadItem
}

export type BrowserPageDriverDownloadListener = (
  event: BrowserPageDriverDownloadEvent
) => void

