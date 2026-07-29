import type { BrowserPendingEventKind, BrowserPendingEventsResult, BrowserPendingEventSummary } from '@velaros-ai/browser-core'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

const DefaultPendingEventWaitTimeoutMs = 5000
const PendingEventPollIntervalMs = 50

interface BrowserPendingEventWaitOptions {
  kind?: BrowserPendingEventKind
  timeoutMs?: number
  abortSignal: AbortSignal
  listPendingEvents: () => Promise<BrowserPendingEventsResult>
}

interface BrowserPendingEventWaitResult {
  matched: boolean
  timedOut: boolean
  kind: BrowserPendingEventKind
  event: Nullable<BrowserPendingEventSummary>
  pending: BrowserPendingEventSummary[]
  timeoutMs: number
  elapsedMs: number
  capturedAt: number
}

async function waitForPendingEvent(
  options: BrowserPendingEventWaitOptions
): Promise<BrowserPendingEventWaitResult> {
  const kind = options.kind ?? 'download'
  const timeoutMs = options.timeoutMs ?? DefaultPendingEventWaitTimeoutMs
  const startedAt = Date.now()
  let latestPending: BrowserPendingEventSummary[] = []

  while (Date.now() - startedAt <= timeoutMs) {
    options.abortSignal.throwIfAborted()
    const snapshot = await options.listPendingEvents()
    latestPending = snapshot.pending
    const event = latestPending.find((pendingEvent) => pendingEvent.kind === kind)
    if (event) return {
        matched: true,
        timedOut: false,
        kind,
        event,
        pending: latestPending,
        timeoutMs,
        elapsedMs: Date.now() - startedAt,
        capturedAt: Date.now(),
      }

    await TimerScope.sleep(PendingEventPollIntervalMs, {
      label: 'browser.waitForPendingEvent',
      signal: options.abortSignal,
    })
  }

  return {
    matched: false,
    timedOut: true,
    kind,
    event: null,
    pending: latestPending,
    timeoutMs,
    elapsedMs: Date.now() - startedAt,
    capturedAt: Date.now(),
  }
}

export { waitForPendingEvent }
export type { BrowserPendingEventWaitOptions, BrowserPendingEventWaitResult }
