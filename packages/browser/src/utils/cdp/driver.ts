/** CDP 页面驱动里用不着实例状态的那部分：CDP 回包的归一、键鼠码表、视口矩形。 */

import { isArray, isBoolean, isFiniteNumber, isNonBlankString, isNotNull, isObject, isPresent, isString, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserStorageEntry } from '../../types/browser.js'
import type { BrowserGeolocationOptions, BrowserGeolocationState, BrowserKeyModifier, BrowserMouseButton, BrowserPageDiagnosticLevel } from '../../types/browser.js'
import type { CdpNetworkCookie, CdpPageTargetDescription } from '../../types/cdp.js'
import type { CdpRuntimeEvaluateResponse, CdpRuntimeRemoteObject, CdpTargetListEntry } from '../../types/cdp.js'
import type { BrowserPageDriverCookie } from '../../types/driver'
import type { BrowserPageDriverFetchResourceOptions, BrowserPageDriverScreenshot, BrowserPageDriverScreenshotOptions } from '../../types/driver'

/** CPU 减速倍率归一：1 表示不减速。 */
export function normalizeCpuThrottlingRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1
  return Math.min(20, Math.max(1, rate))
}

/** 从 CDP 的 target 列表条目里读出它的 id。 */
export function resolveTargetListEntryId(entry: CdpTargetListEntry): Nullable<string> {
  if (isNonBlankString(entry.id)) return entry.id
  if (isString(entry.webSocketDebuggerUrl)) return resolveCdpTargetId(entry.webSocketDebuggerUrl)

  return null
}

/** 从 CDP Runtime.evaluate 的回包里剥出真正的值。 */
export function unwrapRuntimeEvaluateValue(response: CdpRuntimeEvaluateResponse): unknown {
  const result = response.result
  if (!result) return null
  if ('value' in result) return result.value
  if (result.unserializableValue) return result.unserializableValue
  return toNullable(result.description)
}

/** 把 CDP 的 console 类型翻成诊断级别。 */
export function resolveConsoleLevel(type: unknown): BrowserPageDiagnosticLevel {
  if (!isString(type)) return 'info'

  switch (type) {
    case 'debug':
      return 'debug'
    case 'warning':
      return 'warning'
    case 'error':
    case 'assert':
      return 'error'
    default:
      return 'info'
  }
}

/** 把一个 console 参数转成能给模型看的字符串。 */
export function stringifyConsoleArgument(arg: unknown): Nullable<string> {
  if (!isObject(arg)) return null

  const remoteObject = arg as CdpRuntimeRemoteObject
  if (isString(remoteObject.value)) return remoteObject.value
  if (isFiniteNumber(remoteObject.value)) return String(remoteObject.value)
  if (isString(remoteObject.unserializableValue)) return remoteObject.unserializableValue
  if (isString(remoteObject.description)) return remoteObject.description
  if (isString(remoteObject.type)) return remoteObject.type

  return null
}

/** 从 CDP 的调用栈里读出这条 console 出自哪个文件与行列。 */
export function readConsoleSource(stackTrace: unknown): {
  url: Nullable<string>
  line: Nullable<number>
  column: Nullable<number>
} {
  if (!isObject(stackTrace)) return { url: null, line: null, column: null }

  const frames = (stackTrace as { callFrames?: unknown }).callFrames
  if (!isArray(frames)) return { url: null, line: null, column: null }

  const frame = frames[0]
  if (!isObject(frame)) return { url: null, line: null, column: null }

  const rawFrame = frame as { url?: unknown; lineNumber?: unknown; columnNumber?: unknown }
  return {
    url: isNonBlankString(rawFrame.url) ? rawFrame.url : null,
    line: isFiniteNumber(rawFrame.lineNumber) ? Math.round(rawFrame.lineNumber) + 1 : null,
    column: isFiniteNumber(rawFrame.columnNumber) ? Math.round(rawFrame.columnNumber) + 1 : null,
  }
}

/** 读 console 事件的时间戳；没有就用当前时间。 */
export function resolveConsoleTimestamp(timestamp: unknown): number {
  if (!isFiniteNumber(timestamp)) return Date.now()

  return Math.round(timestamp)
}

/** 存储值归一成字符串。 */
export function normalizeStorageString(value: unknown): string {
  if (isString(value)) return value
  if (isFiniteNumber(value)) return String(value)
  if (isBoolean(value)) return String(value)
  if (!isPresent(value)) return ''

  return String(value)
}

/** cookie 的必填字段归一成字符串。 */
export function normalizeCookieString(value: unknown): string {
  if (isString(value)) return value
  if (isFiniteNumber(value)) return String(value)
  if (isBoolean(value)) return String(value)

  return ''
}

/** cookie 的可选字符串字段归一；没有就当缺席。 */
export function normalizeOptionalCookieString(value: unknown): LooseOptional<string> {
  if (!isString(value)) return null

  return value
}

