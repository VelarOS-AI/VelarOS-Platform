/** CDP 网络控制器里用不着实例状态的那部分：请求耗时、请求头与状态的归一、诊断级别判定。 */

import { isBoolean, isFiniteNumber, isNonBlankString, isNotNull, isObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserNetworkMockResponse, BrowserPageDiagnosticLevel } from '../../types/browser.js'
import type { CdpNetworkRequestRecord } from '../../types/cdp.js'

/** 算一次请求从发出到结束花了多少毫秒。 */
export function computeNetworkRequestDurationMs(record: CdpNetworkRequestRecord): Nullable<number> {
  if (!isNotNull(record.timestamp) || !isNotNull(record.finishedTimestamp)) return null

  return Math.max(0, Math.round((record.finishedTimestamp - record.timestamp) * 1000))
}

/** 请求头归一成字符串到字符串的表。 */
export function normalizeHeadersRecord(value: unknown): Record<string, string> {
  if (!isObject(value)) return {}

  const result: Record<string, string> = {}
  for (const [name, rawValue] of Object.entries(value)) {
    if (!isNonBlankString(name)) continue

    if (isString(rawValue)) {
      result[name] = rawValue
      continue
    }
    if (isFiniteNumber(rawValue) || isBoolean(rawValue)) {
      result[name] = String(rawValue)
    }
  }

  return result
}

/** 归一成数字；不是有限数就当没有。 */
export function normalizeNullableNumber(value: unknown): Nullable<number> {
  return isFiniteNumber(value) ? value : null
}

/** 归一成整数；不是有限数就当没有。 */
export function normalizeNullableInteger(value: unknown): Nullable<number> {
  return isFiniteNumber(value) ? Math.round(value) : null
}

/** HTTP 状态码归一；不在合法范围就当没有。 */
export function normalizeNetworkStatus(status: unknown): Nullable<number> {
  if (!isFiniteNumber(status)) return null

  return Math.round(status)
}

/** 按状态码判定这条网络诊断算什么级别。 */
export function resolveNetworkResponseDiagnosticLevel(status: number): BrowserPageDiagnosticLevel {
  if (status >= 500) return 'error'
  if (status >= 400) return 'warning'

  return 'info'
}

/** CDP 的资源类型名单：协议规定的写法，跟着归一它的那个函数放。 */
const CdpNetworkResourceTypeByKey: Record<string, string> = {
  cspviolationreport: 'CSPViolationReport',
  document: 'Document',
  eventsource: 'EventSource',
  fetch: 'Fetch',
  font: 'Font',
  image: 'Image',
  manifest: 'Manifest',
  media: 'Media',
  other: 'Other',
  ping: 'Ping',
  preflight: 'Preflight',
  script: 'Script',
  signedexchange: 'SignedExchange',
  stylesheet: 'Stylesheet',
  texttrack: 'TextTrack',
  websocket: 'WebSocket',
  xhr: 'XHR',
}

/** 把宽松写法的资源类型翻成 CDP 的标准写法。 */
export function normalizeNetworkResourceTypeValue(resourceType: string): string {
  const normalizedKey = resourceType.trim().replace(/[-_\s]/g, '').toLowerCase()
  return CdpNetworkResourceTypeByKey[normalizedKey] ?? resourceType
}

/** 有值才往网络诊断的 details 里写这个字符串字段。 */
export function assignNetworkStringDetail(
  details: Record<string, unknown>,
  key: string,
  value: unknown
): void {
  if (isNonBlankString(value)) {
    details[key] = value
  }
}

/** 有值才往网络诊断的 details 里写这个布尔字段。 */
export function assignNetworkBooleanDetail(
  details: Record<string, unknown>,
  key: string,
  value: unknown
): void {
  if (isBoolean(value)) {
    details[key] = value
  }
}

/** 额外请求头归一：去掉空名与空值。 */
export function normalizeExtraHTTPHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.trim()
    if (!isNonBlankString(normalizedName)) continue

    normalized[normalizedName] = String(value)
  }
  return normalized
}

/** 拦截用的 URL pattern 归一：去空、去重。 */
export function normalizeBlockedURLPatterns(patterns: string[]): string[] {
  return [...new Set(patterns.map((pattern) => pattern.trim()).filter(isNonBlankString))]
}

