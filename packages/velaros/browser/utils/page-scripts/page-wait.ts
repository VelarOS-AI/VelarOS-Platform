import { toNullable } from '@velaros-ai/core'

import type { BrowserPageWaitOptions } from '../../types/browser'
import { clampInteger } from '../numbers.js'

/**
 * 构造等页面加载状态的脚本：domcontentloaded 等到 readyState 不是 loading，load 等到 complete；networkidle 在页面里不等
 * （网络空闲由宿主另外等）。到点没等到如实回 matched 为假、timedOut 为真。
 */
export function buildPageWaitScript(options: BrowserPageWaitOptions): string {
  const payload = JSON.stringify({
    loadState: toNullable(options.loadState),
    timeoutMs: clampInteger(options.timeoutMs, 1, 60_000, 5_000),
  })

  return `(() => {
    const payload = ${payload}
    const startedAt = Date.now()
    const matchesLoadState = () => {
      if (payload.loadState === 'domcontentloaded') return document.readyState !== 'loading'
      if (payload.loadState === 'load') return document.readyState === 'complete'
      return true
    }
    return new Promise((resolve) => {
      let timeout = null
      const finish = () => {
        document.removeEventListener('DOMContentLoaded', check)
        window.removeEventListener('load', check)
        if (timeout) clearTimeout(timeout)
        const matched = matchesLoadState()
        resolve({
          url: location.href,
          loadState: document.readyState,
          requestedLoadState: payload.loadState,
          matched,
          timeoutMs: payload.timeoutMs,
          elapsedMs: Date.now() - startedAt,
          timedOut: !matched,
          capturedAt: Date.now(),
        })
      }
      const check = () => {
        if (matchesLoadState()) finish()
      }
      if (matchesLoadState()) {
        finish()
        return
      }
      document.addEventListener('DOMContentLoaded', check)
      window.addEventListener('load', check)
      timeout = setTimeout(finish, payload.timeoutMs)
    })
  })()`
}
