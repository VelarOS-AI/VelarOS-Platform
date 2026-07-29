/** 注入页面上下文的共享片段，包含归一化、路径构造、角色推断和可见性判断。 */

export function buildBrowserInlineInferenceToolkitSnippet(
  includeAriaLabelCssPathInBuilder = false
): string {
  const ariaLabelCssPath = includeAriaLabelCssPathInBuilder
    ? `
        const ariaLabel = node.getAttribute('aria-label')
        if (ariaLabel) return node.tagName.toLowerCase() + '[aria-label="' + quoteAttr(ariaLabel) + '"]'`
    : ''

  return `
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
      const escapeCss = (value) => {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value))
        return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&')
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
        if (name) return node.tagName.toLowerCase() + '[name="' + quoteAttr(name) + '"]'${ariaLabelCssPath}

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
      const isVisible = (node) => {
        if (!(node instanceof Element)) return false
        const style = window.getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0'
          && rect.width > 0
          && rect.height > 0
      }`
}
