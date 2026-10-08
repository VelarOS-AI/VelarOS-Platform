// 客户端终止不等于上游结算；下一组派发前核对网关中属于本尝试的活动请求。
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

export async function awaitGatewaySettlement(
  baseURL,
  credential,
  { timeoutMs = 905000, pollMs = 1000 } = {}
) {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0)
  assert(Number.isSafeInteger(pollMs) && pollMs > 0)
  const started = Date.now()
  for (;;) {
    const remaining = timeoutMs - (Date.now() - started)
    assert(remaining > 0, 'Gateway settlement timed out; no next attempt may be dispatched')
    const response = await fetch(new URL('/health', baseURL), {
      headers: { authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(Math.min(remaining, 5000)),
    })
    assert(response.ok, `Gateway settlement health failed: ${response.status}`)
    const state = await response.json()
    assert(Number.isSafeInteger(state.activeUpstreamRequests) && state.activeUpstreamRequests >= 0)
    assert(
      Number.isSafeInteger(state.activeModelDiscoveryRequests) &&
        state.activeModelDiscoveryRequests >= 0
    )
    if (state.activeUpstreamRequests === 0 && state.activeModelDiscoveryRequests === 0)
      return { waitedMs: Date.now() - started, state }
    await delay(Math.min(pollMs, remaining))
  }
}
