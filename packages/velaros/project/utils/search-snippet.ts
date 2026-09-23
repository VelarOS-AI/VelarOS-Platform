/**
 * 搜索片段的取窗与截断：片段取命中所在的那一行，行太长时以命中为中心收窄，命中本身一定在片段里。
 */

import { ProjectTuning } from './tuning.js'

/**
 * 取命中周围的片段：默认是命中所在的整行；整行超过 maxChars 时以命中为中心向两侧各取一半。
 * 命中本身比窗口还长就原样返回命中，不会切掉命中中间的字节。
 */
export function snippetWindow(
  content: string,
  start: number,
  end: number,
  maxChars: number = ProjectTuning.queries.snippetChars
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

/** 截到展示长度，截断处补省略号说明还有后文；适配器交来的片段一律过它，没有片段就原样返回。 */
export function clampSnippet(
  snippet: Optional<string>,
  maxChars: number = ProjectTuning.queries.snippetChars
): Optional<string> {
  return !snippet || snippet.length <= maxChars ? snippet : `${snippet.slice(0, maxChars)}…`
}
