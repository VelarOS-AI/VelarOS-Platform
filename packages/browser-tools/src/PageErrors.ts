import type { BrowserPageDiagnosticEntry, BrowserPageDiagnostics, BrowserPageDiagnosticsSummary } from '@velaros-ai/browser-core'

import { summarizeBrowserDiagnosticEntries } from './DiagnosticEvents'
import type { BrowserListPageErrorsInput } from './Inspection'

export interface BrowserPageErrorsResult {
  url: string
  title: Nullable<string>
  entries: BrowserPageDiagnosticEntry[]
  summary: BrowserPageDiagnosticsSummary
  diagnosticTotal: number
  pageErrorTotal: number
  capturedAt: number
}

export function buildBrowserPageErrorsResult(
  diagnostics: BrowserPageDiagnostics,
  _input: BrowserListPageErrorsInput
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
