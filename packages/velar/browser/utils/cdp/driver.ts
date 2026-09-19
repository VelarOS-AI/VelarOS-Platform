/** CDP 页面驱动里用不着实例状态的那部分：CDP 回包的归一、键鼠码表、视口矩形。 */

import { isArray, isFiniteNumber, isNonBlankString, isObject, isString, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserFrameInfo } from '../../types/browser.js'
import type { BrowserMouseButton, BrowserPageDiagnosticLevel } from '../../types/browser.js'
import type { CdpPageFrame, CdpPageFrameTree, CdpPageTargetDescription } from '../../types/cdp.js'
import type { CdpRuntimeEvaluateResponse, CdpRuntimeRemoteObject, CdpTargetListEntry } from '../../types/cdp.js'
import type { BrowserPageDriverFetchResourceOptions, BrowserPageDriverScreenshot, BrowserPageDriverScreenshotOptions } from '../../types/driver'

/** 从 CDP 的 target 列表条目里读出它的 id。 */
export function resolveTargetListEntryId(entry: CdpTargetListEntry): Nullable<string> {
  if (isNonBlankString(entry.id)) return entry.id
  if (isString(entry.webSocketDebuggerUrl)) return resolveCdpTargetId(entry.webSocketDebuggerUrl)

  return null
}

/** 剥出 Runtime.evaluate、Runtime.callFunctionOn 回包里的值；脚本抛了没接住的异常就抛 EXECUTION_FAILED，带上异常的原话。 */
export function readRuntimeEvaluateValue(response: CdpRuntimeEvaluateResponse): unknown {
  if (response.exceptionDetails) {
    const message = response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'unknown exception'
    throw new AppError('EXECUTION_FAILED', `浏览器 CDP 脚本执行失败：${message}`, undefined, { cdpMethod: 'Runtime.evaluate' })
  }
  return unwrapRuntimeEvaluateValue(response)
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

/** 框架树顶层那个框架的源；读不出来是 null。 */
export function cdpFrameTreeOrigin(tree: unknown): Nullable<string> {
  if (!isObject(tree)) return null
  const { frame } = tree as CdpPageFrameTree
  if (!isObject(frame)) return null
  const { securityOrigin } = frame as CdpPageFrame
  return isString(securityOrigin) ? securityOrigin : null
}

/**
 * CDP 的框架树展平成一张表：id、上一层、地址、名字，与顶层页面不同源的记成 crossOrigin。
 * topOrigin 是页面顶层的源：展平跨进程 iframe 子会话上的那棵树时传进来（那棵树的根不是页面顶层）；不给就取这棵树自己的根。
 */
export function flattenCdpFrameTree(tree: unknown, topOrigin: Nullable<string> = null): BrowserFrameInfo[] {
  const frames: BrowserFrameInfo[] = []
  const visit = (node: unknown, topOrigin: Nullable<string>): void => {
    if (!isObject(node)) return
    const { frame, childFrames } = node as CdpPageFrameTree
    if (!isObject(frame)) return
    const { id, parentId, url, name, securityOrigin } = frame as CdpPageFrame
    if (!isString(id)) return
    const origin = isString(securityOrigin) ? securityOrigin : null
    const top = topOrigin ?? origin
    frames.push({
      id,
      parentId: isString(parentId) ? parentId : null,
      url: isString(url) ? url : '',
      name: isString(name) ? name : '',
      crossOrigin: isString(parentId) && origin !== top,
    })
    if (isArray(childFrames)) for (const child of childFrames) visit(child, top)
  }
  visit(tree, topOrigin)
  return frames
}
