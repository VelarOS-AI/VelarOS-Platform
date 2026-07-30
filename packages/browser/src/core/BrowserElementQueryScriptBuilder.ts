import { clampInteger } from './BrowserRuntimeInternals'
import type { BrowserElementQueryOptions } from './types'

/** 构造在页面内查询元素详情的脚本。 */
class BrowserElementQueryScriptBuilder {
  /** 根据 CSS selector 查询元素，并返回文本、属性、可见性和可复用 target。 */
  public buildElementQueryScript(options: BrowserElementQueryOptions): string {
    // 默认属性覆盖常见定位线索，调用方可传 attributes 覆盖。
    const defaultAttributes = [
      'id',
      'class',
      'name',
      'type',
      'href',
      'role',
      'aria-label',
      'data-testid',
      'data-test',
      'data-qa',
      'placeholder',
    ]
    const payload = JSON.stringify({
      selector: options.selector,
      attributes: (options.attributes?.length ? options.attributes : defaultAttributes).slice(
        0,
        20
      ),
      includeHtml: !!options.includeHtml,
      limit: clampInteger(options.limit, 1, 100, 50),
      maxTextChars: clampInteger(options.maxTextChars, 1, 20000, 2000),
      maxHtmlChars: clampInteger(options.maxHtmlChars, 1, 50000, 5000),
    })

    // 返回脚本字符串，由 Electron webContents.executeJavaScript 在页面上下文执行。
    return `(() => {
      const payload = ${payload}
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
      const escapeCss = (value) => {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value))
        return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&')
      }
      const truncate = (value, max) => {
        const text = String(value || '')
        return {
          value: text.length > max ? text.slice(0, max) : text,
          truncated: text.length > max,
        }
      }
      const quoteAttr = (value) => String(value).replace(/"/g, '\\\\"')
      const buildCssPath = (node) => {
        if (!(node instanceof Element)) return null
        const id = node.getAttribute('id')
        if (id) return '#' + escapeCss(id)
        for (const attr of ['data-testid', 'data-test', 'data-qa']) {
          const value = node.getAttribute(attr)
          if (value) return node.tagName.toLowerCase() + '[' + attr + '="' + quoteAttr(value) + '"]'
        }
        const name = node.getAttribute('name')
        if (name) return node.tagName.toLowerCase() + '[name="' + quoteAttr(name) + '"]'
        const ariaLabel = node.getAttribute('aria-label')
        if (ariaLabel) return node.tagName.toLowerCase() + '[aria-label="' + quoteAttr(ariaLabel) + '"]'

        const parts = []
        let current = node
        while (current && current instanceof Element && parts.length < 4) {
          const parent = current.parentElement
          const tagName = current.tagName.toLowerCase()
          if (!parent) {
            parts.unshift(tagName)
            break
          }
          const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName)
          const index = siblings.indexOf(current) + 1
          parts.unshift(siblings.length > 1 ? tagName + ':nth-of-type(' + index + ')' : tagName)
          current = parent
        }
        return parts.join(' > ') || null
      }
      const inferRole = (node) => {
        const explicitRole = normalize(node.getAttribute('role'))
        if (explicitRole) return explicitRole
        const tagName = node.tagName.toLowerCase()
        if (tagName === 'a') return 'link'
        if (tagName === 'button') return 'button'
        if (tagName === 'select') return 'combobox'
        if (tagName === 'textarea') return 'textbox'
        if (tagName === 'input') {
          const type = normalize(node.getAttribute('type')).toLowerCase()
          if (type === 'submit') return 'submit'
          if (type === 'button') return 'button'
          if (type === 'checkbox') return 'checkbox'
          if (type === 'radio') return 'radio'
          return 'textbox'
        }
        return null
      }
      const buildTarget = (node, text, frame = null) => {
        if (!(node instanceof Element)) return null
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
          frame: frame || undefined,
          attributes,
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
            selectorError: null,
          }
        }
        if (parts.length > 2) {
          return {
            root: null,
            selector: parts[parts.length - 1],
            frame: null,
            selectorError: 'Only one iframe selector hop is supported',
          }
        }
        let root = document
        let frame = null
        for (const frameSelector of parts.slice(0, -1)) {
          let candidates = []
          try {
            candidates = Array.from(root.querySelectorAll(frameSelector))
          } catch (error) {
            return {
              root: null,
              selector: parts[parts.length - 1],
              frame,
              selectorError: error instanceof Error ? error.message : String(error),
            }
          }
          const iframe = candidates.find((candidate) => isIframeElement(candidate))
          const frameDocument = readFrameDocument(iframe)
          if (!frameDocument) {
            return {
              root: null,
              selector: parts[parts.length - 1],
              frame,
              selectorError: null,
            }
          }
          frame = buildFrameTarget(iframe)
          root = frameDocument
        }
        return {
          root,
          selector: parts[parts.length - 1],
          frame,
          selectorError: null,
        }
      }
      const isVisible = (node) => {
        if (!(node instanceof Element)) return false
        const style = window.getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0'
          && rect.width > 0
          && rect.height > 0
      }

      let nodes = []
      const selectorContext = resolveSelectorContext()
      if (selectorContext.selectorError) {
        return {
          url: location.href,
          selector: payload.selector,
          selectorError: selectorContext.selectorError,
          count: 0,
          limit: payload.limit,
          elements: [],
          capturedAt: Date.now(),
        }
      }
      try {
        nodes = selectorContext.root
          ? Array.from(selectorContext.root.querySelectorAll(selectorContext.selector))
          : []
      } catch (error) {
        return {
          url: location.href,
          selector: payload.selector,
          selectorError: error instanceof Error ? error.message : String(error),
          count: 0,
          limit: payload.limit,
          elements: [],
          capturedAt: Date.now(),
        }
      }

      const elements = nodes.slice(0, payload.limit).map((node, index) => {
        const textResult = truncate(normalize(node.textContent), payload.maxTextChars)
        const htmlResult = truncate(node.outerHTML || '', payload.maxHtmlChars)
        const attributes = {}
        for (const attr of payload.attributes) {
          const value = node.getAttribute(attr)
          if (value != null) attributes[attr] = value
        }

        return {
          index,
          tagName: node.tagName.toLowerCase(),
          text: textResult.value,
          textTruncated: textResult.truncated,
          ...(payload.includeHtml ? { html: htmlResult.value, htmlTruncated: htmlResult.truncated } : {}),
          attributes,
          href: node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement ? node.href : null,
          value: node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement ? String(node.value ?? '') : null,
          checked: node instanceof HTMLInputElement && ['checkbox', 'radio'].includes(node.type.toLowerCase()) ? node.checked : null,
          visible: isVisible(node),
          target: buildTarget(node, textResult.value, selectorContext.frame),
        }
      })

      return {
        url: location.href,
        selector: payload.selector,
        selectorError: null,
        count: nodes.length,
        limit: payload.limit,
        elements,
        capturedAt: Date.now(),
      }
    })()`
  }

}

export { BrowserElementQueryScriptBuilder }
