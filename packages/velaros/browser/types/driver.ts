import type { BrowserPageDriverDownloadItem } from '../contract/requires.js'

import type { BrowserClickCoordinatesOptions, BrowserDragCoordinatesOptions, BrowserMouseButton, BrowserMoveMouseOptions, BrowserNetworkControlOptions, BrowserNetworkRequestDetailsResult, BrowserPageDiagnosticKind, BrowserScreenshotCaptureRegion, BrowserScreenshotMetadata, BrowserScreenshotRect } from './browser.js'

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
  /** 按住的修饰键，CDP 的位掩码（Alt 1、Control 2、Meta 4、Shift 8）；没有按着的是 0。 */
  modifiers?: number
  onPointerEvent?: LooseOptional<BrowserPageDriverPointerListener>
}

export interface BrowserPageDriverDragCoordinatesOptions extends BrowserDragCoordinatesOptions {
  /** 按住的修饰键，CDP 的位掩码。 */
  modifiers?: number
  onPointerEvent?: LooseOptional<BrowserPageDriverPointerListener>
}

/** 美式键盘上的一个键：CDP 键盘事件要的 key、code、keyCode，按下时上屏的文字与左右位置。 */
export interface BrowserKeyDefinition {
  /** DOM 的 key 值：Enter、Shift、a、中。 */
  key: string
  /** DOM 的 code 值：Enter、ShiftLeft、KeyA；没有物理键位的字符是空字符串。 */
  code: string
  /** Windows 虚拟键码；没有物理键位的字符是 0。 */
  keyCode: number
  /** 不按修饰键时上屏的文字；不出字的键缺席。 */
  text?: string
  /** 按着 Shift 时的 key 与上屏文字（字母是大写）；和不按一样时缺席。 */
  shifted?: string
  /** 左右之分：左边的修饰键是 1。 */
  location?: number
}

/** 一个键盘事件：`Input.dispatchKeyEvent` 的参数。keyDown 带 text 才会上屏；Shift 这类不出字的键用 rawKeyDown。 */
export interface BrowserPageDriverKeyEvent {
  type: 'keyDown' | 'rawKeyDown' | 'keyUp'
  key: string
  code: string
  windowsVirtualKeyCode: number
  /** 按下时上屏的文字（Enter 是 \r）；不出字的键缺席。 */
  text?: string
  /** 不算修饰键时会上屏的文字。 */
  unmodifiedText?: string
  /** 按住的修饰键，CDP 的位掩码（Alt 1、Control 2、Meta 4、Shift 8）。 */
  modifiers: number
  /** 左右之分：左边的修饰键是 1，右边是 2，小键盘是 3；普通键缺席。 */
  location?: number
  /** macOS 上的编辑命令（selectAll、copy、paste……）：那里的快捷键靠它生效，页面收到的按键事件不变。 */
  commands?: string[]
}

/** 一个鼠标事件：`Input.dispatchMouseEvent` 的参数，坐标是视口 CSS 像素。 */
export interface BrowserPageDriverMouseEvent {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel'
  x: number
  y: number
  button: 'none' | BrowserMouseButton
  /** 按着的鼠标键，CDP 的位掩码（左 1、右 2、中 4）。 */
  buttons: number
  clickCount?: number
  /** 按住的修饰键，CDP 的位掩码。 */
  modifiers: number
  deltaX?: number
  deltaY?: number
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

export interface BrowserPageDriverDownloadEvent {
  url: Nullable<string>
  item: BrowserPageDriverDownloadItem
}

export type BrowserPageDriverDownloadListener = (
  event: BrowserPageDriverDownloadEvent
) => void

