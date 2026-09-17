/**
 * 文本：按字符截取输出的纯字符串处理。
 */

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
