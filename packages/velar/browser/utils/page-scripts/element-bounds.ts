import { encodeBrowserScriptStringLiteral } from './literal'

/**
 * 拼一段读「第一个匹配元素在视口里的矩形」的页面脚本（function-body 形式）。
 *
 * 找不到元素时返回 `{ found: false }` 而不是抛错：调用方要的是「有没有、在哪」，
 * 没有也是一个答案。坐标一律取整，省得回执里出现一堆小数。
 */
export function buildElementBoundsScript(selector: string): string {
  const selectorLiteral = encodeBrowserScriptStringLiteral(selector)

  return [
    `const el = document.querySelector(${selectorLiteral});`,
    `if (!el) return { found: false, selector: ${selectorLiteral} };`,
    'const r = el.getBoundingClientRect();',
    'return {',
    '  found: true,',
    `  selector: ${selectorLiteral},`,
    '  x: Math.round(r.x),',
    '  y: Math.round(r.y),',
    '  width: Math.round(r.width),',
    '  height: Math.round(r.height),',
    '  centerX: Math.round(r.x + r.width / 2),',
    '  centerY: Math.round(r.y + r.height / 2),',
    '};',
  ].join('\n')
}