/** 资源类型过滤条件归一成 CDP 的标准写法。 */
export function normalizeNetworkResourceTypeFilter(resourceType: string): string {
  const normalizedKey = resourceType.trim().replace(/[-_\s]/g, '').toLowerCase()
  if (!isNonBlankString(normalizedKey)) return ''

  const normalizedResourceType = CdpNetworkResourceTypeByKey[normalizedKey]
  if (isNonBlankString(normalizedResourceType)) return normalizedResourceType

  throw new AppError('VALIDATION', `不支持的网络资源类型：${resourceType}`)
}

/** mock 响应的状态码归一；没给就用缺省的成功码。 */
export function normalizeMockResponseStatus(status: unknown): number {
  if (!isFiniteNumber(status)) return 200

  return Math.min(Math.max(Math.round(status), 100), 599)
}

/** 复制一份 mock 规则，避免调用方改到生效中的那份。 */
export function cloneNetworkMockResponses(
  responses: BrowserNetworkMockResponse[]
): BrowserNetworkMockResponse[] {
  return responses.map((response) => ({
    ...response,
    headers: { ...(response.headers ?? {}) },
  }))
}

/** 把一条 mock 规则的响应头拼成 CDP 要的数组形状。 */
export function buildMockResponseHeaders(
  mockResponse: BrowserNetworkMockResponse
): Array<{ name: string; value: string }> {
  const headers: Array<{ name: string; value: string }> = [
    {
      name: 'content-type',
      value: mockResponse.contentType ?? 'application/json',
    },
  ]

  for (const [name, value] of Object.entries(mockResponse.headers ?? {})) {
    if (name.toLowerCase() === 'content-type') continue

    headers.push({ name, value })
  }

  return headers
}

/** 判断一个 URL 命中不命中这条 pattern。 */
export function matchesURLPattern(pattern: string, url: string): boolean {
  if (!isNonBlankString(pattern) || !isNonBlankString(url)) return false

  const source = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${source}$`).test(url)
}

/** 资源类型归一：优先用这次回包给的，其次回退到请求记录里的。 */
export function normalizeNetworkResourceType(
  resourceType: unknown,
  request?: LooseOptional<CdpNetworkRequestRecord>
): string {
  if (isNonBlankString(resourceType)) return normalizeNetworkResourceTypeValue(resourceType)

  return request?.resourceType ?? 'Other'
}

/** 要拦截的资源类型归一成 CDP 的标准写法，并去重。 */
export function normalizeBlockedResourceTypes(resourceTypes: string[]): string[] {
  return [
    ...new Set(
      resourceTypes
        .map((resourceType) => normalizeNetworkResourceTypeFilter(resourceType))
        .filter(isNonBlankString)
    ),
  ]
}

/** mock 规则归一：补齐状态码、去掉空 pattern。 */
export function normalizeNetworkMockResponses(
  responses: BrowserNetworkMockResponse[]
): BrowserNetworkMockResponse[] {
  const normalizedResponses: BrowserNetworkMockResponse[] = []
  const seenURLPatterns = new Set<string>()

  for (const response of responses) {
    const urlPattern = response.urlPattern.trim()
    if (!isNonBlankString(urlPattern) || seenURLPatterns.has(urlPattern)) continue

    seenURLPatterns.add(urlPattern)
    normalizedResponses.push({
      urlPattern,
      status: normalizeMockResponseStatus(response.status),
      contentType: isNonBlankString(response.contentType?.trim())
        ? response.contentType.trim()
        : 'application/json',
      body: isString(response.body) ? response.body : '',
      headers: normalizeExtraHTTPHeaders(response.headers ?? {}),
    })
  }

  return normalizedResponses
}

/**
 * CDP 网络子系统的共享控制器。
 *
 * 外部 `CDP` 浏览器（`CdpBrowserPageDriver` 与 WebSocket 传输）和嵌入式网页视图
 * （`webContents.debugger`）共用网络事件记账、详情读取和 `Fetch` 拦截逻辑，只在传输与事件入口上
 * 不同。控制器持有网络请求记录、离线状态、请求头和拦截规则，并通过注入的 `send`、
 * `appendDiagnostic`、`getCurrentUrl` 与 `getNetworkThrottling` 和宿主解耦。
 *
 * 离线状态与网络节流共用 `Network.emulateNetworkConditions`：离线状态归本控制器，节流状态归宿主，
 * 两者通过 `getNetworkThrottling` 回调合流，避免互相覆盖。
 */

/** 网络请求记录表上限:超出按写入顺序淘汰最旧,防止长会话无界增长。 */

export function clampPositiveInteger(value: unknown, fallback: number): number {
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) return Math.max(1, Math.round(fallback))

  return Math.max(1, Math.round(numberValue))
}
