import { ProjectError } from '../../errors.js'

export interface SourceLine {
  start: number
  bodyEnd: number
  end: number
  logicalStart: number
  newline: string
}

/** CRLF is a physical encoding of one logical newline; every other source character is literal. */
export class ProjectSourceCoordinates {
  readonly lines: SourceLine[] = []
  readonly logical: string

  constructor(readonly content: string) {
    let start = 0
    let removed = 0
    for (let end = content.indexOf('\n'); end !== -1; end = content.indexOf('\n', start)) {
      const crlf = end > start && content[end - 1] === '\r'
      this.lines.push({ start, bodyEnd: end - (crlf ? 1 : 0), end: end + 1, logicalStart: start - removed, newline: crlf ? '\r\n' : '\n' })
      removed += crlf ? 1 : 0
      start = end + 1
    }
    this.lines.push({ start, bodyEnd: content.length, end: content.length, logicalStart: start - removed, newline: '' })
    this.logical = content.replace(/\r\n/g, '\n')
  }

  public lineAt(offset: number, logical = false): number {
    let low = 0
    let high = this.lines.length
    while (low + 1 < high) {
      const middle = (low + high) >>> 1
      const start = logical ? this.lines[middle].logicalStart : this.lines[middle].start
      if (start <= offset) low = middle
      else high = middle
    }
    return low + 1
  }

  public physicalOffset(offset: number): number {
    const line = this.lines[this.lineAt(offset, true) - 1]
    return line.start + offset - line.logicalStart
  }

  public logicalOffset(offset: number): number {
    const line = this.lines[this.lineAt(offset) - 1]
    if (line.newline === '\r\n' && offset === line.bodyEnd + 1) {
      throw new ProjectError('INVALID_INPUT', '源码覆盖范围不能截断 CRLF 换行。')
    }
    return line.logicalStart + offset - line.start
  }

  public newlineAt(start: number, end = start): string {
    const first = this.lineAt(start) - 1
    const last = this.lineAt(Math.max(start, end - 1)) - 1
    for (let index = first; index <= last; index += 1) {
      if (this.lines[index].newline) return this.lines[index].newline
    }
    for (let index = first - 1; index >= 0; index -= 1) {
      if (this.lines[index].newline) return this.lines[index].newline
    }
    return '\n'
  }
}

export function normalizePhysicalNewlines(text: string, newline: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, newline)
}
