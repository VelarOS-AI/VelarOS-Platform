// 域：源码坐标。CRLF 是一个逻辑换行在磁盘上的写法，其余字符都按原样计：编辑按逻辑正文匹配，再按物理偏移落回原文。
import type { ProjectSourceCoordinates, SourceLine, SourceSplice } from '../../types/editing.js'
import { ProjectError } from '../errors.js'

/** 给一份源码建坐标索引：逐行记下物理起止、正文结束处、逻辑起点与换行写法。 */
export function createProjectSourceCoordinates(content: string): ProjectSourceCoordinates {
  const lines: SourceLine[] = []
  let start = 0
  let removed = 0
  for (let end = content.indexOf('\n'); end !== -1; end = content.indexOf('\n', start)) {
    const crlf = end > start && content[end - 1] === '\r'
    lines.push({ start, bodyEnd: end - (crlf ? 1 : 0), end: end + 1, logicalStart: start - removed, newline: crlf ? '\r\n' : '\n' })
    removed += crlf ? 1 : 0
    start = end + 1
  }
  lines.push({ start, bodyEnd: content.length, end: content.length, logicalStart: start - removed, newline: '' })
  return { content, lines, logical: content.replace(/\r\n/g, '\n') }
}

/** 偏移落在第几行（从 1 起）；logical 为 true 时把 offset 当逻辑偏移。 */
export function sourceLineAt(source: ProjectSourceCoordinates, offset: number, logical = false): number {
  let low = 0
  let high = source.lines.length
  while (low + 1 < high) {
    const middle = (low + high) >>> 1
    const start = logical ? source.lines[middle].logicalStart : source.lines[middle].start
    if (start <= offset) low = middle
    else high = middle
  }
  return low + 1
}

/** 把逻辑偏移换成原文里的物理偏移。 */
export function physicalSourceOffset(source: ProjectSourceCoordinates, offset: number): number {
  const line = source.lines[sourceLineAt(source, offset, true) - 1]
  return line.start + offset - line.logicalStart
}

/** 把物理偏移换成逻辑偏移；偏移落在 CRLF 两个字符中间时拒绝，覆盖范围不能把一个换行切成两半。 */
export function logicalSourceOffset(source: ProjectSourceCoordinates, offset: number): number {
  const line = source.lines[sourceLineAt(source, offset) - 1]
  if (line.newline === '\r\n' && offset === line.bodyEnd + 1) {
    throw new ProjectError('INVALID_INPUT', '源码覆盖范围不能截断 CRLF 换行。')
  }
  return line.logicalStart + offset - line.start
}

/** [start, end) 这段该用哪种换行：先看段内各行，没有换行再往前找，整份源码都没有换行时用 LF。 */
export function sourceNewlineAt(source: ProjectSourceCoordinates, start: number, end = start): string {
  const first = sourceLineAt(source, start) - 1
  const last = sourceLineAt(source, Math.max(start, end - 1)) - 1
  for (let index = first; index <= last; index += 1) {
    if (source.lines[index].newline) return source.lines[index].newline
  }
  for (let index = first - 1; index >= 0; index -= 1) {
    if (source.lines[index].newline) return source.lines[index].newline
  }
  return '\n'
}

/** 把文本里的换行统一成给定写法（CRLF 先归一成 LF 再换）。 */
export function normalizePhysicalNewlines(text: string, newline: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, newline)
}

/** 把一处拼接落到原文上：用 splice.text 替换 [start, end)。 */
export function applySourceSplice(content: string, splice: SourceSplice): string {
  return content.slice(0, splice.start) + splice.text + content.slice(splice.end)
}
