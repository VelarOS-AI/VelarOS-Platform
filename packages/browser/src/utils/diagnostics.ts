import { isFiniteNumber, isNotNull, isPlainObject, isString, toNullable } from '@velaros-ai/core'

import type { BrowserPageDiagnosticEntry, BrowserPageDiagnosticsSummary } from '../types/browser'
import type { BrowserPageDiagnosticKind, BrowserPageDiagnostics } from '../types/browser.js'
import type { BrowserPageDriverNetworkCaptureState } from '../types/driver.js'
import type { BrowserConsoleEventFilters, BrowserConsoleEventsResult, BrowserGetPageDiagnosticsInput, BrowserNetworkEventFilters, BrowserNetworkEventsResult, BrowserPageErrorsResult } from '../types/tools.js'

/**
 * 诊断按种类取窗口：**先按种类过滤，再取最近 limit 条**。
 *
 * 顺序反过来就是一个实打实的 bug：一个 console 刷屏的页面里，「最近 50 条诊断」全是 console，
 * 再过滤网络就回 0 条（`networkTotal: 0`），而失败的请求就在更早的诊断里。
 */
export function takeBrowserDiagnosticWindow<Entry extends { kind: BrowserPageDiagnosticKind }>(
  entries: readonly Entry[],
  limit: number,
  kinds?: LooseOptional<readonly BrowserPageDiagnosticKind[]>
): Entry[] {
  const selected = kinds ? entries.filter((entry) => kinds.includes(entry.kind)) : [...entries]
  return selected.slice(-limit)
}

/**
 * 网络采集状态 → 给模型看的如实说明；采集一直在跑（没什么要说的）时返回 null。
 *
 * 内嵌页面的采集是读诊断时才建立的：不说这一句，模型看到的就是「网络事件是空的」，
 * 然后照着提示词在空列表上打转。
 */
export function buildBrowserNetworkCaptureNotice(
  state: LooseOptional<Nullable<BrowserPageDriverNetworkCaptureState>>
): Nullable<string> {
  if (!state) return null
  if (state.unavailableReason)
    return `内嵌页面的网络采集没能开始（${state.unavailableReason}），这次列不到网络事件；关掉开发者工具后再试。`

  return state.startedNow
    ? '内嵌页面的网络采集从这次调用才开始，在这之前发出的请求没有记录；重新加载页面后再列一次就能看到。'
    : null
}

/**
 * 按种类清空诊断缓冲（就地改）：kinds 缺席时全清，否则只清所选种类。
 *
 * 读一次网络事件顺手把 console 与页面异常也清掉，等于让「读」吃掉别人的证据。
 */
export function clearBrowserDiagnosticEntries<Entry extends { kind: BrowserPageDiagnosticKind }>(
  buffer: Entry[],
  kinds?: LooseOptional<readonly BrowserPageDiagnosticKind[]>
): void {
  if (!kinds) {
    buffer.splice(0, buffer.length)
    return
  }

  const kept = buffer.filter((entry) => !kinds.includes(entry.kind))
  buffer.splice(0, buffer.length, ...kept)
}

/** 从诊断缓冲里挑出页面未处理异常。 */
export function buildBrowserPageErrorsResult(
  diagnostics: BrowserPageDiagnostics,
  _input: BrowserGetPageDiagnosticsInput
): BrowserPageErrorsResult {
  const entries = diagnostics.entries.filter((entry) => entry.kind === 'page-error')

  return {
    url: diagnostics.url,
    title: diagnostics.title,
    entries,
    summary: summarizeBrowserDiagnosticEntries(entries),
    diagnosticTotal: diagnostics.entries.length,
    pageErrorTotal: entries.length,
    capturedAt: diagnostics.capturedAt,
  }
}

/** 从诊断缓冲里挑出网络事件并按状态码、资源类型、失败与否过滤。 */
export function buildBrowserNetworkEventsResult(
  diagnostics: BrowserPageDiagnostics,
  input: BrowserGetPageDiagnosticsInput
): BrowserNetworkEventsResult {
  const filters = normalizeBrowserNetworkEventFilters(input)
  const networkEntries = diagnostics.entries.filter((entry) => entry.kind === 'network')
  const entries = networkEntries.filter((entry) => matchesBrowserNetworkEventFilters(entry, filters))

  return {
    url: diagnostics.url,
    title: diagnostics.title,
    entries,
    summary: summarizeBrowserDiagnosticEntries(entries),
    filters,
    diagnosticTotal: diagnostics.entries.length,
    networkTotal: networkEntries.length,
    networkCaptureNotice: toNullable(diagnostics.networkCaptureNotice),
    capturedAt: diagnostics.capturedAt,
  }
}

