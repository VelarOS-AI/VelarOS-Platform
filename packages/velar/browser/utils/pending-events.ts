/** 等挂起事件：按间隔轮询宿主的挂起事件表，等到指定类别出现或者超时。 */

import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { BrowserPendingEventSummary, BrowserPendingEventWaitResult } from '../types/browser.js'
import type { BrowserPendingEventWaitOptions } from '../types/operations.js'

import { BrowserTuning } from './tuning'

/** 轮询等某一类挂起事件出现；到期没等到就如实回报超时。 */
export async function waitForPendingEvent(
  options: BrowserPendingEventWaitOptions
): Promise<BrowserPendingEventWaitResult> {
  const kind = options.kind ?? 'download'
  const timeoutMs = options.timeoutMs ?? BrowserTuning.session.pendingEventWaitTimeoutMs
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
      }

    await TimerScope.sleep(BrowserTuning.session.pendingEventPollIntervalMs, {
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
  }
}

