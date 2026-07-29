import type { BrowserElementTargetHint } from './types'

/** 构造短暂高亮目标元素的页面脚本（agent 操作反馈）。 */
class BrowserTargetHighlightScriptBuilder {
  public buildHighlightScript(input: {
    selector?: Nullable<string>
    label?: Nullable<string>
    durationMs?: number
  }): string {
    const payload = JSON.stringify({
      selector: input.selector ?? null,
      label: input.label ?? 'Agent target',
      durationMs: input.durationMs ?? 1600,
    })

    return `(() => {
      const payload = ${payload}
      const selector = payload.selector
      if (!selector) return { highlighted: false, reason: 'missing-selector' }

      const existing = document.querySelector('[data-velaros-agent-highlight]')
      existing?.remove()

      let element = null
      try {
        element = document.querySelector(selector)
      } catch {
        return { highlighted: false, reason: 'invalid-selector' }
      }
      if (!element) return { highlighted: false, reason: 'not-found' }

      const rect = element.getBoundingClientRect()
      const overlay = document.createElement('div')
      overlay.setAttribute('data-velaros-agent-highlight', 'true')
      Object.assign(overlay.style, {
        position: 'fixed',
        zIndex: '2147483646',
        left: rect.left + 'px',
        top: rect.top + 'px',
        width: Math.max(rect.width, 1) + 'px',
        height: Math.max(rect.height, 1) + 'px',
        pointerEvents: 'none',
        boxSizing: 'border-box',
        border: '2px solid #f59e0b',
        borderRadius: '4px',
        background: 'rgba(245, 158, 11, 0.12)',
        boxShadow: '0 0 0 1px rgba(255,255,255,0.92), 0 10px 28px rgba(245,158,11,0.22)',
        transition: 'opacity 180ms ease'
      })

      const badge = document.createElement('div')
      Object.assign(badge.style, {
        position: 'absolute',
        left: '0',
        top: '-26px',
        maxWidth: '320px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        padding: '4px 7px',
        borderRadius: '6px',
        background: '#f59e0b',
        color: '#111827',
        font: '12px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      })
      badge.textContent = String(payload.label || 'Agent target')
      overlay.appendChild(badge)
      document.documentElement.appendChild(overlay)

      window.setTimeout(() => {
        overlay.style.opacity = '0'
        window.setTimeout(() => overlay.remove(), 220)
      }, Math.max(400, Number(payload.durationMs) || 1600))

      return {
        highlighted: true,
        selector,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      }
    })()`
  }

  public buildHighlightFromTargetScript(target: BrowserElementTargetHint, label?: string): string {
    const selectors: string[] = []
    if (target.css) selectors.push(target.css)
    if (target.attributes?.id) selectors.push(`#${target.attributes.id}`)
    if (target.attributes?.['data-testid']) {
      selectors.push(`[data-testid="${target.attributes['data-testid']}"]`)
    }

    return this.buildHighlightScript({
      selector: selectors[0] ?? null,
      label: label ?? target.text ?? target.name ?? 'Agent target',
    })
  }
}

export { BrowserTargetHighlightScriptBuilder }
