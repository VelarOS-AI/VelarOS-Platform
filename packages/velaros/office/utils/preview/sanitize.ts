/** 预览 HTML 的白名单净化，以及 HTML/XML 文本原语（取纯文本、解实体、截断）。 */

import { type DefaultTreeAdapterTypes, parseFragment, serialize } from 'parse5'

import { isEmpty, isUndefined } from '@velaros-ai/core'

import { OfficeTuning } from '../tuning.js'

/** 允许留在预览 HTML 里的标签。 */
const PreviewAllowedTags = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's', 'section',
  'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'u', 'ul',
])
/** 连内容一起丢掉的标签：留下它们等于把脚本、外链和外部资源带进预览页。 */
const PreviewDropWithContentTags = new Set([
  'applet', 'audio', 'base', 'embed', 'form', 'frame', 'frameset', 'iframe', 'input',
  'link', 'math', 'meta', 'noscript', 'object', 'script', 'style', 'svg', 'template',
  'video',
])
/** 允许保留的 class 名，只有预览样式表认得的这两个。 */
const PreviewAllowedClasses = new Set(['abstract', 'subtitle'])
/** 允许内嵌的位图类型；矢量与未知类型一律丢弃。 */
const PreviewRasterDataMimeTypes = new Set(['gif', 'jpeg', 'png', 'webp'])

/** 判断 img 的 src 是不是安全的内嵌位图 data URL：类型在白名单里、base64 合法、长度不超上限。 */
function isSafePreviewRasterDataUrl(value: string): boolean {
  if (value.length > OfficeTuning.preview.imageDataUrlChars) return false
  const comma = value.indexOf(',')
  if (comma < 0) return false
  const metadata = value.slice(0, comma).toLowerCase()
  const mimePrefix = 'data:image/'
  const suffix = ';base64'
  if (!metadata.startsWith(mimePrefix) || !metadata.endsWith(suffix)) return false
  const mimeType = metadata.slice(mimePrefix.length, -suffix.length)
  if (!PreviewRasterDataMimeTypes.has(mimeType)) return false

  const payload = value.slice(comma + 1)
  if (!payload || payload.length % 4 !== 0) return false
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  for (let index = 0; index < payload.length - padding; index += 1) {
    const code = payload.charCodeAt(index)
    const isBase64Character = (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || code === 43
      || code === 47
    if (!isBase64Character) return false
  }
  for (let index = payload.length - padding; index < payload.length; index += 1) {
    if (payload[index] !== '=') return false
  }
  return true
}

/** 判断 img 的 width/height 是不是合理像素数。 */
function isSafePreviewDimension(value: string): boolean {
  if (!/^\d{1,4}$/u.test(value)) return false
  const dimension = Number(value)
  return dimension >= 1 && dimension <= 8192
}

/** 判断 class 列表是不是只含白名单里的名字。 */
function isSafePreviewClassList(value: string): boolean {
  const tokens = value.trim().split(/\s+/u)
  return !isEmpty(tokens) && tokens.every((token) => PreviewAllowedClasses.has(token))
}

/** 判断链接是不是安全协议：页内锚点、http、https、mailto。 */
function isSafePreviewHref(value: string): boolean {
  const normalized = value.trim()
  if (!normalized) return false
  if (normalized.startsWith('#')) return true
  if (!URL.canParse(normalized)) return false
  const parsed = new URL(normalized)
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:'
}

/** 递归净化一个节点的子树：丢危险标签、拆未知标签、按标签过滤属性。 */
function sanitizePreviewChildren(parent: DefaultTreeAdapterTypes.ParentNode): void {
  for (let index = 0; index < parent.childNodes.length;) {
    const node = parent.childNodes[index]
    if (!node) break

    if (node.nodeName === '#comment' || node.nodeName === '#documentType') {
      parent.childNodes.splice(index, 1)
      continue
    }
    if (node.nodeName === '#text') {
      index += 1
      continue
    }

    const element = node as DefaultTreeAdapterTypes.Element
    const tagName = element.tagName.toLowerCase()
    if (PreviewDropWithContentTags.has(tagName)) {
      parent.childNodes.splice(index, 1)
      continue
    }
    if (tagName === 'img') {
      const source = element.attrs.find((attribute) => attribute.name.toLowerCase() === 'src')
      if (!source || !isSafePreviewRasterDataUrl(source.value)) {
        parent.childNodes.splice(index, 1)
        continue
      }
    }

    sanitizePreviewChildren(element)
    if (!PreviewAllowedTags.has(tagName)) {
      for (const child of element.childNodes) child.parentNode = parent
      parent.childNodes.splice(index, 1, ...element.childNodes)
      index += element.childNodes.length
      continue
    }

    element.attrs = element.attrs.filter((attribute) => {
      const name = attribute.name.toLowerCase()
      if (name === 'class') return isSafePreviewClassList(attribute.value)
      if (tagName === 'a' && name === 'href') return isSafePreviewHref(attribute.value)
      if (tagName === 'a' && name === 'title') return true
      if (tagName === 'img' && name === 'src') return isSafePreviewRasterDataUrl(attribute.value)
      if (tagName === 'img' && (name === 'alt' || name === 'title')) return true
      if (tagName === 'img' && (name === 'width' || name === 'height'))
        return isSafePreviewDimension(attribute.value)
      if ((tagName === 'td' || tagName === 'th') && (name === 'colspan' || name === 'rowspan'))
        return /^\d{1,3}$/u.test(attribute.value)
      return false
    })
    index += 1
  }
}

/** 解析并按白名单净化转换出来的 HTML，然后才写成能在浏览器里打开的预览页。 */
export function sanitizePreviewHtml(html: string): string {
  const fragment = parseFragment(html)
  sanitizePreviewChildren(fragment)
  return serialize(fragment)
}

/** 取一段 HTML 里的纯文本，标签之间补空格避免词粘连。 */
export function htmlToText(html: string): string {
  const fragment = parseFragment(html)
  const parts: string[] = []
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if (node.nodeName === '#text') {
      parts.push((node as DefaultTreeAdapterTypes.TextNode).value)
      return
    }
    if ('childNodes' in node) {
      parts.push(' ')
      for (const child of node.childNodes) visit(child)
      parts.push(' ')
    }
  }
  visit(fragment)
  return parts.join(' ')
}

