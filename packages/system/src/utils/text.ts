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

/** 一段文本的换行风格：CRLF 比裸 LF 多就是 crlf，否则是 lf；一个换行都没有返回 null。 */
export function lineEndingStyle(value: string): Nullable<'crlf' | 'lf'> {
  const crlf = value.split('\r\n').length - 1
  const lf = value.split('\n').length - 1 - crlf
  if (crlf + lf === 0) return null
  return crlf > lf ? 'crlf' : 'lf'
}

/** 按换行风格改写一段要写进去的文本：crlf 风格时里面的换行统一成 CRLF，其余原样返回。 */
export function withLineEndingStyle(value: string, style: Nullable<'crlf' | 'lf'>): string {
  return style === 'crlf' ? toCrlf(value) : value
}

/**
 * 按原文的换行风格改写一处替换：oldText 在这段原文里原样找不到、换成 CRLF 才找得到时用 CRLF 版本；
 * 原文以 CRLF 为主（style）或者 oldText 换成了 CRLF 时，newText 里的换行也统一成 CRLF，不在 CRLF 文件里混进裸 LF。
 */
export function adaptReplacementLineEndings(
  content: string,
  oldText: string,
  newText: string,
  style: Nullable<'crlf' | 'lf'>
): { oldText: string; newText: string } {
  const oldTextWithCrlf = toCrlf(oldText)
  const useCrlf = !content.includes(oldText) && content.includes('\r\n') && content.includes(oldTextWithCrlf)
  return {
    oldText: useCrlf ? oldTextWithCrlf : oldText,
    newText: useCrlf ? toCrlf(newText) : withLineEndingStyle(newText, style),
  }
}


/** 把文本里的换行统一成 CRLF。 */
function toCrlf(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
}

/** 在 range 这段范围里找 needle 出现的位置，按出现顺序返回起点，允许重叠；最多找 limit 个就停（调用方只需要「唯一吗」和前几个锚点），needle 为空返回空列表。 */
export function findOccurrences(value: string, needle: string, range: { offset: number; end: number }, limit: number): number[] {
  if (isEmpty(needle) || limit <= 0) return []
  const found: number[] = []
  let index = range.offset
  while (index < range.end && found.length < limit) {
    const at = value.indexOf(needle, index)
    if (at === -1 || at + needle.length > range.end) break
    found.push(at)
    index = at + 1
  }
  return found
}

/**
 * 把一个正整数上限钳到 `limit`；没给就返回 undefined（由下游用它自己的缺省）。
 *
 * **钳而不拒**是仓库的口径：超了按上限跑，别为一个数字废掉一整次调用。
 * 放在这里而不是入参 schema 里，是因为预算属于那件能力自己——
 * 靠调用方那一侧拦，换一个入口（代码面、内核按名调用）就漏了。
 */
export function clampPositive(value: Optional<number>, limit: number): Optional<number> {
  return value === undefined ? undefined : Math.max(1, Math.min(Math.floor(value), limit))
}
