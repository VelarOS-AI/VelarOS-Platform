/** CDP 页面数据引擎里用不着实例状态的那部分：页面回包的归一与汇总。 */

import { isEmpty, optionalWhen } from '@velaros-ai/core'
import { isNotNull } from '@velaros-ai/core'
import { isArray, isBoolean, isFiniteNumber, isNonBlankString, isPlainObject, isString, isTrue } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserStorageEntry } from '../../types/browser.js'
import type { BrowserListPageResourcesResult, BrowserMediaSourceItem, BrowserPageDiagnostics } from '../../types/browser.js'
import type { BrowserPageDriverCookie } from '../../types/driver'
import { readBoundedString } from '../numbers.js'
import { readFiniteNumber } from '../numbers.js'
import { resolveWorkspaceFilePath } from '../workspace-paths.js'

/** 有值才往 cookie 详情里写这个字符串字段。 */
export function assignCookieStringDetail(
  details: Record<string, unknown>,
  key: string,
  value: LooseOptional<string>
): void {
  if (isNonBlankString(value)) {
    details[key] = value
  }
}

/** 有值才往 cookie 详情里写这个数字字段。 */
export function assignCookieNumberDetail(
  details: Record<string, unknown>,
  key: string,
  value: LooseOptional<number>
): void {
  if (isFiniteNumber(value)) {
    details[key] = value
  }
}

/** 有值才往 cookie 详情里写这个布尔字段。 */
export function assignCookieBooleanDetail(
  details: Record<string, unknown>,
  key: string,
  value: LooseOptional<boolean>
): void {
  if (isBoolean(value)) {
    details[key] = value
  }
}

/** 抓资源的 URL 归一；不是 http(s) 就报错。 */
export function normalizeFetchResourceUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) {
    throw new AppError('VALIDATION', 'url 不能为空。')
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch (error) {
    throw new AppError('VALIDATION', `无效的资源 URL：${rawUrl}`, error)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('VALIDATION', '仅支持 http(s) 资源 URL。', undefined, {
      protocol: parsed.protocol,
    })
  }

  return parsed.toString()
}

/** 页面脚本给的媒体条目归一成回执的形状。 */
export function normalizeMediaSourceItems(value: unknown): BrowserMediaSourceItem[] {
  if (!isArray(value)) return []

  return value
    .map((item): Nullable<BrowserMediaSourceItem> => {
      if (!isPlainObject(item) || !isString(item.url)) return null

      const kind = item.kind
      const normalizedKind =
        kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'other'
          ? kind
          : 'other'

      return {
        kind: normalizedKind,
        url: item.url,
        fetchable: isTrue(item.fetchable),
        tagName: readBoundedString(item.tagName, 32),
        attribute: readBoundedString(item.attribute, 32),
        alt: readBoundedString(item.alt, 240),
        // 保留原语义：非有限值与 0 都记为缺席（0 尺寸的媒体项对调用方无意义）。
        width: mediaDimension(item.width),
        height: mediaDimension(item.height),
      }
    })
    .filter((entry): entry is BrowserMediaSourceItem => !!entry)
}

/** 页面脚本给的链接清单归一成回执的形状。 */
export function normalizePageResourceLinks(value: unknown): BrowserListPageResourcesResult['links'] {
  if (!isArray(value)) return []

  return value
    .map((item): Nullable<BrowserListPageResourcesResult['links'][number]> => {
      if (!isPlainObject(item) || !isString(item.href)) return null
      return {
        text: readBoundedString(item.text, 240),
        href: item.href,
      }
    })
    .filter((entry): entry is BrowserListPageResourcesResult['links'][number] => !!entry)
}

/** 页面脚本给的 iframe 清单归一成回执的形状。 */
export function normalizePageResourceIframes(value: unknown): BrowserListPageResourcesResult['iframes'] {
  if (!isArray(value)) return []

  return value
    .map((item): Nullable<BrowserListPageResourcesResult['iframes'][number]> => {
      if (!isPlainObject(item)) return null
      return {
        src: readBoundedString(item.src, 4096),
        title: readBoundedString(item.title, 240),
        sandbox: readBoundedString(item.sandbox, 240),
      }
    })
    .filter((entry): entry is BrowserListPageResourcesResult['iframes'][number] => !!entry)
}

/** origin 归一；不是合法 origin 就当没有。 */
export function normalizeOriginValue(value: unknown): Nullable<string> {
  if (!isString(value) || !URL.canParse(value)) return null

  return new URL(value).origin
}

/** 从 URL 推出它的 origin；推不出来就原样返回。 */
export function resolveOrigin(url: string): string {
  return URL.canParse(url) ? new URL(url).origin : ''
}

/** 给计数表里的一项加一。 */
export function incrementCount(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1
}

/** 计数表按数量从多到少排一遍。 */
export function sortCountRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  )
}

/** 从一条诊断里读出 HTTP 状态码。 */
export function readDiagnosticNetworkStatus(
  entry: BrowserPageDiagnostics['entries'][number]
): Nullable<number> {
  if (entry.kind !== 'network') return null

  const detailStatus = isPlainObject(entry.details) ? entry.details.status : null
  const status = isFiniteNumber(detailStatus) ? detailStatus : entry.code
  if (!isFiniteNumber(status) || status <= 0) return null

  return Math.round(status)
}

