/**
 * 行：把正文拆成行、数行数、取出一段连续的正文，把模型写的换行换成文件的换行风格。
 * 行号的数法和 `wc -l` 一样——结尾那个换行只是最后一行的结束，不多出一个空行。
 */

import { isArray, isEmpty, isNumber } from '@velaros-ai/core'

import type { FileTextLines } from '../types/text.js'

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
    lines.push({
      text: content.slice(start, carriage ? end - 1 : end),
      br: carriage ? '\r\n' : '\n',
    })
    start = end + 1
  }
  return { lines, eol: crlf > lf ? '\r\n' : '\n' }
}

/** 正文有几行（和 `wc -l` 的数法一样，只是最后一行没有换行时也算一行）。 */
export function lineCount(content: string): number {
  return splitLines(content).lines.length
}

/**
 * 取出 [首行, 末行] 这一段连续的正文：行与行之间是 `\n`；末行超过文件行数就到最后一行为止。
 * 读到了最后一行、而文件以换行结尾时，结尾的换行也在——整份读出来原样写回去不多一行也不少一行。
 */
export function windowText(text: FileTextLines, from: number, to: number): string {
  const last = Math.min(to, text.lines.length)
  const body = text.lines
    .slice(from - 1, last)
    .map((line) => line.text)
    .join('\n')
  const endsFile = last >= from && last === text.lines.length && !isEmpty(text.lines[last - 1]!.br)
  return endsFile ? `${body}\n` : body
}

/** 整份正文照 read 交出去的样子：行与行之间是 `\n`，文件以换行结尾的照样带着结尾的换行。 */
export function wholeText(content: string): string {
  const text = splitLines(content)
  return windowText(text, 1, text.lines.length)
}

/** 行号或区间写成 [首行, 末行]；不是合法的写法（不是正整数、末行比首行小）返回 null。 */
export function lineSpan(range: unknown): Nullable<[number, number]> {
  const valid = (line: unknown): line is number =>
    isNumber(line) && Number.isSafeInteger(line) && line > 0
  if (valid(range)) return [range, range]
  if (isArray(range) && range.length === 1 && valid(range[0])) return [range[0], range[0]]
  if (
    isArray(range) &&
    range.length === 2 &&
    valid(range[0]) &&
    valid(range[1]) &&
    range[1] >= range[0]
  )
    return [range[0], range[1]]
  return null
}

/** 模型写的新内容换成要落盘的正文：先把 `\r\n` 统一成 `\n`，再换成这个文件的换行风格。 */
export function toFileNewlines(text: string, eol: FileTextLines['eol']): string {
  const normalized = text.replace(/\r\n/g, '\n')
  return eol === '\n' ? normalized : normalized.replace(/\n/g, eol)
}
