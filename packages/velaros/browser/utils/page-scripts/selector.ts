/**
 * 为观察到的元素生成在所属文档里唯一命中它的 CSS selector。
 * 会被 toString() 内联进页面，不能引用模块作用域；属性不唯一时退到完整祖先路径。
 */
export function browserElementSelector(element: Element): Nullable<string> {
  const owner = element.ownerDocument
  const quote = (value: string): string => value.replace(/["\\]/g, '\\$&')
  const unique = (selector: string): boolean => {
    try {
      const matches = owner.querySelectorAll(selector)
      return matches.length === 1 && matches[0] === element
    } catch {
      // arch-guard:silent-catch-ok 页面属性可能不是有效 CSS；继续尝试其它身份字段或结构路径。
      return false
    }
  }
  const tag = element.tagName.toLowerCase()
  for (const attribute of [
    'id',
    'data-testid',
    'data-test',
    'data-qa',
    'name',
    'aria-label',
    'href',
  ]) {
    const value = element.getAttribute(attribute)
    if (!value) continue
    const selector = `${tag}[${attribute}="${quote(value)}"]`
    if (unique(selector)) return selector
  }
  const parts: string[] = []
  let current: Nullable<Element> = element
  while (current) {
    const node: Element = current
    const parent: Nullable<Element> = node.parentElement
    const currentTag = node.tagName.toLowerCase()
    const siblings = parent
      ? [...parent.children].filter((child) => child.tagName === node.tagName)
      : []
    const position = siblings.indexOf(node) + 1
    parts.unshift(parent ? `${currentTag}:nth-of-type(${position})` : currentTag)
    current = parent
  }
  const selector = parts.join(' > ')
  return unique(selector) ? selector : null
}
