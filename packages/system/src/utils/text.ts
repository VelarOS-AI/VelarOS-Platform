/**
 * 文本：截取、找位置、换行转换这类纯字符串处理。
 */

import { isEmpty } from '@velaros-ai/core'

/** 取文本末尾最多 maxChars 个字符，不把代理对拆成两半。 */
export function takeUnicodeSafeTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  let start = value.length - maxChars
  const startsInsideSurrogatePair =
    value.charCodeAt(start) >= 0xdc00 &&
    value.charCodeAt(start) <= 0xdfff &&
    value.charCodeAt(start - 1) >= 0xd800 &&
    value.charCodeAt(start - 1) <= 0xdbff
  if (startsInsideSurrogatePair) start += 1
  return value.slice(start)
}

/** 把新输出接到旧输出后面，只保留末尾 maxChars 个字符。 */
export function appendBoundedOutput(previous: string, next: string, maxChars: number): string {
  return takeUnicodeSafeTail(previous + next, maxChars)
}

/**
 * 从只留末尾一段的输出缓冲区里，取出 cursor 之后还看得到的那部分。
 * `produced` 是这路输出从头到现在一共产生过多少字符，cursor 就是同一把尺子上的位置；
 * cursor 落在缓冲区已经丢掉的那一段里时，如实给出丢了多少字符，不假装输出是连续的。
 */
export function readBoundedOutputSince(
  buffer: string,
  produced: number,
  cursor: number
): { text: string; cursor: number; droppedChars: number } {
  const retainedFrom = produced - buffer.length
  const readFrom = Math.min(Math.max(cursor, 0), produced)
  if (readFrom < retainedFrom) return { text: buffer, cursor: produced, droppedChars: retainedFrom - readFrom }
  return { text: buffer.slice(readFrom - retainedFrom), cursor: produced, droppedChars: 0 }
}

/** 文件用 CRLF 换行而替换文本用 LF 时，把替换前后的文本都换成 CRLF，保证能匹配上。 */
export function adaptReplacementLineEndings(
  content: string,
  oldText: string,
  newText: string
): { oldText: string; newText: string } {
  if (content.includes(oldText) || !content.includes('\r\n')) return { oldText, newText }

  const oldTextWithCrlf = toCrlf(oldText)
  if (!content.includes(oldTextWithCrlf)) return { oldText, newText }

  return {
    oldText: oldTextWithCrlf,
    newText: toCrlf(newText),
  }
}


/** 把文本里的换行统一成 CRLF。 */
function toCrlf(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
}

/** 在 range 这段范围里找 needle 出现的每个位置，按出现顺序返回起点；不重叠计数，needle 为空返回空列表。 */
export function findOccurrences(value: string, needle: string, range: { offset: number; end: number }): number[] {
  if (isEmpty(needle)) return []
  const found: number[] = []
  let index = range.offset
  while (index < range.end) {
    const at = value.indexOf(needle, index)
    if (at === -1 || at + needle.length > range.end) break
    found.push(at)
    index = at + 1
  }
  return found
}
