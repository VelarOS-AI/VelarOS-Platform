import type { BrowserElementTargetHint } from './types'

/** 构造定位 file input 元素的页面脚本。 */
class BrowserFileUploadScriptBuilder {
  public buildResolveFileInputScript(target: BrowserElementTargetHint): string {
    const payload = JSON.stringify({ target })

    return `(() => {
      const payload = ${payload}
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
      const escapeCss = (value) => {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value))
        return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&')
      }
      const quoteAttr = (value) => String(value).replace(/"/g, '\\\\"')
      const tryQuery = (selector) => {
        if (!selector) return null
        try {
          return document.querySelector(selector)
        } catch {
          return null
        }
      }
      const target = payload.target || {}
      const attributes = target.attributes || {}
      const selectors = []
      if (target.css) selectors.push(target.css)
      if (attributes.id) selectors.push('#' + escapeCss(attributes.id))
      if (attributes.name || target.name) {
        selectors.push('input[type="file"][name="' + quoteAttr(attributes.name || target.name) + '"]')
      }
      if (attributes['data-testid']) {
        selectors.push('[data-testid="' + quoteAttr(attributes['data-testid']) + '"]')
      }

      let element = null
      let matchedSelector = null
      for (const selector of selectors) {
        element = tryQuery(selector)
        if (element) {
          matchedSelector = selector
          break
        }
      }

      if (!element) {
        const candidates = Array.from(document.querySelectorAll('input[type="file"]'))
        element = candidates.find((node) => {
          const name = normalize(node.getAttribute('name'))
          const targetName = normalize(target.name || attributes.name)
          if (targetName && name === targetName) return true
          const text = normalize(node.getAttribute('aria-label') || node.getAttribute('title'))
          const targetText = normalize(target.text)
          return !!targetText && text.includes(targetText)
        }) || null
        if (element) matchedSelector = 'input[type="file"]'
      }

      if (!element) {
        return { matched: false, selector: null, tagName: null }
      }

      const tagName = element.tagName.toLowerCase()
      if (tagName !== 'input' || normalize(element.getAttribute('type')).toLowerCase() !== 'file') {
        return { matched: false, selector: matchedSelector, tagName, reason: 'not-file-input' }
      }

      return {
        matched: true,
        selector: matchedSelector,
        tagName,
      }
    })()`
  }
}

export { BrowserFileUploadScriptBuilder }
