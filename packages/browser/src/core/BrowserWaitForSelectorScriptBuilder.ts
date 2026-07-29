import { buildBrowserInlineInferenceToolkitSnippet } from './browserInlineInferenceToolkit'
import type { BrowserWaitForSelectorOptions } from './types'

/** 构造等待 selector 出现/可见的页面脚本。 */
class BrowserWaitForSelectorScriptBuilder {
  /** 监听 DOM 变化等待 selector，命中后返回目标描述，超时也返回最终状态。 */
  public buildWaitForSelectorScript(options: BrowserWaitForSelectorOptions): string {
    const payload = JSON.stringify({
      selector: options.selector,
      state: this.resolveWaitState(options),
      timeoutMs: this.clampInteger(options.timeoutMs, 1, 60_000, 5_000),
    })

    return `(() => {
      const payload = ${payload}
      const startedAt = Date.now()
      ${buildBrowserInlineInferenceToolkitSnippet(false)}
      const buildTarget = (node, frame = null) => {
        if (!(node instanceof Element)) return null
        const text = normalize(node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('value'))
        const attributes = {}
        for (const attr of ['id', 'name', 'type', 'href', 'aria-label', 'data-testid', 'data-test', 'data-qa']) {
          const value = node.getAttribute(attr)
          if (value) attributes[attr] = value
        }
        return {
          css: buildCssPath(node),
          role: inferRole(node),
          text: text || null,
          name: node.getAttribute('name') || null,
          attributes,
          frame: frame || undefined,
        }
      }
      const isIframeElement = (node) =>
        node instanceof Element && node.tagName.toLowerCase() === 'iframe'
      const buildFrameTarget = (iframe) => {
        if (!isIframeElement(iframe)) return null
        let url = null
        try {
          url = iframe.contentWindow?.location?.href || iframe.src || null
        } catch {
          url = iframe.src || null
        }
        return {
          css: buildCssPath(iframe),
          name: normalize(iframe.getAttribute('name')) || null,
          title: normalize(iframe.getAttribute('title') || iframe.getAttribute('aria-label')) || null,
          url,
        }
      }
      const readFrameDocument = (iframe) => {
        if (!isIframeElement(iframe)) return null
        try {
          const frameDocument = iframe.contentDocument
          return frameDocument?.documentElement ? frameDocument : null
        } catch {
          return null
        }
      }
      const splitSelectorHops = (selector) =>
        String(selector || '').split(/\\s*>>\\s*/).map((part) => part.trim()).filter(Boolean)
      const resolveSelectorContext = () => {
        const parts = splitSelectorHops(payload.selector)
        if (parts.length <= 1) {
          return {
            root: document,
            selector: payload.selector,
            frame: null,
          }
        }
        let root = document
        let frame = null
        for (const frameSelector of parts.slice(0, -1)) {
          let candidates = []
          try {
            candidates = Array.from(root.querySelectorAll(frameSelector))
          } catch {
            return { root: null, selector: parts[parts.length - 1], frame }
          }
          const iframe = candidates.find((candidate) => isIframeElement(candidate))
          const frameDocument = readFrameDocument(iframe)
          if (!frameDocument) return { root: null, selector: parts[parts.length - 1], frame }
          frame = buildFrameTarget(iframe)
          root = frameDocument
        }
        return {
          root,
          selector: parts[parts.length - 1],
          frame,
        }
      }
      const checkState = (nodes, visible) => {
        if (payload.state === 'visible') return visible
        if (payload.state === 'hidden') return nodes.length === 0 || !visible
        if (payload.state === 'detached') return nodes.length === 0

        return nodes.length > 0
      }
      const inspect = () => {
        const context = resolveSelectorContext()
        let nodes = []
        if (context.root) {
          try {
            nodes = Array.from(context.root.querySelectorAll(context.selector))
          } catch {
            nodes = []
          }
        }
        const firstAttached = nodes[0] || null
        const firstVisible = nodes.find((node) => isVisible(node)) || null
        const first =
          payload.state === 'visible' ? firstVisible :
          payload.state === 'hidden' ? firstAttached :
          payload.state === 'attached' ? firstAttached :
          null
        const visible = !!firstVisible
        const matched = checkState(nodes, visible)
        return {
          matched,
          visible,
          count: nodes.length,
          target: first ? buildTarget(first, context.frame) : null,
        }
      }
      const finish = (state) => ({
        url: location.href,
        selector: payload.selector,
        state: payload.state,
        matched: state.matched,
        visible: state.visible,
        count: state.count,
        elapsedMs: Date.now() - startedAt,
        target: state.target,
        capturedAt: Date.now(),
      })
      const initial = inspect()
      if (initial.matched) return finish(initial)

      return new Promise((resolve) => {
        let settled = false
        let timeout = null
        let observer = null
        const finishOnce = (state) => {
          if (settled) return
          settled = true
          observer?.disconnect()
          if (timeout) clearTimeout(timeout)
          resolve(finish(state))
        }
        const check = () => {
          const state = inspect()
          if (state.matched) {
            finishOnce(state)
          }
        }
        observer = new MutationObserver(check)
        observer.observe(document.documentElement || document, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        })
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', check, { once: true })
        }
        timeout = setTimeout(
          () => finishOnce(inspect()),
          Math.max(0, startedAt + payload.timeoutMs - Date.now())
        )
        check()
      })
    })()`
  }

  private resolveWaitState(
    options: BrowserWaitForSelectorOptions
  ): NonNullable<BrowserWaitForSelectorOptions['state']> {
    if (options.state) return options.state
    if (options.visible) return 'visible'

    return 'attached'
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

export { BrowserWaitForSelectorScriptBuilder }
