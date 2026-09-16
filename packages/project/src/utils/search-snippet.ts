/**
 * 搜索片段的取窗与截断：脱敏之前先取够宽的窗口（命中所在的整行），脱敏之后才截到展示长度。
 * 顺序反过来（先截后脱敏）会把密钥切成半截，脱敏正则认不出，边界上的密钥就原样回给模型了。
 */

import { ProjectTuning } from './tuning.js'

/**
 * 取命中周围要交给脱敏的窗口：默认扩到命中所在行的行首行尾；整行超过 maxChars 时以命中为中心向两侧各取一半。
 * 命中本身比窗口还长就原样返回命中，不会切掉命中中间的字节。
 */
export function snippetWindow(
  content: string,
  start: number,
  end: number,
  maxChars: number = ProjectTuning.queries.snippetWindowChars,
): string {
  const from = Math.max(0, Math.min(start, content.length))
  const to = Math.max(from, Math.min(end, content.length))
  const lineStart = content.lastIndexOf('\n', Math.max(0, from - 1)) + 1
  const lineEndIndex = content.indexOf('\n', to)
  const lineEnd = lineEndIndex === -1 ? content.length : lineEndIndex
  if (lineEnd - lineStart <= maxChars) return content.slice(lineStart, lineEnd)
  const side = Math.max(0, Math.floor((maxChars - (to - from)) / 2))
  return content.slice(Math.max(lineStart, from - side), Math.min(lineEnd, to + side))
}

/** 截到展示长度：只在脱敏之后调用，截断处补省略号说明还有后文。 */
export function clampSnippet(snippet: string, maxChars: number = ProjectTuning.queries.snippetChars): string {
  return snippet.length <= maxChars ? snippet : `${snippet.slice(0, maxChars)}…`
}
