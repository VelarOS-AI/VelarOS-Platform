import { isNotNull, toNullable } from '@velaros-ai/core'

import type { BrowserPageDiagnosticEntry, BrowserPageDiagnostics, BrowserPageDiagnosticsSummary } from '../../exports/core'
import type { BrowserListNetworkEventsInput } from '../../impl/tools/Inspection'

import {
  readBrowserDiagnosticResourceType,
  readBrowserDiagnosticStatus,
  summarizeBrowserDiagnosticEntries,
} from './diagnostic-events'

interface BrowserNetworkEventFilters {
  status: Nullable<number>
  resourceType: Nullable<string>
  failedOnly: boolean
}

export interface BrowserNetworkEventsResult {
  url: string
  title: Nullable<string>
  entries: BrowserPageDiagnosticEntry[]
  summary: BrowserPageDiagnosticsSummary
  filters: BrowserNetworkEventFilters
  diagnosticTotal: number
  networkTotal: number
  /** 网络采集刚在这次调用建立时的说明（内嵌页面）；没有要说的就是 null。 */
  networkCaptureNotice: Nullable<string>
  capturedAt: number
}

export function buildBrowserNetworkEventsResult(
  diagnostics: BrowserPageDiagnostics,
  input: BrowserListNetworkEventsInput
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

function normalizeBrowserNetworkEventFilters(
  input: BrowserListNetworkEventsInput
): BrowserNetworkEventFilters {
  return {
    status: toNullable(input.status),
    resourceType: input.resourceType?.trim() || null,
    failedOnly: !!input.failedOnly,
  }
}

function matchesBrowserNetworkEventFilters(
  entry: BrowserPageDiagnosticEntry,
  filters: BrowserNetworkEventFilters
): boolean {
  if (filters.status && readBrowserDiagnosticStatus(entry) !== filters.status) return false
  if (filters.resourceType && readBrowserDiagnosticResourceType(entry) !== filters.resourceType) return false
  if (filters.failedOnly && !isFailedBrowserNetworkEvent(entry)) return false

  return true
}

function isFailedBrowserNetworkEvent(entry: BrowserPageDiagnosticEntry): boolean {
  const status = readBrowserDiagnosticStatus(entry)
  return entry.level === 'error' || entry.level === 'warning' || (isNotNull(status) && status >= 400)
}