/** 把网络过滤入参归一化成确定的形状。 */
export function normalizeBrowserNetworkEventFilters(
  input: BrowserGetPageDiagnosticsInput
): BrowserNetworkEventFilters {
  return {
    status: toNullable(input.status),
    resourceType: input.resourceType?.trim() || null,
    failedOnly: !!input.failedOnly,
  }
}

/** 判一条网络事件过不过网络过滤条件。 */
export function matchesBrowserNetworkEventFilters(
  entry: BrowserPageDiagnosticEntry,
  filters: BrowserNetworkEventFilters
): boolean {
  if (filters.status && readBrowserDiagnosticStatus(entry) !== filters.status) return false
  if (filters.resourceType && readBrowserDiagnosticResourceType(entry) !== filters.resourceType) return false
  if (filters.failedOnly && !isFailedBrowserNetworkEvent(entry)) return false

  return true
}

/** 判一条网络事件算不算失败：级别是错误 / 警告，或状态码不小于 400。 */
export function isFailedBrowserNetworkEvent(entry: BrowserPageDiagnosticEntry): boolean {
  const status = readBrowserDiagnosticStatus(entry)
  return entry.level === 'error' || entry.level === 'warning' || (isNotNull(status) && status >= 400)
}

/** 从诊断缓冲里挑出 console 事件并按 level / errorsOnly 过滤，回一份带汇总的回执。 */
export function buildBrowserConsoleEventsResult(
  diagnostics: BrowserPageDiagnostics,
  input: BrowserGetPageDiagnosticsInput
): BrowserConsoleEventsResult {
  const filters = normalizeBrowserConsoleEventFilters(input)
  const consoleEntries = diagnostics.entries.filter((entry) => entry.kind === 'console')
  const entries = consoleEntries.filter((entry) => matchesBrowserConsoleEventFilters(entry, filters))

  return {
    url: diagnostics.url,
    title: diagnostics.title,
    entries,
    summary: summarizeBrowserDiagnosticEntries(entries),
    filters,
    diagnosticTotal: diagnostics.entries.length,
    consoleTotal: consoleEntries.length,
    capturedAt: diagnostics.capturedAt,
  }
}

/** 把 console 过滤入参归一化成确定的形状。 */
export function normalizeBrowserConsoleEventFilters(
  input: BrowserGetPageDiagnosticsInput
): BrowserConsoleEventFilters {
  return {
    level: toNullable(input.level),
    errorsOnly: !!input.errorsOnly,
  }
}

/** 判一条 console 事件过不过 console 过滤条件。 */
export function matchesBrowserConsoleEventFilters(
  entry: BrowserPageDiagnosticEntry,
  filters: BrowserConsoleEventFilters
): boolean {
  if (filters.level && entry.level !== filters.level) return false
  if (filters.errorsOnly && entry.level !== 'error') return false

  return true
}

/** 把一批诊断按级别、种类、来源、状态码、资源类型各汇总一份。 */
export function summarizeBrowserDiagnosticEntries(
  entries: BrowserPageDiagnosticEntry[]
): BrowserPageDiagnosticsSummary {
  const byLevel: Record<string, number> = {}
  const byKind: Record<string, number> = {}
  const byOrigin: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  const byResourceType: Record<string, number> = {}

  for (const entry of entries) {
    incrementCount(byLevel, entry.level)
    incrementCount(byKind, entry.kind)

    const origin = resolveBrowserDiagnosticOrigin(entry.url)
    if (origin) incrementCount(byOrigin, origin)

    const status = readBrowserDiagnosticStatus(entry)
    if (isNotNull(status)) incrementCount(byStatus, String(status))

    const resourceType = readBrowserDiagnosticResourceType(entry)
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

/** 从一条诊断里读出 HTTP 状态码；没有就是 null。 */
export function readBrowserDiagnosticStatus(entry: BrowserPageDiagnosticEntry): Nullable<number> {
  const detailStatus = isPlainObject(entry.details) ? entry.details.status : null
  const status = isFiniteNumber(detailStatus) ? detailStatus : entry.code
  if (!isFiniteNumber(status) || status <= 0) return null

  return Math.round(status)
}

/** 从一条诊断里读出资源类型（Document、XHR、Image…）。 */
export function readBrowserDiagnosticResourceType(
  entry: BrowserPageDiagnosticEntry
): Nullable<string> {
  if (!isPlainObject(entry.details)) return null

  const resourceType = entry.details.resourceType
  if (!isString(resourceType)) return null

  return resourceType.trim() || null
}

/** 从一条诊断的 URL 里取出来源；地址不合法时返回 null。 */
function resolveBrowserDiagnosticOrigin(url: Nullable<string>): Nullable<string> {
  if (!url) return null
  if (!URL.canParse(url)) return null

  return new URL(url).origin
}

/** 计数表上某个键加一。 */
function incrementCount(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1
}

/** 把计数表按键排序，回执里顺序稳定。 */
function sortCountRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  )
}
