/**
 * 文本：按字符截取输出、把终端输出整成纯文本，都是纯字符串处理。
 */

/** 终端控制序列：CSI（ESC [ … 终止字节）、OSC（ESC ] … BEL 或 ESC \）、选字符集，以及其余两字节的 ESC 序列（ESC 7、ESC = 这类）。 */
const TerminalControlSequence =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()#][0-9A-Za-z]|\u001b[0-~]/gu

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
  if (readFrom < retainedFrom)
    return { text: buffer, cursor: produced, droppedChars: retainedFrom - readFrom }
  return { text: buffer.slice(readFrom - retainedFrom), cursor: produced, droppedChars: 0 }
}

/**
 * 把终端输出整成纯文本给模型看：去掉颜色、光标移动这些控制序列；一行里回车回到行首、后写的盖住先写的
 * （进度条只留最后一版），退格往回退一格；其余控制字符丢掉。不是终端模拟，只求读得懂。
 */
export function plainTerminalText(value: string): string {
  return value.replace(TerminalControlSequence, '').split('\n').map(resolveTerminalLine).join('\n')
}

/** 一行里的回车、退格与其余控制字符，照终端的样子落成这一行最后看到的文字。 */
function resolveTerminalLine(line: string): string {
  const cells: string[] = []
  let column = 0
  for (const char of line) {
    if (char === '\r') column = 0
    else if (char === '\b') column = Math.max(0, column - 1)
    else if (char >= ' ' || char === '\t') {
      cells[column] = char
      column += 1
    }
  }
  return cells.join('')
}