/** 从一条诊断里读出资源类型。 */
export function readDiagnosticResourceType(
  entry: BrowserPageDiagnostics['entries'][number]
): Nullable<string> {
  if (entry.kind !== 'network') return null
  if (!isPlainObject(entry.details)) return null

  const resourceType = entry.details.resourceType
  if (!isString(resourceType)) return null

  return resourceType.trim() || null
}

/** 把上传用的相对路径解析成真实路径，并确认它没走出站点工作区。 */
export async function resolveUploadFilePath(workspaceRoot: string, requestedPath: string): Promise<string> {
  return (await resolveWorkspaceFilePath(workspaceRoot, requestedPath, 'filePath')).path
}

/**
 * 媒体项尺寸归一：非有限值与 0 都记为缺席。0 宽/高的媒体项对调用方没有可用信息，
 * 保持与旧实现一致的「假值即 null」语义，避免把占位元素当成真实媒体。
 */
export function mediaDimension(value: unknown): Nullable<number> {
  const parsed = readFiniteNumber(value)
  return parsed ? Math.round(parsed) : null
}

/** 把一条 cookie 的各字段拼成回执里的 details。 */
export function buildExternalCookieDetails(cookie: BrowserPageDriverCookie): Record<string, unknown> {
  const details: Record<string, unknown> = {}
  assignCookieStringDetail(details, 'domain', cookie.domain)
  assignCookieStringDetail(details, 'path', cookie.path)
  assignCookieNumberDetail(details, 'expires', cookie.expires)
  assignCookieNumberDetail(details, 'size', cookie.size)
  assignCookieBooleanDetail(details, 'httpOnly', cookie.httpOnly)
  assignCookieBooleanDetail(details, 'secure', cookie.secure)
  assignCookieBooleanDetail(details, 'session', cookie.session)
  assignCookieStringDetail(details, 'sameSite', cookie.sameSite)
  return details
}

/** origin 列表归一：去掉不合法的，并去重。 */
export function normalizeOriginList(value: unknown): string[] {
  if (!isArray(value)) return []

  return [...new Set(value.map((origin) => normalizeOriginValue(origin)).filter(isString))]
    .sort()
}

/** 把一批诊断按级别、种类、来源、状态码和资源类型各聚合一份。 */
export function summarizePageDiagnostics(
  entries: BrowserPageDiagnostics['entries']
): BrowserPageDiagnostics['summary'] {
  const byLevel: Record<string, number> = {}
  const byKind: Record<string, number> = {}
  const byOrigin: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  const byResourceType: Record<string, number> = {}

  for (const entry of entries) {
    incrementCount(byLevel, entry.level)
    incrementCount(byKind, entry.kind)

    const origin = entry.url ? resolveOrigin(entry.url) : ''
    if (origin) incrementCount(byOrigin, origin)

    const status = readDiagnosticNetworkStatus(entry)
    if (isNotNull(status)) incrementCount(byStatus, String(status))

    const resourceType = readDiagnosticResourceType(entry)
    if (resourceType) incrementCount(byResourceType, resourceType)
  }

  return {
    total: entries.length,
    byLevel: sortCountRecord(byLevel),
    byKind: sortCountRecord(byKind),
    byOrigin: sortCountRecord(byOrigin),
    byStatus: sortCountRecord(byStatus),
    byResourceType: sortCountRecord(byResourceType),
  }
}

/** 把一条浏览器 cookie 映射成存储条目，并按上限截断值。 */
export function mapExternalCookieToStorageEntry(
  cookie: BrowserPageDriverCookie,
  maxValueChars: number
): Nullable<BrowserStorageEntry> {
  const name = cookie.name.trim()
  if (!name) return null

  const value = String(cookie.value ?? '')
  const details = buildExternalCookieDetails(cookie)
  return {
    name,
    value: value.length > maxValueChars ? value.slice(0, maxValueChars) : value,
    valueTruncated: value.length > maxValueChars,
    details: optionalWhen(!isEmpty(Object.keys(details)), details),
  }
}

/** 页面资源的 origin 清单归一；读不出来时按当前页面的 origin 兜底。 */
export function normalizePageResourceOrigins(
  value: unknown,
  fallbackUrl: string
): BrowserListPageResourcesResult['resourceOrigins'] {
  const pageOrigin = resolveOrigin(fallbackUrl)
  if (!isPlainObject(value)) return {
      pageOrigin,
      sameOrigin: [],
      crossOrigin: [],
      totalUniqueOrigins: 0,
    }

  const sameOrigin = normalizeOriginList(value.sameOrigin)
  const crossOrigin = normalizeOriginList(value.crossOrigin)
  const uniqueOrigins = new Set([...sameOrigin, ...crossOrigin])

  return {
    pageOrigin: normalizeOriginValue(value.pageOrigin) ?? pageOrigin,
    sameOrigin,
    crossOrigin,
    totalUniqueOrigins: Math.max(
      uniqueOrigins.size,
      Math.round(readFiniteNumber(value.totalUniqueOrigins) ?? uniqueOrigins.size)
    ),
  }
}
