/** 构造表格/列表结构化提取脚本。 */
class BrowserExtractionScriptBuilder {
  private buildScopedSelectorResolverScript(): string {
    return `
      const resolveScopedSelector = (selector, fallbackSelector, root) => {
        const raw = String(selector || '').trim()
        const effectiveSelector = raw || fallbackSelector || ''
        if (!effectiveSelector) return []
        const contextRoot = root || document

        const xpath =
          raw.startsWith('xpath=') ? raw.slice('xpath='.length).trim() :
          raw.startsWith('/') || raw.startsWith('(') ? raw :
          ''
        if (xpath) {
          const scopedXpath = contextRoot !== document && xpath.startsWith('//') ? '.' + xpath : xpath
          const result = document.evaluate(scopedXpath, contextRoot, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
          const nodes = []
          for (let index = 0; index < result.snapshotLength; index++) {
            const node = result.snapshotItem(index)
            if (node instanceof Element) nodes.push(node)
          }
          return nodes
        }

        return Array.from(contextRoot.querySelectorAll(effectiveSelector))
      }
    `
  }

  /** 从页面表格中提取 headers 和 rows。 */
  public buildTableExtractionScript(args: {
    selector?: string
    maxRows: number
    tableIndex: number
  }): string {
    const payload = JSON.stringify(args)
    return `(() => {
      const payload = ${payload}
      const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim()
      ${this.buildScopedSelectorResolverScript()}
      const tables = resolveScopedSelector(payload.selector, 'table')
      const target = tables[payload.tableIndex] || tables[0]
      if (!target) return { ok: false, error: 'no table found', tables: tables.length, selector: payload.selector || null, headers: [], rows: [], capturedAt: Date.now() }
      const allRows = Array.from(target.querySelectorAll('tr'))
      const headers = []
      let dataRowStart = 0
      const firstRow = allRows[0]
      if (firstRow) {
        const cells = Array.from(firstRow.querySelectorAll('th, td'))
        if (cells.some((c) => c.tagName === 'TH')) {
          headers.push(...cells.map((c) => normalize(c.textContent)))
          dataRowStart = 1
        }
      }
      const rows = allRows.slice(dataRowStart, dataRowStart + payload.maxRows).map((tr) =>
        Array.from(tr.querySelectorAll('td, th')).map((c) => normalize(c.textContent))
      ).filter((r) => r.some(Boolean))
      return { ok: true, error: null, tables: tables.length, tableIndex: payload.tableIndex, selector: payload.selector || null, headers, rows, rowCount: rows.length, capturedAt: Date.now(), url: location.href }
    })()`
  }

  /** 从列表、卡片、文章等节点中提取标题、链接和描述。 */
  public buildListExtractionScript(args: { selector?: string; maxItems: number }): string {
    const payload = JSON.stringify(args)
    return `(() => {
      const payload = ${payload}
      const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim()
      let items = []
      const selector = payload.selector || 'ul > li, ol > li, [role="list"] > [role="listitem"], article, .item, .card, .result, .entry'
      ${this.buildScopedSelectorResolverScript()}
      const nodes = resolveScopedSelector(payload.selector, selector).slice(0, payload.maxItems)
      items = nodes.map((node) => {
        const link = node.querySelector('a[href]')
        const heading = node.querySelector('h1,h2,h3,h4,h5,h6')
        const desc = node.querySelector('p, [class*="desc"], [class*="summary"], [class*="excerpt"]')
        const title = normalize(heading?.textContent || link?.textContent || node.getAttribute('aria-label') || '')
        const href = link ? link.href : null
        const description = normalize(desc?.textContent || '')
        const text = normalize(node.textContent || '')
        return { title: title || text.slice(0, 120), href, description: description || null }
      }).filter((item) => item.title)
      return { ok: true, selector, items, itemCount: items.length, capturedAt: Date.now(), url: location.href }
    })()`
  }

