import { isNumber } from '@velaros-ai/core'

import type { BrowserPageScrollOptions } from './types'

/** 构造页面滚动脚本。 */
class BrowserPageScrollScriptBuilder {
  /** 支持方向滚动和显式 x/y 滚动，并返回滚动状态。 */
  public buildScrollScript(options: BrowserPageScrollOptions): string {
    const payload = JSON.stringify({
      direction: options.direction ?? 'down',
      amount: this.clampInteger(options.amount, 1, 5000, 600),
      x: this.clampInteger(options.x, -10000, 10000, 0),
      y: this.clampInteger(options.y, -10000, 10000, 0),
      hasExplicitX:isNumber(options.x),
      hasExplicitY:isNumber(options.y),
    })

    return `(() => {
      const payload = ${payload}
      const page = document.scrollingElement || document.documentElement || document.body
      const getState = () => {
        const maxScrollX = Math.max(0, (page?.scrollWidth || 0) - window.innerWidth)
        const maxScrollY = Math.max(0, (page?.scrollHeight || 0) - window.innerHeight)
        return {
          url: location.href,
          scrollX: Math.round(window.scrollX || page?.scrollLeft || 0),
          scrollY: Math.round(window.scrollY || page?.scrollTop || 0),
          maxScrollX: Math.round(maxScrollX),
          maxScrollY: Math.round(maxScrollY),
          viewportWidth: Math.round(window.innerWidth),
          viewportHeight: Math.round(window.innerHeight),
          capturedAt: Date.now(),
        }
      }

      if (!page) return getState()

      const amount = Number(payload.amount) || 600
      let left = payload.hasExplicitX ? Number(payload.x) || 0 : 0
      let top = payload.hasExplicitY ? Number(payload.y) || 0 : 0

      if (!payload.hasExplicitX && !payload.hasExplicitY) {
        if (payload.direction === 'up') top = -amount
        else if (payload.direction === 'left') left = -amount
        else if (payload.direction === 'right') left = amount
        else if (payload.direction === 'top') window.scrollTo({ top: 0, left: window.scrollX, behavior: 'auto' })
        else if (payload.direction === 'bottom') window.scrollTo({ top: page.scrollHeight, left: window.scrollX, behavior: 'auto' })
        else top = amount
      }

      if (left || top) {
        window.scrollBy({ left, top, behavior: 'auto' })
      }

      return getState()
    })()`
  }

  private clampInteger(
    value: number | undefined,
    min: number,
    max: number,
    fallback: number
  ): number {
    if (!Number.isFinite(value)) return fallback

    return Math.min(Math.max(Math.round(value as number), min), max)
  }
}

export { BrowserPageScrollScriptBuilder }
