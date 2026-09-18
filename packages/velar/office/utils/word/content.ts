/** Word 内容归一化：把 Markdown/纯文本解析成结构化内容块。 */

import { isArray, isEmpty, isString, trimmedStringOrEmpty } from '@velaros-ai/core'

import { OfficeInputLimits } from '../../contract/constants.js'
import type { OfficeWordInput, WordBlock } from '../../types/office.js'
import { isMarkdownTableSeparator, parseMarkdownTableRow } from '../markdown.js'
import { OfficeTuning } from '../tuning.js'

/** 将工具输入统一转成结构化 WordBlock 列表。 */
export function normalizeWordBlocks(input: Pick<OfficeWordInput, 'blocks' | 'content'>): WordBlock[] {
  if (isArray(input.blocks)) return input.blocks
  return isString(input.content) ? parseWordContentToBlocks(input.content) : []
}

/** 把 Markdown/纯文本内容解析为 WordBlock。 */
export function parseWordContentToBlocks(content: string): WordBlock[] {
  const blocks: WordBlock[] = []
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  let paragraphLines: string[] = []
  let bulletItems: Array<{ text: string; level?: number }> = []

  /** 输出当前累积段落，并按最大字符数拆分。 */
  const flushParagraph = (): void => {
    const text = paragraphLines.join('\n').trim()
    paragraphLines = []
    if (!text) return
    for (const chunk of splitLongWordText(text, OfficeTuning.word.plainParagraphChars)) {
      blocks.push({ kind: 'paragraph', text: chunk, align: 'justify', spaceAfter: OfficeTuning.word.paragraphSpaceAfter })
    }
  }

  /** 输出当前累积项目符号列表。 */
  const flushBullets = (): void => {
    if (isEmpty(bulletItems)) return
    blocks.push({ kind: 'bullets', items: bulletItems })
    bulletItems = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    // 空行会结束当前段落和列表。
    if (!trimmed) {
      flushParagraph()
      flushBullets()
      continue
    }
    const table = parseMarkdownTableAt(lines, index)
    // Markdown 表格需要一次消费多行，因此更新 index 跳过已解析行。
    if (table) {
      flushParagraph()
      flushBullets()
      blocks.push(table.block)
      index = table.nextIndex - 1
      continue
    }
    const heading = parseWordContentHeading(trimmed)
    if (heading) {
      flushParagraph()
      flushBullets()
      blocks.push(heading)
      continue
    }
    const bullet = parseWordBulletLine(line)
    if (bullet) {
      flushParagraph()
      bulletItems.push(bullet)
      continue
    }
    flushBullets()
    paragraphLines.push(trimmed)
  }
  flushParagraph()
  flushBullets()
  return blocks
}

/** 将超长段落拆成多个 Word 段落，降低 docx 段落节点体积。 */
export function splitLongWordText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars)
    // 优先在句末或换行处断开；没有合适断点时按 maxChars 硬切。
    const breakAt = Math.max(
      window.lastIndexOf('\n'),
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf(';'),
      window.lastIndexOf('；'),
      window.lastIndexOf('. ')
    )
    const chunkEnd = breakAt > Math.floor(maxChars * 0.6) ? breakAt + 1 : maxChars
    chunks.push(remaining.slice(0, chunkEnd).trim())
    remaining = remaining.slice(chunkEnd).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

/** 识别 Markdown 标题、中文章节标题和常见论文段落标题。 */
export function parseWordContentHeading(
  trimmed: string
): Nullable<Extract<WordBlock, { kind: 'heading' }>> {
  const markdown = trimmed.match(/^(#{1,3})\s+(.+)$/)
  if (markdown?.[2])
    return {
      kind: 'heading',
      text: markdown[2].trim(),
      level: Math.min(markdown[1]?.length ?? 1, 3) as 1 | 2 | 3,
    }
  if (trimmed.length > OfficeInputLimits.word.headingChars) return null
  const chineseChapter = trimmed.match(
    /^(第[一二三四五六七八九十百千万\d]+[章节篇])(?:[\s、.．:：-]+(.+))?$/
  )
  if (chineseChapter?.[1])
    return {
      kind: 'heading',
      text: `${chineseChapter[1]}${chineseChapter[2] ? ` ${chineseChapter[2].trim()}` : ''}`,
      level: 1,
    }
  const numberedHeading = trimmed.match(/^(\d+(?:\.\d+){0,2})[.．、]?\s+(.+)$/)
  if (numberedHeading?.[1] && numberedHeading[2]) {
    const depth = numberedHeading[1].split('.').length
    return {
      kind: 'heading',
      text: `${numberedHeading[1]} ${numberedHeading[2].trim()}`,
      level: Math.min(depth, 3) as 1 | 2 | 3,
    }
  }
  if (/^(摘要|关键词|目录|引言|结论|参考文献|致谢|附录|Abstract|ABSTRACT|Keywords)$/u.test(trimmed))
    return { kind: 'heading', text: trimmed, level: 1 }
  return null
}

/** 识别 Markdown 项目符号，并根据缩进推导层级。 */
export function parseWordBulletLine(trimmed: string): Nullable<{ text: string; level?: number }> {
  const match = trimmed.match(/^(\s*)([-*•])\s+(.+)$/)
  if (!match?.[3]) return null
  const indent = match[1]?.length ?? 0
  return { text: match[3].trim(), level: Math.min(Math.floor(indent / 2), OfficeInputLimits.word.bulletLevel) }
}

/** 从指定行尝试解析 Markdown 表格。 */
export function parseMarkdownTableAt(
  lines: string[],
  index: number
): Nullable<{ block: Extract<WordBlock, { kind: 'table' }>; nextIndex: number }> {
  const firstRow = parseMarkdownTableRow(trimmedStringOrEmpty(lines[index]))
  const separatorLine = lines[index + 1]?.trim() ?? ''
  if (!firstRow || !isMarkdownTableSeparator(separatorLine)) return null
  const rows = [firstRow]
  let nextIndex = index + 2
  while (nextIndex < lines.length) {
    const line = lines[nextIndex]?.trim() ?? ''
    if (!line) break
    if (isMarkdownTableSeparator(line)) {
      nextIndex += 1
      continue
    }
    const row = parseMarkdownTableRow(line)
    if (!row) break
    rows.push(row)
    nextIndex += 1
  }
  if (rows.length < 2) return null
  const width = Math.min(Math.max(...rows.map((row) => row.length)), OfficeInputLimits.word.tableColumns)
  // 每行补齐到同一列数，避免 docx 表格行宽不一致。
  return {
    block: {
      kind: 'table',
      header: true,
      widthPct: OfficeInputLimits.word.maxWidthPercent,
      rows: rows
        .slice(0, OfficeInputLimits.word.tableRows)
        .map((row) => Array.from({ length: width }, (_, ci) => ({ text: row[ci] ?? '' }))),
    },
    nextIndex,
  }
}
