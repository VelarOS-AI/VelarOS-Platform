/**
 * 按原文换一段（replace）：oldText 要在正文里一模一样地出现、而且只出现一次。
 * 换行按 `\n` 比——文件里的 `\r\n` 看成 `\n`，所以读到的正文原样抄进 oldText 就对得上；
 * 没被换到的地方一个字节都不动（各行原来的换行符照旧），换进去的新文按这个文件为主的换行风格写。
 */

import { isEmpty } from '@velaros-ai/core'

import type { FileTextLines } from '../types/text.js'

import { toFileNewlines } from './lines.js'
import { FileTuning } from './tuning.js'

/** oldText 出现了好几处：说出现了几次、前几处在第几行（同一行的几处只算一行）。命中按位置从前往后，行号边走边数。 */
function repeatedMatch(logical: string, needle: string, first: number): string {
  const lines: number[] = []
  let total = 0
  let hidden = false
  let line = 1
  let counted = 0
  for (let at = first; at !== -1; at = logical.indexOf(needle, at + 1)) {
    total += 1
    if (hidden) continue
    for (
      let next = logical.indexOf('\n', counted);
      next !== -1 && next < at;
      next = logical.indexOf('\n', next + 1)
    ) {
      line += 1
      counted = next + 1
    }
    if (lines.at(-1) === line) continue
    if (lines.length < FileTuning.replace.shownMatches) lines.push(line)
    else hidden = true
  }
  const more = hidden ? ' 等' : ''
  return `oldText 在文件里出现了 ${total} 次（第 ${lines.join('、')} 行${more}）；多带几行上下文让它只出现一次`
}

/** oldText 一处都没有：拿它第一行非空的内容去找最像的几行（去掉首尾空白后相同的优先，其次是包含它的），给出行号和原文。 */
function missingMatch(logical: string, needle: string): string {
  const probe = needle
    .split('\n')
    .map((line) => line.trim())
    .find((line) => !isEmpty(line))
  const rows = logical.split('\n')
  const pick = (matches: (row: string) => boolean) => {
    const found: Array<{ line: number; row: string }> = []
    for (const [index, row] of rows.entries()) {
      if (found.length >= FileTuning.replace.nearLines) break
      if (matches(row.trim())) found.push({ line: index + 1, row: row.trim() })
    }
    return found
  }
  const exact = probe ? pick((row) => row === probe) : []
  const near = probe && isEmpty(exact) ? pick((row) => row.includes(probe)) : exact
  if (isEmpty(near))
    return 'oldText 在文件里没有一模一样的原文，也找不到相近的行；先 read 要改的那一段，照读到的原文写 oldText（空白、引号、换行都要一样）'
  const shown = near
    .map(({ row, line }) => `第 ${line} 行「${row.slice(0, FileTuning.replace.nearLineChars)}」`)
    .join('、')
  return `oldText 在文件里没有一模一样的原文，最像的是${shown}；照那里的原文写 oldText（空白、引号、换行都要一样）`
}

/**
 * 把 content 里唯一的一段 oldText 换成 newText。eol 是这个文件为主的换行风格，换进去的新文按它写。
 * 找不到、不唯一时交回一句说明（找不到的带上最像的几行，不唯一的带上在第几行），调用方记成这一步的问题。
 */
export function replaceOnce(
  content: string,
  eol: FileTextLines['eol'],
  oldText: string,
  newText: string
): { content: string } | { problem: string } {
  // 逻辑正文：`\r\n` 看成一个 `\n`。记下每个 `\r\n` 的 `\n` 在逻辑正文里的位置，换回磁盘上的位置时用。
  const crlfs: number[] = []
  for (let at = content.indexOf('\r\n'); at !== -1; at = content.indexOf('\r\n', at + 2))
    crlfs.push(at - crlfs.length)
  const logical = isEmpty(crlfs) ? content : content.replace(/\r\n/g, '\n')
  // 逻辑位置换成磁盘上的位置：前面有几个 `\r\n`，就往后挪几个字符。
  const physical = (at: number) => {
    let low = 0
    let high = crlfs.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (crlfs[middle]! < at) low = middle + 1
      else high = middle
    }
    return at + low
  }
  const needle = oldText.replace(/\r\n/g, '\n')
  const first = logical.indexOf(needle)
  if (first === -1) return { problem: missingMatch(logical, needle) }
  if (logical.includes(needle, first + 1)) return { problem: repeatedMatch(logical, needle, first) }
  const start = physical(first)
  const end = physical(first + needle.length)
  return {
    content: `${content.slice(0, start)}${toFileNewlines(newText, eol)}${content.slice(end)}`,
  }
}
