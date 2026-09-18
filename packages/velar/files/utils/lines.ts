/**
 * 行：把正文拆成带行号的行、按行号改几处、再拼回正文。行号的数法和 `wc -l` 一样——结尾那个换行只是最后一行的结束，不多出一个空行。
 * 每一行记着自己原来的换行符：没动的行原样拼回去，新写的行用这个文件为主的换行风格，文件原来结尾没有换行的，改完也没有。
 */

import { isArray, isEmpty, isNumber, isPlainObject, isString, isUndefined } from '@velaros-ai/core'

import { FileLimits } from '../contract/constants.js'
import type { FileLineSplice, FileTextLines } from '../types/text.js'

/** 把正文拆成行：`\r\n` 与 `\n` 都算换行，行文本里不带换行符；新写的行用出现得多的那种换行（一样多或没有换行时用 `\n`）。 */
export function splitLines(content: string): FileTextLines {
  const lines: FileTextLines['lines'] = []
  let crlf = 0
  let lf = 0
  let start = 0
  while (start < content.length) {
    const end = content.indexOf('\n', start)
    if (end === -1) {
      lines.push({ text: content.slice(start), br: '' })
      break
    }
    const carriage = end > start && content[end - 1] === '\r'
    if (carriage) crlf += 1
    else lf += 1
    lines.push({ text: content.slice(start, carriage ? end - 1 : end), br: carriage ? '\r\n' : '\n' })
    start = end + 1
  }
  return { lines, eol: crlf > lf ? '\r\n' : '\n' }
}

/** 把行拼回正文：每行接上它自己的换行符。 */
export function joinLines(text: FileTextLines): string {
  return text.lines.map((line) => line.text + line.br).join('')
}

/** 正文有几行（和 `wc -l` 的数法一样，只是最后一行没有换行时也算一行）。 */
export function lineCount(content: string): number {
  return splitLines(content).lines.length
}

/** 取出 [首行, 末行] 这一段带行号的行；末行超过文件行数就到最后一行为止。 */
export function numberedLines(text: FileTextLines, from: number, to: number): Array<[number, string]> {
  const numbered: Array<[number, string]> = []
  for (let line = from; line <= Math.min(to, text.lines.length); line += 1) numbered.push([line, text.lines[line - 1]!.text])
  return numbered
}

/** 行号或区间写成 [首行, 末行]；不是合法的写法（不是正整数、末行比首行小）返回 null。 */
export function lineSpan(range: unknown): Nullable<[number, number]> {
  const valid = (line: unknown): line is number => isNumber(line) && Number.isSafeInteger(line) && line > 0
  if (valid(range)) return [range, range]
  if (isArray(range) && range.length === 1 && valid(range[0])) return [range[0], range[0]]
  if (isArray(range) && range.length === 2 && valid(range[0]) && valid(range[1]) && range[1] >= range[0]) return [range[0], range[1]]
  return null
}

/** 模型写的新内容换成要落盘的正文：先把 `\r\n` 统一成 `\n`，再换成这个文件的换行风格。 */
export function toFileNewlines(text: string, eol: FileTextLines['eol']): string {
  const normalized = text.replace(/\r\n/g, '\n')
  return eol === '\n' ? normalized : normalized.replace(/\n/g, eol)
}

/** 把一处改动的 text 拆成新的行：空串是零行（删掉），其余按 `\n` 拆。 */
function newLinesOf(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n')
  return isEmpty(normalized) ? [] : normalized.split('\n')
}

/**
 * 按行号改几处：行号都按改之前那一版算，几处不能重叠（插入点落在被换掉的几行中间也算重叠）。
 * 改法不合法（形状不对、行号越界、重叠）返回一句说明，调用方把它记成这个文件的问题；合法就返回改好的行。
 */
export function applyLineEdits(text: FileTextLines, edits: unknown): FileTextLines | string {
  if (!isArray(edits) || edits.length < 1 || edits.length > FileLimits.editsPerFile) return `edits 要 1–${FileLimits.editsPerFile} 处改动的数组`
  const total = text.lines.length
  const splices: FileLineSplice[] = []
  for (const [order, edit] of edits.entries()) {
    const where = `edits[${order}]`
    if (!isPlainObject(edit) || !isString(edit.text)) return `${where} 要 { range, text } 或 { after, text }，text 是字符串`
    const shaped = edit as Partial<Record<'range' | 'after', unknown>> & { text: string }
    if (!isUndefined(shaped.range) === !isUndefined(shaped.after)) return `${where} 的 range 与 after 只给一个：换掉几行给 range，插入给 after`
    if (!isUndefined(shaped.range)) {
      const span = lineSpan(shaped.range)
      if (!span) return `${where}.range 要行号或 [首行, 末行]（从 1 起，末行不小于首行），这里给的是 ${JSON.stringify(shaped.range)}`
      if (span[1] > total) return `${where}.range 超出了文件：文件只有 ${total} 行，这里要到第 ${span[1]} 行`
      splices.push({ start: span[0], end: span[1], lines: newLinesOf(shaped.text), order })
      continue
    }
    const after = shaped.after
    if (!isNumber(after) || !Number.isSafeInteger(after) || after < 0 || after > total) return `${where}.after 要 0–${total} 的整数（0 是插在最前面，${total} 是接在最后一行后面），这里给的是 ${JSON.stringify(after)}`
    splices.push({ start: after + 1, end: after, lines: newLinesOf(shaped.text), order })
  }
  const replaced = splices.filter((splice) => splice.end >= splice.start)
  for (const splice of splices) {
    const clash = replaced.find((other) => other !== splice && (splice.end >= splice.start
      ? splice.start <= other.end && other.start <= splice.end
      : other.start <= splice.end && splice.end < other.end))
    if (clash) return `edits[${splice.order}] 与 edits[${clash.order}] 重叠了：同一个文件的几处改动要落在不同的行上，挨着的合成一处`
  }
  // 从后往前改：前面的行号在改后面时不动，几处都按改之前那一版的行号算。位置相同的插入按给的顺序排。
  // 同一个位置上先换后插：插在第 n 行后面的内容落在第 n+1 行起被换掉的那一段前面。
  const ordered = [...splices].sort((a, b) => b.start - a.start || (b.end - b.start) - (a.end - a.start) || b.order - a.order)
  const lines = text.lines.map((line) => ({ ...line }))
  const endsWithBreak = total > 0 && !isEmpty(text.lines[total - 1]!.br)
  for (const splice of ordered) {
    lines.splice(splice.start - 1, splice.end - splice.start + 1, ...splice.lines.map((line) => ({ text: line, br: text.eol })))
  }
  // 除了最后一行，每行都得有换行（原来的最后一行后面接了新行时，它要补上一个）；
  // 结尾换不换行照原文件：原来最后一行没有换行的（空文件也算），改完的最后一行也没有。
  for (const [index, line] of lines.entries()) if (index < lines.length - 1 && !line.br) line.br = text.eol
  const last = lines.at(-1)
  if (last && !endsWithBreak) last.br = ''
  return { lines, eol: text.eol }
}