/** cookie 的可选数字字段归一；不是有限数就当缺席。 */
export function normalizeOptionalCookieNumber(value: unknown): LooseOptional<number> {
  if (!isFiniteNumber(value)) return null

  return value
}

/** cookie 的可选布尔字段归一；不是布尔就当缺席。 */
export function normalizeOptionalCookieBoolean(value: unknown): LooseOptional<boolean> {
  if (!isBoolean(value)) return null

  return value
}

/** 按截图选项算出这次要截的视口矩形。 */
export function buildViewportRect(options: BrowserPageDriverScreenshotOptions): BrowserPageDriverScreenshot['capture']['viewport'] {
  return {
    x: Math.max(0, Math.round(options.metadata.scrollX)),
    y: Math.max(0, Math.round(options.metadata.scrollY)),
    width: Math.max(1, Math.round(options.metadata.viewportWidth)),
    height: Math.max(1, Math.round(options.metadata.viewportHeight)),
  }
}

/** 取正整数；不是有限数就用兜底值。 */
export function clampPositiveInteger(value: unknown, fallback: number): number {
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) return Math.max(1, Math.round(fallback))

  return Math.max(1, Math.round(numberValue))
}

/** 从 CDP 回包里读出 DOM 节点 id。 */
export function readNodeId(value: unknown): Nullable<number> {
  if (!isFiniteNumber(value)) return null

  return Math.round(value)
}

/** 页面缩放因子归一到合法区间。 */
export function clampPageZoomFactor(value: unknown): number {
  if (!isFiniteNumber(value)) return 1

  const normalized = Math.round(value * 100) / 100
  return Math.min(Math.max(normalized, 0.25), 3)
}

/** 环境模拟的字符串字段归一：空串当成「不模拟」。 */
export function normalizeNullableEmulationString(value: string): Nullable<string> {
  const normalized = value.trim()
  return isNonBlankString(normalized) ? normalized : null
}

/** 地理位置入参归一成运行时的状态形状。 */
export function normalizeGeolocation(options: BrowserGeolocationOptions): BrowserGeolocationState {
  if (!isFiniteNumber(options.latitude) || options.latitude < -90 || options.latitude > 90) {
    throw new AppError('VALIDATION', '地理位置 latitude 必须在 -90 到 90 之间。')
  }
  if (!isFiniteNumber(options.longitude) || options.longitude < -180 || options.longitude > 180) {
    throw new AppError('VALIDATION', '地理位置 longitude 必须在 -180 到 180 之间。')
  }

  const accuracy = isFiniteNumber(options.accuracy)
    ? Math.max(0, options.accuracy)
    : 1

  return {
    latitude: options.latitude,
    longitude: options.longitude,
    accuracy,
  }
}

/** 复制一份地理位置状态，避免调用方改到内部的那份。 */
export function cloneGeolocation(
  geolocation: Nullable<BrowserGeolocationState>
): Nullable<BrowserGeolocationState> {
  if (isNotNull(geolocation)) return { ...geolocation }

  return null
}

/** 拼一段在页面里带 cookie 抓资源的脚本。 */
export function buildFetchResourceScript(options: BrowserPageDriverFetchResourceOptions): string {
  const url = JSON.stringify(options.url)
  const referer = JSON.stringify(options.referer?.trim() || null)

  return `;(async () => {
const resourceUrl = ${url};
const referer = ${referer};
const fetchOptions = {
  credentials: 'include',
  cache: 'no-store',
};
if (referer) fetchOptions.referrer = referer;
const response = await fetch(resourceUrl, fetchOptions);
const buffer = await response.arrayBuffer();
const bytes = new Uint8Array(buffer);
let binary = '';
const chunkSize = 0x8000;
for (let index = 0; index < bytes.length; index += chunkSize) {
  binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize));
}
return {
  ok: response.ok,
  status: response.status,
  mimeType: response.headers.get('content-type'),
  contentLength: Number(response.headers.get('content-length') || bytes.byteLength),
  data: btoa(binary),
};
})()`
}

/** CDP 的修饰键位掩码：协议规定的数，跟着用它的那个函数放。 */
const CdpKeyModifierMasks: Record<BrowserKeyModifier, number> = {
  alt: 1,
  control: 2,
  meta: 4,
  shift: 8,
}

/** 把修饰键名翻成 CDP 的位掩码。 */
export function resolveKeyboardModifiers(modifiers: BrowserKeyModifier[]): number {
  return modifiers.reduce((mask, modifier) => mask | CdpKeyModifierMasks[modifier], 0)
}

/** 把按键名翻成 CDP 的 code。 */
export function resolveKeyCode(key: string): string {
  if (key.length === 1) return `Key${key.toUpperCase()}`

  return key
}