  /** 提取可见正文为 plain / markdown / html。 */
  public buildPageContentExtractionScript(args: {
    format: 'plain' | 'markdown' | 'html'
    selector?: string
    ignoreSelectors?: string[]
    maxChars: number
  }): string {
    const payload = JSON.stringify(args)
    return `(() => {
      const payload = ${payload}
      const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim()
      ${this.buildScopedSelectorResolverScript()}
      const pickRoot = () => {
        if (payload.selector) {
          const el = resolveScopedSelector(payload.selector)[0]
          return el || document.body
        }
        return document.querySelector('main, article, [role="main"], #content, .content, .article') || document.body
      }
      const root = pickRoot()
      if (!root) return { ok: false, format: payload.format, selector: payload.selector || null, content: '', truncated: false, url: location.href, capturedAt: Date.now() }
      const removeIgnoredSubtrees = (sourceRoot) => {
        if (!(sourceRoot instanceof Element)) return sourceRoot
        const ignoreSelectors = Array.isArray(payload.ignoreSelectors) ? payload.ignoreSelectors : []
        if (ignoreSelectors.length === 0) return sourceRoot
        const clone = sourceRoot.cloneNode(true)
        for (const selector of ignoreSelectors) {
          for (const node of resolveScopedSelector(selector, undefined, clone)) {
            node.remove()
          }
        }
        return clone
      }
      const extractRoot = removeIgnoredSubtrees(root)
      const truncate = (text) => {
        const raw = String(text || '')
        return { content: raw.length > payload.maxChars ? raw.slice(0, payload.maxChars) : raw, truncated: raw.length > payload.maxChars }
      }
      if (payload.format === 'html') {
        const html = extractRoot instanceof Element ? extractRoot.outerHTML : String(extractRoot)
        const result = truncate(html)
        return { ok: true, format: 'html', selector: payload.selector || null, ...result, url: location.href, capturedAt: Date.now() }
      }
      if (payload.format === 'plain') {
        const text = extractRoot instanceof Element ? (extractRoot.innerText || extractRoot.textContent || '') : String(extractRoot)
        const result = truncate(text)
        return { ok: true, format: 'plain', selector: payload.selector || null, ...result, url: location.href, capturedAt: Date.now() }
      }
      const lines = []
      const walk = (node) => {
        if (!node) return
        if (node.nodeType === Node.TEXT_NODE) {
          const text = normalize(node.textContent)
          if (text) lines.push(text)
          return
        }
        if (!(node instanceof Element)) return
        const tag = node.tagName.toLowerCase()
        if (tag === 'script' || tag === 'style' || tag === 'noscript') return
        const style = getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden') return
        if (/^h[1-6]$/.test(tag)) {
          const level = Number(tag.slice(1))
          const text = normalize(node.textContent)
          if (text) lines.push('#'.repeat(level) + ' ' + text, '')
          return
        }
        if (tag === 'a' && node instanceof HTMLAnchorElement && node.href) {
          const text = normalize(node.textContent) || node.href
          lines.push('[' + text + '](' + node.href + ')')
          return
        }
        if (tag === 'li') {
          lines.push('- ' + normalize(node.textContent))
          return
        }
        if (tag === 'p') {
          const text = normalize(node.textContent)
          if (text) lines.push(text, '')
          return
        }
        if (tag === 'br') {
          lines.push('')
          return
        }
        for (const child of Array.from(node.childNodes)) walk(child)
      }
      walk(extractRoot)
      const markdown = lines.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim()
      const result = truncate(markdown)
      return { ok: true, format: 'markdown', selector: payload.selector || null, ...result, url: location.href, capturedAt: Date.now() }
    })()`
  }

  /** 枚举页面链接、iframe 与媒体数量。 */
  public buildPageResourcesScript(args: { limit: number; includeIframes: boolean }): string {
    const payload = JSON.stringify(args)
    return `(() => {
      const payload = ${payload}
      const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim()
      const pageOrigin = location.origin || ''
      const originMap = new Map()
      const readOrigin = (raw) => {
        try {
          const value = String(raw || '').trim()
          if (!value) return null
          return new URL(value, location.href).origin
        } catch {
          return null
        }
      }
      const trackOrigin = (raw) => {
        const origin = readOrigin(raw)
        if (!origin) return
        originMap.set(origin, (originMap.get(origin) || 0) + 1)
      }
      const links = Array.from(document.querySelectorAll('a[href]'))
        .slice(0, payload.limit)
        .map((node) => {
          trackOrigin(node.href)
          return {
            text: normalize(node.textContent || node.getAttribute('aria-label') || node.getAttribute('title')) || null,
            href: node.href,
          }
        })
        .filter((entry) => entry.href)
      const iframes = payload.includeIframes
        ? Array.from(document.querySelectorAll('iframe'))
            .slice(0, payload.limit)
            .map((node) => {
              const src = node.src || node.getAttribute('src')
              trackOrigin(src)
              return {
                src,
                title: node.getAttribute('title'),
                sandbox: node.getAttribute('sandbox'),
              }
            })
        : []
      Array.from(document.querySelectorAll('img[src], video[src], audio[src], source[src], a[href*=".pdf" i]'))
        .slice(0, payload.limit)
        .forEach((node) => trackOrigin(node.currentSrc || node.src || node.href || node.getAttribute('src') || node.getAttribute('href')))
      const mediaCount =
        document.querySelectorAll('img, video, audio, picture source, a[href*=".pdf" i]').length
      const truncated = document.querySelectorAll('a[href]').length > payload.limit
      const origins = Array.from(originMap.keys()).sort()
      const resourceOrigins = {
        pageOrigin,
        sameOrigin: origins.filter((origin) => origin === pageOrigin),
        crossOrigin: origins.filter((origin) => origin !== pageOrigin),
        totalUniqueOrigins: origins.length,
      }
      return { links, iframes, resourceOrigins, mediaCount, truncated, url: location.href, capturedAt: Date.now() }
    })()`
  }
}

export { BrowserExtractionScriptBuilder }
