import { toNullable } from '@velaros-ai/core'

import type { BrowserPageDiagnosticEntry, BrowserPageDiagnosticLevel, BrowserPageDiagnostics, BrowserPageDiagnosticsSummary } from '../core'

import { summarizeBrowserDiagnosticEntries } from './DiagnosticEvents'
import type { BrowserListConsoleEventsInput } from './Inspection'

interface BrowserConsoleEventFilters {
  level: Nullable<BrowserPageDiagnosticLevel>
  errorsOnly: boolean
}

export interface BrowserConsoleEventsResult {
  url: string
  title: Nullable<string>
  entries: BrowserPageDiagnosticEntry[]
  summary: BrowserPageDiagnosticsSummary
  filters: BrowserConsoleEventFilters
  diagnosticTotal: number
  consoleTotal: number
  capturedAt: number
}

export function buildBrowserConsoleEventsResult(
  diagnostics: BrowserPageDiagnostics,
  input: BrowserListConsoleEventsInput
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

function normalizeBrowserConsoleEventFilters(
  input: BrowserListConsoleEventsInput
): BrowserConsoleEventFilters {
  return {
    level: toNullable(input.level),
    errorsOnly: !!input.errorsOnly,
  }
}

function matchesBrowserConsoleEventFilters(
  entry: BrowserPageDiagnosticEntry,
  filters: BrowserConsoleEventFilters
): boolean {
  if (filters.level && entry.level !== filters.level) return false
  if (filters.errorsOnly && entry.level !== 'error') return false

  return true
}