/** 把鼠标键名翻成 CDP 认的取值。 */
export function resolveMouseButton(button: BrowserMouseButton): 'left' | 'middle' | 'right' {
  switch (button) {
    case 'middle':
      return 'middle'
    case 'right':
      return 'right'
    case 'left':
      return 'left'
  }
}

/** 从 CDP 的 WebSocket 地址里读出它连的是哪个 target。 */
export function resolveCdpTargetId(webSocketUrl: string): Nullable<string> {
  if (!URL.canParse(webSocketUrl)) return null

  const pathname = new URL(webSocketUrl).pathname
  const targetId = pathname.split('/').at(-1)?.trim() || ''
  return targetId || null
}

/** CDP 的标签页描述归一；形状不对就当没有。 */
export function normalizePageTargetDescription(entry: unknown): Nullable<CdpPageTargetDescription> {
  if (!isObject(entry)) return null

  const target = entry as CdpTargetListEntry
  if (target.type !== 'page') return null

  const id = resolveTargetListEntryId(target)
  if (!id || !isNonBlankString(target.webSocketDebuggerUrl)) return null

  return {
    id,
    url: isString(target.url) ? target.url : '',
    title: isString(target.title) ? target.title : '',
    webSocketDebuggerUrl: target.webSocketDebuggerUrl,
  }
}

/** 把 console 的一组参数拼成一句可读的消息。 */
export function resolveConsoleMessage(args: unknown): string {
  if (!isArray(args)) return 'console event'

  const parts = args
    .map((arg) => stringifyConsoleArgument(arg))
    .filter(isNonBlankString)
  return parts.join(' ') || 'console event'
}

/** localStorage / sessionStorage 的一条记录归一，并按上限截断值。 */
export function normalizeDomStorageEntry(
  entry: unknown,
  maxValueChars: number
): Nullable<BrowserStorageEntry> {
  if (!isArray(entry) || entry.length < 2) return null
  const name = normalizeStorageString(entry[0]).trim()
  if (!name) return null

  const rawValue = normalizeStorageString(entry[1])
  return {
    name,
    value: rawValue.length > maxValueChars ? rawValue.slice(0, maxValueChars) : rawValue,
    valueTruncated: rawValue.length > maxValueChars,
  }
}

/** CDP 的 cookie 归一成回执的形状。 */
export function normalizeNetworkCookie(cookie: unknown): Nullable<BrowserPageDriverCookie> {
  if (!isObject(cookie)) return null

  const rawCookie = cookie as CdpNetworkCookie
  if (!isNonBlankString(rawCookie.name)) return null

  return {
    name: rawCookie.name,
    value: normalizeCookieString(rawCookie.value),
    domain: normalizeOptionalCookieString(rawCookie.domain),
    path: normalizeOptionalCookieString(rawCookie.path),
    expires: normalizeOptionalCookieNumber(rawCookie.expires),
    size: normalizeOptionalCookieNumber(rawCookie.size),
    httpOnly: normalizeOptionalCookieBoolean(rawCookie.httpOnly),
    secure: normalizeOptionalCookieBoolean(rawCookie.secure),
    session: normalizeOptionalCookieBoolean(rawCookie.session),
    sameSite: normalizeOptionalCookieString(rawCookie.sameSite),
  }
}

/** 把区域截图的入参翻成 CDP 截图要的裁剪矩形。 */
export function resolveRegionScreenshotInput(
  options: BrowserPageDriverScreenshotOptions
): {
  params: Record<string, unknown>
  capture: BrowserPageDriverScreenshot['capture']
} {
  const clip = options.clip!
  const x = Math.max(0, Math.round(clip.x))
  const y = Math.max(0, Math.round(clip.y))
  const width = Math.max(1, Math.round(clip.width))
  const height = Math.max(1, Math.round(clip.height))

  return {
    params: {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x,
        y,
        width,
        height,
        scale: 1,
      },
    },
    capture: {
      mode: 'region',
      coordinateSpace: 'page-css-px',
      x,
      y,
      width,
      height,
      documentWidth: Math.max(1, Math.round(options.metadata.documentWidth)),
      documentHeight: Math.max(1, Math.round(options.metadata.documentHeight)),
      viewport: buildViewportRect(options),
      clipped: width < clip.width || height < clip.height,
    },
  }
}

/** 从 CDP 的 WebSocket 地址推出它对应的 /json/list 地址。 */
export function resolveCdpTargetListUrl(webSocketUrl: string): Nullable<string> {
  if (!URL.canParse(webSocketUrl)) return null

  const url = new URL(webSocketUrl)
  switch (url.protocol) {
    case 'ws:':
      url.protocol = 'http:'
      break
    case 'wss:':
      url.protocol = 'https:'
      break
    default:
      return null
  }
  url.pathname = '/json/list'
  url.search = ''
  url.hash = ''
  return url.toString()
}
