import { isEmpty } from '@velaros-ai/core'

import { normalizePhysicalNewlines, type ProjectSourceCoordinates } from '../selectors/source.js'

export function replacementLineText(source: ProjectSourceCoordinates, start: number, end: number, text: string): string {
  if (isEmpty(text)) return ''
  // 只选中末尾换行之后那条空行时，替换就是在文件末尾写入整行，和插入一样保留原有的末尾换行。
  if (start === end) return insertionLineText(source, start, text)
  const newline = source.newlineAt(start, end)
  const replacement = normalizePhysicalNewlines(text, newline)
  return source.content.slice(start, end).endsWith('\n') && !replacement.endsWith('\n')
    ? replacement + newline
    : replacement
}

/** 分隔插入的整行内容，并保留原文件末尾换行约定，除非输入文本明确改变它。 */
export function insertionLineText(source: ProjectSourceCoordinates, offset: number, text: string): string {
  if (isEmpty(text)) return ''
  const newline = source.newlineAt(offset)
  const insertion = normalizePhysicalNewlines(text, newline)
  if (isEmpty(source.content)) return insertion
  const before = offset > 0 && source.content[offset - 1] !== '\n' ? newline : ''
  const followingLine = offset < source.content.length || source.content.endsWith('\n')
  const after = followingLine && !insertion.endsWith('\n') ? newline : ''
  return before + insertion + after
}
