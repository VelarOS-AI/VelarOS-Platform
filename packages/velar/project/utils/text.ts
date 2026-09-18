// 域：项目文本的行列与匹配。模型给的正文先查孤立代理项、统一逻辑换行；正文里的偏移与行号互换；按换行符适配的文本匹配。
// 磁盘编码的判定、严格解码与无损重建在公共件 @velaros-ai/text-files。
import { isEmpty, isPresent } from '@velaros-ai/core'
import { textCodec } from '@velaros-ai/text-files'

import type { Range } from '../types/common.js'
import type { LineEndingAwareTextMatch } from '../types/text.js'

import { ProjectError } from './errors.js'

/** 拒绝会被 Buffer/TextEncoder 静默替换的孤立 surrogate；不解释字面反斜杠转义。 */
export function assertWellFormedProjectText(content: string): void {
  const lone = textCodec.findLoneSurrogate(content)
  if (!lone) return
  throw new ProjectError(
    'INVALID_INPUT',
    `文本在 UTF-16 offset ${lone.offset} 含不完整的 Unicode 字符，拒绝有损写入。`,
    lone,
    '请重新构造该字符的完整内容；不要把截断的 surrogate 当作字符提交。',
  )
}

/** 模型提供的正文使用统一逻辑换行；字面转义、孤立 CR 和正文中的 BOM 字符保持原样。 */
export function normalizeProjectInputText(content: string): string {
  assertWellFormedProjectText(content)
  return content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

/** 偏移落在第几行（从 1 起）。 */
export function offsetToLine(content: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

/** 第 line 行（从 1 起）的行首偏移；超出末行时返回正文长度。 */
export function lineToOffset(content: string, line: number): number {
  if (line <= 1) return 0
  let current = 1
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      current++
      if (current === line) return i + 1
    }
  }
  return content.length
}

/** 由起止偏移算出带行列（都从 1 起）的范围。 */
export function rangeFromOffsets(content: string, startOffset: number, endOffset: number): Range {
  const startLine = offsetToLine(content, startOffset)
  const endLine = offsetToLine(content, endOffset)
  const startLineOffset = lineToOffset(content, startLine)
  const endLineOffset = lineToOffset(content, endLine)
  const startColumn = startOffset - startLineOffset + 1
  const endColumn = endOffset - endLineOffset + 1
  return {
    startLine,
    endLine,
    startOffset,
    endOffset,
    startColumn: Math.max(1, startColumn),
    endColumn: Math.max(1, endColumn),
  }
}

/** 取出 [startLine, endLine] 这几行（首尾都含，越界时收到正文范围内）和它们的行范围。 */
export function sliceLines(
  content: string,
  startLine?: number,
  endLine?: number,
): { content: string; range: Range } {
  const lines = content.split(/\n/)
  const start = Math.max(1, startLine ?? 1)
  const end = Math.min(lines.length, endLine ?? lines.length)
  const selected = lines.slice(start - 1, end).join('\n')
  return { content: selected, range: { startLine: start, endLine: end } }
}

/** 数统一 diff 里增删了几行（不算 +++、--- 文件头）。 */
export function countChangedLines(diff: string): number {
  return diff
    .split('\n')
    .filter(
      (line) =>
        (line.startsWith('+') && !line.startsWith('+++')) ||
        (line.startsWith('-') && !line.startsWith('---')),
    ).length
}

/** 片段第一次出现的位置和一共出现几次（互不重叠地数）；空片段算零次。 */
export function uniqueIndexOf(content: string, needle: string): { index: number; count: number } {
  if (isEmpty(needle)) return { index: -1, count: 0 }
  let count = 0
  let index = -1
  let from = 0
  while (true) {
    const found = content.indexOf(needle, from)
    if (found === -1) break
    if (count === 0) index = found
    count++
    from = found + Math.max(1, needle.length)
  }
  return { index, count }
}

/** 按换行符适配后匹配：文件是 CRLF 而片段只含 LF 时先试 CRLF 版本，命中就连替换文本一起换成 CRLF。 */
export function resolveLineEndingAwareTextMatch(
  content: string,
  needle: string,
  replacementText?: string,
): LineEndingAwareTextMatch {
  if (shouldTryCrlfMatch(content, needle)) {
    const crlfNeedle = toCrlfText(needle)
    const crlf = uniqueIndexOf(content, crlfNeedle)
    if (crlf.count !== 0)
      return {
        ...crlf,
        matchedText: crlfNeedle,
        replacementText: isPresent(replacementText) ? toCrlfText(replacementText) : replacementText,
      }
  }

  const direct = uniqueIndexOf(content, needle)
  return { ...direct, matchedText: needle, replacementText }
}

/** 按换行符适配后，正文里有没有这个片段。 */
export function includesLineEndingAware(content: string, needle: string): boolean {
  return resolveLineEndingAwareTextMatch(content, needle).count > 0
}

/** 正文是 CRLF 而文本只含 LF 时，把文本的换行换成 CRLF；否则原样返回。 */
export function adaptTextToContentLineEndings(content: string, text: string): string {
  return shouldTryCrlfMatch(content, text) ? toCrlfText(text) : text
}

/** 正文用 CRLF、片段有换行却不含 CRLF 时，才值得换成 CRLF 再匹配。 */
function shouldTryCrlfMatch(content: string, needle: string): boolean {
  return content.includes('\r\n') && needle.includes('\n') && !needle.includes('\r\n')
}

/** 把文本里的换行统一换成 CRLF。 */
function toCrlfText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
}

/** RegExp 的空命中要显式往前推进：返回下一个完整码位的起点，边界永远落在完整字符之间。 */
export function nextCodePointOffset(content: string, offset: number): number {
  const codePoint = content.codePointAt(offset)
  return offset + ((codePoint ?? 0) > 0xffff ? 2 : 1)
}

/** 依次将整串小写化后的偏移还原到原文；无需为整个大文件分配逐字符索引。 */
export function createLowercaseOffsetMapper(content: string): (offset: number, endBoundary: boolean) => number {
  let sourceOffset = 0
  let foldedOffset = 0
  return (offset, endBoundary) => {
    while (sourceOffset < content.length && foldedOffset < offset) {
      const sourceEnd = nextCodePointOffset(content, sourceOffset)
      const foldedEnd = foldedOffset + content.slice(sourceOffset, sourceEnd).toLowerCase().length
      // 大小写展开中的局部命中也必须引用整个原字符，不能生成半个字符的区间。
      if (offset < foldedEnd) return endBoundary ? sourceEnd : sourceOffset
      sourceOffset = sourceEnd
      foldedOffset = foldedEnd
    }
    return sourceOffset
  }
}
