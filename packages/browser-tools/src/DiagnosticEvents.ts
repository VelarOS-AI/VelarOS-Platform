import type { BrowserPageDiagnosticEntry, BrowserPageDiagnosticsSummary } from '@velaros-ai/browser-core'
import { isFiniteNumber, isNotNull, isPlainObject, isString } from '@velaros-ai/core'

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

export function readBrowserDiagnosticStatus(entry: BrowserPageDiagnosticEntry): Nullable<number> {
  const detailStatus = isPlainObject(entry.details) ? entry.details.status : null
  const status = isFiniteNumber(detailStatus) ? detailStatus : entry.code
  if (!isFiniteNumber(status) || status <= 0) return null

  return Math.round(status)
}

export function readBrowserDiagnosticResourceType(
  entry: BrowserPageDiagnosticEntry
): Nullable<string> {
  if (!isPlainObject(entry.details)) return null

  const resourceType = entry.details.resourceType
  if (!isString(resourceType)) return null

  return resourceType.trim() || null
}

function resolveBrowserDiagnosticOrigin(url: Nullable<string>): Nullable<string> {
  if (!url) return null
  if (!URL.canParse(url)) return null

  return new URL(url).origin
}

function incrementCount(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1
}

function sortCountRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  )
}