/** 解 HTML/XML 实体：命名实体、十进制与十六进制数字实体；解不出来的原样留 &。 */
export function decodeHtmlText(text: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  }
  let decoded = ''
  for (let index = 0; index < text.length;) {
    if (text[index] !== '&') {
      decoded += text[index]
      index += 1
      continue
    }

    const end = text.indexOf(';', index + 1)
    if (end < 0 || end - index > 12) {
      decoded += '&'
      index += 1
      continue
    }

    const entity = text.slice(index + 1, end)
    let replacement = namedEntities[entity]
    if (!replacement && entity.startsWith('#')) {
      const hexadecimal = entity[1]?.toLowerCase() === 'x'
      const digits = entity.slice(hexadecimal ? 2 : 1)
      const validDigits = hexadecimal ? /^[0-9a-f]+$/iu.test(digits) : /^\d+$/u.test(digits)
      if (validDigits) {
        const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10)
        replacement = codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
          ? String.fromCodePoint(codePoint)
          : '�'
      }
    }

    if (isUndefined(replacement)) {
      decoded += '&'
      index += 1
      continue
    }
    decoded += replacement
    index = end + 1
  }
  return decoded
}

/** 转义写进 HTML 的文本。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 超长文本截到指定长度并补省略号。 */
export function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

/** 数一段文本里某个模式出现了几次。 */
export function countMatches(text: string, expression: RegExp): number {
  return [...text.matchAll(expression)].length
}
