/** Word 内容归一化：把 Markdown/纯文本解析成结构化内容块。 */

import { isArray, isEmpty, isString, trimmedStringOrEmpty } from '@velaros-ai/core'

import { OfficeInputLimits } from '../../contract/constants.js'
import type { OfficeWordInput, WordBlock } from '../../types/office.js'
import { isMarkdownTableSeparator, parseMarkdownTableRow } from '../markdown.js'
import { OfficeTuning } from '../tuning.js'

/** 将工具输入统一转成结构化 WordBlock 列表。 */
export function normalizeWordBlocks(
  input: Pick<OfficeWordInput, 'blocks' | 'content'>
): WordBlock[] {
  if (isArray(input.blocks)) return input.blocks
  return isString(input.content) ? parseWordContentToBlocks(input.content) : []
}

/**
 * 把 Markdown/纯文本内容解析为 WordBlock。用了 Markdown 标题（#）的内容按 Markdown 读：标题只认 #，「1. 」开头的行
 * 是有序列表。纯文本里「1 引言」「1.1 背景」这类编号行照旧认作章节标题，除非它跟前后行连成一串编号——那是列表。
 */
export function parseWordContentToBlocks(content: string): WordBlock[] {
  const blocks: WordBlock[] = []
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const markdown = lines.some((line) => /^#{1,6}\s+\S/.test(line.trim()))
  let paragraphLines: string[] = []
  let listItems: Array<{ text: string; level?: number }> = []
  let listOrdered = false

  /** 输出当前累积段落，并按最大字符数拆分。 */
  const flushParagraph = (): void => {
    const text = paragraphLines.join('\n').trim()
    paragraphLines = []
    if (!text) return
    for (const chunk of splitLongWordText(text, OfficeTuning.word.plainParagraphChars)) {
      blocks.push({
        kind: 'paragraph',
        text: chunk,
        align: 'justify',
        spaceAfter: OfficeTuning.word.paragraphSpaceAfter,
      })
    }
  }

  /** 输出当前累积的列表。 */
  const flushList = (): void => {
    if (isEmpty(listItems)) return
    const block: Extract<WordBlock, { kind: 'bullets' }> = { kind: 'bullets', items: listItems }
    if (listOrdered) block.ordered = true
    blocks.push(block)
    listItems = []
  }

  /** 接一项到列表里；跟当前列表不是同一种（编号与项目符号）就先把当前的收掉。 */
  const pushListItem = (item: { text: string; level?: number }, ordered: boolean): void => {
    flushParagraph()
    if (listOrdered !== ordered) flushList()
    listOrdered = ordered
    listItems.push(item)
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    // 空行会结束当前段落和列表；有序列表项之间隔着空行（Markdown 的松散列表）仍是同一个列表，编号接着排。
    if (!trimmed) {
      flushParagraph()
      if (!(listOrdered && isOrderedListLine(nextNonBlankLine(lines, index)))) flushList()
      continue
    }
    const table = parseMarkdownTableAt(lines, index)
    // Markdown 表格需要一次消费多行，因此更新 index 跳过已解析行。
    if (table) {
      flushParagraph()
      flushList()
      blocks.push(table.block)
      index = table.nextIndex - 1
      continue
    }
    const ordered = parseWordOrderedLine(line)
    if (
      ordered &&
      (markdown ||
        (listOrdered && !isEmpty(listItems)) ||
        isOrderedListLine(lines[index - 1]) ||
        isOrderedListLine(lines[index + 1]))
    ) {
      pushListItem(ordered, true)
      continue
    }
    const heading = markdown ? parseMarkdownHeading(trimmed) : parseWordContentHeading(trimmed)
    if (heading) {
      flushParagraph()
      flushList()
      blocks.push(heading)
      continue
    }
    const bullet = parseWordBulletLine(line)
    if (bullet) {
      pushListItem(bullet, false)
      continue
    }
    flushList()
    paragraphLines.push(trimmed)
  }
  flushParagraph()
  flushList()
  return blocks
}

/**
 * 正文第一块是跟 title 同名的一级标题时去掉：抬头已经把 title 写成大标题，Markdown 里的 # 标题再写一遍就重复了。
 */
export function withoutRepeatedTitle(blocks: WordBlock[], title: Optional<string>): WordBlock[] {
  const [first, ...rest] = blocks
  const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim()
  if (
    !title ||
    first?.kind !== 'heading' ||
    (first.level ?? 1) !== 1 ||
    normalize(first.text) !== normalize(title)
  )
    return blocks
  return rest
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

/** 识别 Markdown 标题（# 到 ###，更深的按三级算）。 */
export function parseMarkdownHeading(
  trimmed: string
): Nullable<Extract<WordBlock, { kind: 'heading' }>> {
  const markdown = trimmed.match(/^(#{1,6})\s+(.+)$/)
  if (!markdown?.[2]) return null
  return {
    kind: 'heading',
    text: markdown[2].trim(),
    level: Math.min(markdown[1]?.length ?? 1, 3) as 1 | 2 | 3,
  }
}

/** 识别 Markdown 标题、中文章节标题和常见论文段落标题（纯文本用）。 */
export function parseWordContentHeading(
  trimmed: string
): Nullable<Extract<WordBlock, { kind: 'heading' }>> {
  const markdown = parseMarkdownHeading(trimmed)
  if (markdown) return markdown
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

/** 识别有序列表项：Markdown 的「1. 」「1) 」，以及中文常写的「1、」「1．」「1）」；按缩进推导层级。 */
export function parseWordOrderedLine(line: string): Nullable<{ text: string; level?: number }> {
  const match = line.match(/^(\s*)\d{1,9}(?:[.)]\s+|[、．）]\s*)(\S.*)$/)
  if (!match?.[2]) return null
  const indent = match[1]?.length ?? 0
  return {
    text: match[2].trim(),
    level: Math.min(Math.floor(indent / 2), OfficeInputLimits.word.bulletLevel),
  }
}

/** 这一行是不是有序列表项。 */
function isOrderedListLine(line: Optional<string>): boolean {
  return !!line && !!parseWordOrderedLine(line)
}

/** 这一行之后第一条不是空白的行。 */
function nextNonBlankLine(lines: readonly string[], index: number): Optional<string> {
  return lines.slice(index + 1).find((line) => !!line.trim())
}

/** 识别 Markdown 项目符号，并根据缩进推导层级。 */
export function parseWordBulletLine(trimmed: string): Nullable<{ text: string; level?: number }> {
  const match = trimmed.match(/^(\s*)([-*•])\s+(.+)$/)
  if (!match?.[3]) return null
  const indent = match[1]?.length ?? 0
  return {
    text: match[3].trim(),
    level: Math.min(Math.floor(indent / 2), OfficeInputLimits.word.bulletLevel),
  }
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
  const width = Math.min(
    Math.max(...rows.map((row) => row.length)),
    OfficeInputLimits.word.tableColumns
  )
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
