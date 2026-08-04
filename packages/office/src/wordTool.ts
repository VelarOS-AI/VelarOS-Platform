/**
 * wordTool.ts
 *
 * Word (.docx) 文档生成工具。
 * 依赖：officeShared（共享类型 + 路径辅助）
 */
import { readFile } from 'node:fs/promises'
import { platform as nodePlatform } from 'node:os'

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  type FileChild,
  Footer,
  HeadingLevel,
  type IRunOptions,
  type ITableCellOptions,
  LineRuleType,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableOfContents,
  TableRow,
  TextRun,
  UnderlineType,
  VerticalAlign,
  WidthType,
} from 'docx'
import JSZip from 'jszip'
import { z } from 'zod'

import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/agent/tool-contract'
import { isArray, isEmpty, isNonBlankString, isPresent, isString, optionalWhen,optionalWhenLazy, trimmedStringOrEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  dirname,
  getFileStats,
  isMarkdownTableSeparator,
  mkdir,
  normalizeExtensionPath,
  type OfficeOutput,
  type OfficeToolContext,
  outputPathSchema,
  parseMarkdownTableRow,
  writeOfficeBuffer,
} from './officeShared'

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Word 文本片段，可控制样式、上下标、链接和换行。 */
export type WordTextRun = {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  highlight?:
    | 'yellow'
    | 'green'
    | 'cyan'
    | 'magenta'
    | 'blue'
    | 'red'
    | 'darkBlue'
    | 'darkCyan'
    | 'darkGreen'
    | 'darkMagenta'
    | 'darkRed'
    | 'darkYellow'
    | 'darkGray'
    | 'lightGray'
    | 'black'
  fontSize?: number
  font?: string
  superScript?: boolean
  subScript?: boolean
  link?: string
  break?: number
}

/** Word 表格单元格输入，支持文本、富文本、合并和背景色。 */
export type WordTableCellInput = {
  text?: string
  runs?: WordTextRun[]
  bold?: boolean
  color?: string
  bgColor?: string
  align?: 'left' | 'center' | 'right' | 'justify'
  verticalAlign?: 'top' | 'center' | 'bottom'
  columnSpan?: number
  rowSpan?: number
}

/** Word 文档高层排版模板。 */
export type WordDocumentProfile = 'standard' | 'academic-paper' | 'thesis'

/** 论文/报告封面和元数据字段。 */
export type WordDocumentMetadata = {
  subtitle?: string
  school?: string
  department?: string
  major?: string
  course?: string
  className?: string
  studentId?: string
  advisor?: string
  date?: string
  organization?: string
}

/** Word 文档的结构化内容块。 */
export type WordBlock =
  | {
      kind: 'heading'
      text: string
      level?: 1 | 2 | 3
      color?: string
      align?: 'left' | 'center' | 'right'
    }
  | {
      kind: 'paragraph'
      text?: string
      runs?: WordTextRun[]
      align?: 'left' | 'center' | 'right' | 'justify'
      spaceBefore?: number
      spaceAfter?: number
      indent?: number
    }
  | {
      kind: 'bullets'
      items: Array<string | { text: string; runs?: WordTextRun[]; level?: number }>
    }
  | {
      kind: 'table'
      rows: WordTableCellInput[][]
      header?: boolean
      headerBgColor?: string
      borderColor?: string
      widthPct?: number
    }
  | { kind: 'pageBreak' }

/** office:create_word_document 工具输入。 */
export type CreateWordDocumentInput = {
  cwd?: string
  outputPath: string
  title?: string
  author?: string
  profile?: WordDocumentProfile
  language?: 'zh-CN' | 'en-US'
  metadata?: WordDocumentMetadata
  abstract?: string
  keywords?: string[]
  includeTableOfContents?: boolean
  blocks?: WordBlock[] | string
  content?: string
  overwrite?: boolean
  appendMode?: boolean
}

// ─── Zod schema ────────────────────────────────────────────────────────────────

/** Word rich text run 的输入 schema。 */
export const wordTextRunSchema = z.object({
  text: z.string(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strike: z.boolean().optional(),
  color: z.string().optional(),
  highlight: z.string().optional(),
  fontSize: z.number().optional(),
  font: z.string().optional(),
  superScript: z.boolean().optional(),
  subScript: z.boolean().optional(),
  link: z.string().optional(),
  break: z.number().optional(),
})

/** Word 表格单元格 schema。 */
export const wordTableCellSchema = z.object({
  text: z.string().optional(),
  runs: z.array(wordTextRunSchema).optional(),
  bold: z.boolean().optional(),
  color: z.string().optional(),
  bgColor: z.string().optional(),
  align: z.enum(['left', 'center', 'right', 'justify']).optional(),
  verticalAlign: z.enum(['top', 'center', 'bottom']).optional(),
  columnSpan: z.number().int().positive().optional(),
  rowSpan: z.number().int().positive().optional(),
})

/** Word 高层排版模板 schema。 */
export const wordDocumentProfileSchema = z.enum(['standard', 'academic-paper', 'thesis'])

/** 论文/报告元数据 schema。 */
export const wordDocumentMetadataSchema = z.object({
  subtitle: z.string().max(200).optional(),
  school: z.string().max(120).optional(),
  department: z.string().max(120).optional(),
  major: z.string().max(120).optional(),
  course: z.string().max(120).optional(),
  className: z.string().max(80).optional(),
  studentId: z.string().max(80).optional(),
  advisor: z.string().max(120).optional(),
  date: z.string().max(80).optional(),
  organization: z.string().max(120).optional(),
})

/** Word 内容块 schema，按 kind 区分标题、段落、列表、表格和分页。 */
export const wordBlockSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('heading'),
    text: z.string().min(1).max(500),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    color: z.string().optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
  }),
  z.object({
    kind: z.literal('paragraph'),
    text: z.string().max(20_000).optional(),
    runs: z.array(wordTextRunSchema).optional(),
    align: z.enum(['left', 'center', 'right', 'justify']).optional(),
    spaceBefore: z.number().optional(),
    spaceAfter: z.number().optional(),
    indent: z.number().optional(),
  }),
  z.object({
    kind: z.literal('bullets'),
    items: z
      .array(
        z.union([
          z.string().min(1).max(1000),
          z.object({
            text: z.string(),
            runs: z.array(wordTextRunSchema).optional(),
            level: z.number().int().min(0).max(8).optional(),
          }),
        ])
      )
      .min(1)
      .max(200),
  }),
  z.object({
    kind: z.literal('table'),
    rows: z.array(z.array(wordTableCellSchema).min(1).max(30)).min(1).max(500),
    header: z.boolean().optional(),
    headerBgColor: z.string().optional(),
    borderColor: z.string().optional(),
    widthPct: z.number().min(10).max(100).optional(),
  }),
  z.object({ kind: z.literal('pageBreak') }),
])

/** 支持结构化 blocks 或直接传 Markdown/纯文本字符串。 */
export const wordBlocksInputSchema = z
  .union([
    z.array(wordBlockSchema).min(1).max(500),
    z
      .string()
      .min(1)
      .max(1_000_000)
      .describe(
        parameterDescription({
          description: '大段 Markdown 或纯文本内容。',
          notes: ['工具会自动转为 Word 段落、标题和列表。'],
        })
      ),
  ])
  .describe(
    parameterDescription({
      description: 'Word 内容块输入。',
      values: [
        '结构化 blocks 数组：完整控制段落、标题、表格和分页。',
        '字符串：按 Markdown 或纯文本自动生成内容块。',
      ],
    })
  )

/** office:create_word_document 完整输入 schema。 */
export const createWordDocumentSchema = z
  .object({
    cwd: z.string().optional(),
    outputPath: outputPathSchema,
    title: z.string().min(1).max(200).optional(),
    author: z.string().min(1).max(120).optional(),
    profile: wordDocumentProfileSchema.optional().describe(
      parameterDescription({
        description: '文档排版模板。',
        values: [
          'standard：普通文档。',
          'academic-paper：学术论文。',
          'thesis：论文/毕业论文。',
        ],
      })
    ),
    language: z
      .enum(['zh-CN', 'en-US'])
      .optional()
      .describe(
        parameterDescription({
          description: '文档语言。',
          values: ['zh-CN：中文。', 'en-US：英文。'],
        })
      ),
    metadata: wordDocumentMetadataSchema.optional(),
    abstract: z.string().max(20_000).optional(),
    keywords: z.array(z.string().min(1).max(80)).max(30).optional(),
    includeTableOfContents: z.boolean().optional(),
    blocks: wordBlocksInputSchema.optional(),
    content: z
      .string()
      .min(1)
      .max(1_000_000)
      .optional()
      .describe(
        parameterDescription({
          description: '大段 Markdown 或纯文本内容。',
          usage: ['不需要精细结构化 blocks 时使用。'],
        })
      ),
    overwrite: z.boolean().optional(),
    appendMode: z.boolean().optional(),
  })
  .refine((input) => isPresent(input.blocks) || isNonBlankString(input.content), {
    path: ['blocks'],
    message: 'blocks 或 content 至少提供一个。',
  })

export const createWordDocumentPresetSchema = z.object({
  outputPath: outputPathSchema,
  title: z.string().min(1).max(200).optional(),
  content: z
    .string()
    .min(1)
    .max(1_000_000)
    .describe(
      parameterDescription({
        description: 'Markdown 或纯文本正文。',
        notes: ['工具会自动转为标题、段落、列表和表格。'],
      })
    ),
  overwrite: z.boolean().optional(),
})

export type CreateWordDocumentPresetInput = z.infer<typeof createWordDocumentPresetSchema>

export function normalizeCreateWordDocumentPreset(
  input: CreateWordDocumentPresetInput
): CreateWordDocumentInput {
  return {
    outputPath: input.outputPath,
    title: input.title,
    content: input.content,
    overwrite: input.overwrite,
  }
}

export const createWordDocumentGuidedSchema = z.object({
  cwd: z.string().optional(),
  outputPath: outputPathSchema,
  title: z.string().min(1).max(200).optional(),
  author: z.string().min(1).max(120).optional(),
  profile: wordDocumentProfileSchema.optional().describe(
    parameterDescription({
      description: '文档排版模板。',
      values: [
        'standard：普通文档。',
        'academic-paper：学术论文。',
        'thesis：论文/毕业论文。',
      ],
    })
  ),
  language: z
    .enum(['zh-CN', 'en-US'])
    .optional()
    .describe(
      parameterDescription({
        description: '文档语言。',
        values: ['zh-CN：中文。', 'en-US：英文。'],
      })
    ),
  metadata: wordDocumentMetadataSchema.optional(),
  abstract: z.string().max(20_000).optional(),
  keywords: z.array(z.string().min(1).max(80)).max(30).optional(),
  includeTableOfContents: z.boolean().optional(),
  content: z
    .string()
    .min(1)
    .max(1_000_000)
    .describe(
      parameterDescription({
        description: 'Markdown 或纯文本正文。',
        notes: ['需要富文本 runs 或表格单元格样式时切到 direct/expert。'],
      })
    ),
  overwrite: z.boolean().optional(),
  appendMode: z.boolean().optional(),
})

export type CreateWordDocumentGuidedInput = z.infer<typeof createWordDocumentGuidedSchema>

export function normalizeCreateWordDocumentGuided(
  input: CreateWordDocumentGuidedInput
): CreateWordDocumentInput {
  return {
    ...input,
    content: input.content,
  }
}

// ─── Constants ─────────────────────────────────────────────────────────────────

export const WordPlainParagraphMaxChars = 12_000
export const WordDocumentXmlPath = 'word/document.xml'
export const WordDocumentRelsPath = 'word/_rels/document.xml.rels'
export const WordRelationshipElementRegex =
  /<Relationship\b[^>]*\bId="([^"]+)"[^>]*(?:\/>|>[\s\S]*?<\/Relationship>)/g
export const WordRelationshipIdRegex = /\bId="([^"]+)"/g
export const WordAcademicProfiles = new Set<WordDocumentProfile>(['academic-paper', 'thesis'])

// ─── Content normalization ──────────────────────────────────────────────────────

/** 将工具输入统一转成结构化 WordBlock 列表。 */
export function normalizeWordBlocks(input: CreateWordDocumentInput): WordBlock[] {
  if (isArray(input.blocks)) return input.blocks
  const content = isString(input.blocks) ? input.blocks : input.content
  if (!isString(content)) return []
  return parseWordContentToBlocks(content)
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
    for (const chunk of splitLongWordText(text, WordPlainParagraphMaxChars)) {
      blocks.push({ kind: 'paragraph', text: chunk, align: 'justify', spaceAfter: 160 })
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
  if (trimmed.length > 500) return null
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
  return { text: match[3].trim(), level: Math.min(Math.floor(indent / 2), 8) }
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
  const width = Math.min(Math.max(...rows.map((row) => row.length)), 30)
  // 每行补齐到同一列数，避免 docx 表格行宽不一致。
  return {
    block: {
      kind: 'table',
      header: true,
      widthPct: 100,
      rows: rows
        .slice(0, 500)
        .map((row) => Array.from({ length: width }, (_, ci) => ({ text: row[ci] ?? '' }))),
    },
    nextIndex,
  }
}

// ─── DOM builders ───────────────────────────────────────────────────────────────

/** 将 WordTextRun 转成 docx TextRun 或 ExternalHyperlink。 */
export function buildTextRun(run: WordTextRun): TextRun | ExternalHyperlink {
  const opts: IRunOptions = {
    text: run.text,
    bold: run.bold,
    italics: run.italic,
    strike: run.strike,
    color: run.color,
    highlight: run.highlight,
    size: run.fontSize,
    font: optionalWhenLazy(run.font, () => ({ name: run.font! })),
    superScript: run.superScript,
    subScript: run.subScript,
    break: run.break,
  }
  const runOpts: IRunOptions = run.underline
    ? { ...opts, underline: { type: UnderlineType.SINGLE } }
    : opts
  // 链接必须包成 ExternalHyperlink，普通 TextRun 的 style 只负责显示样式。
  if (run.link)
    return new ExternalHyperlink({
      link: run.link,
      children: [new TextRun({ ...runOpts, style: 'Hyperlink' })],
    })
  return new TextRun(runOpts)
}

/** 构建段落 children；优先使用 rich runs，退回普通文本。 */
export function buildParagraphChildren(
  text?: string,
  runs?: WordTextRun[]
): Array<TextRun | ExternalHyperlink> {
  if (!!runs && !isEmpty(runs)) return runs.map(buildTextRun)
  if (text) return [new TextRun({ text })]
  return [new TextRun({ text: '' })]
}

/** 将工具层 align 字符串映射到 docx AlignmentType。 */
export function alignToDocx(align?: string) {
  if (!align) return undefined
  const map: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
    left: AlignmentType.LEFT,
    center: AlignmentType.CENTER,
    right: AlignmentType.RIGHT,
    justify: AlignmentType.BOTH,
  }
  return map[align]
}

/** 构建 Word 表格单元格。 */
export function buildWordTableCell(
  cell: WordTableCellInput,
  isHeader: boolean,
  headerBgColor?: string
): TableCell {
  const cellOpts: ITableCellOptions = {
    children: [
      new Paragraph({
        alignment: alignToDocx(cell.align),
        children:
          !!cell.runs && !isEmpty(cell.runs)
            ? cell.runs.map(buildTextRun)
            : [
                new TextRun({
                  text: cell.text ?? '',
                  bold: cell.bold ?? isHeader,
                  color: cell.color,
                }),
              ],
      }),
    ],
    columnSpan: cell.columnSpan,
    rowSpan: cell.rowSpan,
    verticalAlign:
      cell.verticalAlign === 'top'
        ? VerticalAlign.TOP
        : cell.verticalAlign === 'bottom'
          ? VerticalAlign.BOTTOM
          : optionalWhen((cell.verticalAlign === 'center'), VerticalAlign.CENTER),
  }
  const bg = cell.bgColor ?? (optionalWhen(isHeader, headerBgColor))
  // 表头可统一设置 headerBgColor，单元格 bgColor 优先级更高。
  return new TableCell({
    ...cellOpts,
    shading: optionalWhenLazy(bg, () => ({ type: ShadingType.SOLID, fill: bg, color: bg })),
  })
}

/** 构建 Word 表格。 */
export function buildWordTable(block: Extract<WordBlock, { kind: 'table' }>): Table {
  const borderColor = block.borderColor ?? 'CBD5E1'
  return new Table({
    width: { size: block.widthPct ?? 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1, color: borderColor },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: borderColor },
      left: { style: BorderStyle.SINGLE, size: 1, color: borderColor },
      right: { style: BorderStyle.SINGLE, size: 1, color: borderColor },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: borderColor },
      insideVertical: { style: BorderStyle.SINGLE, size: 1, color: borderColor },
    },
    rows: block.rows.map(
      (row, ri) =>
        new TableRow({
          children: row.map((cell) =>
            buildWordTableCell(cell, !!(block.header && ri === 0), block.headerBgColor)
          ),
        })
    ),
  })
}

export function buildStandardWordFrontMatter(
  children: FileChild[],
  input: Pick<CreateWordDocumentInput, 'title' | 'author' | 'metadata'>
): void {
  if (input.title) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        heading: HeadingLevel.TITLE,
        spacing: { after: input.metadata?.subtitle ? 120 : 320 },
        children: [new TextRun({ text: input.title, bold: true, size: 36 })],
      })
    )
  }
  if (input.metadata?.subtitle) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 100 },
        children: [new TextRun({ text: input.metadata.subtitle, size: 24, color: '475569' })],
      })
    )
  }
  const details = [input.metadata?.organization, input.author, input.metadata?.date]
    .filter(isNonBlankString)
    .map((value) => value.trim())
  if (!isEmpty(details)) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 320 },
        children: [new TextRun({ text: details.join(' · '), size: 20, color: '64748B' })],
      })
    )
  }
}

/** 将结构化 WordBlock 转成 docx section children。 */
export function buildWordChildren(
  input: Pick<
    CreateWordDocumentInput,
    | 'title'
    | 'author'
    | 'profile'
    | 'language'
    | 'metadata'
    | 'abstract'
    | 'keywords'
    | 'includeTableOfContents'
    | 'blocks'
  >
): FileChild[] {
  const children: FileChild[] = []
  const blocks = isArray(input.blocks) ? input.blocks : []
  if (isAcademicWordProfile(input.profile)) {
    buildAcademicWordFrontMatter(children, input)
  } else {
    // 标题与标准文档元数据只在新建完整文档时传入；append fragment 不重复插入。
    buildStandardWordFrontMatter(children, input)
  }
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        const level =
          block.level === 3
            ? HeadingLevel.HEADING_3
            : block.level === 2
              ? HeadingLevel.HEADING_2
              : HeadingLevel.HEADING_1
        if (block.color) {
          children.push(
            new Paragraph({
              heading: level,
              alignment: alignToDocx(block.align),
              spacing: { before: 120, after: 160 },
              children: [new TextRun({ text: block.text, color: block.color, bold: true })],
            })
          )
        } else {
          children.push(
            new Paragraph({
              text: block.text,
              heading: level,
              alignment: alignToDocx(block.align),
              spacing: { before: 120, after: 160 },
            })
          )
        }
        break
      }
      case 'paragraph': {
        if ((!block.runs || isEmpty(block.runs)) && block.text) {
          // 纯文本段落按换行拆成多个 Word 段落，保留可读排版。
          for (const line of block.text.split(/\r?\n/)) {
            children.push(
              new Paragraph({
                alignment: alignToDocx(block.align),
                spacing: { before: block.spaceBefore, after: block.spaceAfter ?? 160 },
                indent: optionalWhenLazy(block.indent, () => ({ left: block.indent })),
                children: [new TextRun({ text: line })],
              })
            )
          }
        } else {
          children.push(
            new Paragraph({
              alignment: alignToDocx(block.align),
              spacing: { before: block.spaceBefore, after: block.spaceAfter ?? 160 },
              indent: optionalWhenLazy(block.indent, () => ({ left: block.indent })),
              children: buildParagraphChildren(block.text, block.runs),
            })
          )
        }
        break
      }
      case 'bullets': {
        for (const item of block.items) {
          if (isString(item)) {
            children.push(
              new Paragraph({ text: item, bullet: { level: 0 }, spacing: { after: 80 } })
            )
          } else {
            children.push(
              new Paragraph({
                bullet: { level: item.level ?? 0 },
                spacing: { after: 80 },
                children:
                  !!item.runs && !isEmpty(item.runs)
                    ? item.runs.map(buildTextRun)
                    : [new TextRun({ text: item.text })],
              })
            )
          }
        }
        break
      }
      case 'table':
        children.push(buildWordTable(block))
        break
      case 'pageBreak':
        children.push(new Paragraph({ pageBreakBefore: true, text: '' }))
        break
    }
  }
  return children
}

// ─── Academic document helpers ─────────────────────────────────────────────────

export function isAcademicWordProfile(profile?: WordDocumentProfile): boolean {
  return !!profile && WordAcademicProfiles.has(profile)
}

export function shouldIncludeAcademicToc(
  input: Pick<CreateWordDocumentInput, 'profile' | 'includeTableOfContents'>
): boolean {
  return isAcademicWordProfile(input.profile) && (input.includeTableOfContents ?? true)
}

export function getWordLanguage(input: Pick<CreateWordDocumentInput, 'language'>): 'zh-CN' | 'en-US' {
  return input.language ?? 'zh-CN'
}

export interface WordFontFamilies {
  readonly body: string
  readonly heading: string
}

/**
 * Chooses fonts that are actually available on the document producer's OS.
 * The previous SimSun/SimHei defaults are Windows-only and caused headless
 * LibreOffice on macOS/Linux to emit PDFs with corrupt CJK glyph mappings.
 */
export function resolveWordFontFamilies(
  language: 'zh-CN' | 'en-US',
  hostPlatform: NodeJS.Platform = nodePlatform(),
): WordFontFamilies {
  if (language === 'en-US') return { body: 'Times New Roman', heading: 'Aptos Display' }
  if (hostPlatform === 'darwin') return { body: 'Arial Unicode MS', heading: 'Arial Unicode MS' }
  if (hostPlatform === 'win32') return { body: 'Microsoft YaHei', heading: 'Microsoft YaHei' }
  return { body: 'Noto Sans CJK SC', heading: 'Noto Sans CJK SC' }
}

export function buildAcademicWordFrontMatter(
  children: FileChild[],
  input: Pick<
    CreateWordDocumentInput,
    | 'title'
    | 'author'
    | 'profile'
    | 'language'
    | 'metadata'
    | 'abstract'
    | 'keywords'
    | 'includeTableOfContents'
  >
): void {
  const language = getWordLanguage(input)
  const fonts = resolveWordFontFamilies(language)
  const labels =
    language === 'en-US'
      ? {
          toc: 'Contents',
          abstract: 'Abstract',
          keywords: 'Keywords',
          author: 'Author',
          advisor: 'Advisor',
          school: 'School',
          department: 'Department',
          major: 'Major',
          course: 'Course',
          className: 'Class',
          studentId: 'Student ID',
          date: 'Date',
          organization: 'Organization',
        }
      : {
          toc: '目录',
          abstract: '摘要',
          keywords: '关键词',
          author: '作者',
          advisor: '指导教师',
          school: '学校',
          department: '院系',
          major: '专业',
          course: '课程',
          className: '班级',
          studentId: '学号',
          date: '日期',
          organization: '单位',
        }
  const metadataRows = buildAcademicMetadataRows(input, labels)
  const hasCoverContent = !!input.title || !!input.metadata?.subtitle || !isEmpty(metadataRows)

  if (input.title) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 1_360, after: 220, line: 360, lineRule: LineRuleType.AUTO },
        children: [
          new TextRun({
            text: input.title,
            bold: true,
            size: language === 'en-US' ? 36 : 40,
            font: { ascii: fonts.heading, hAnsi: fonts.heading, eastAsia: fonts.heading },
          }),
        ],
      })
    )
  }

  if (input.metadata?.subtitle) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 520 },
        children: [
          new TextRun({
            text: input.metadata.subtitle,
            size: 24,
            color: '475569',
          }),
        ],
      })
    )
  }

  for (const row of metadataRows) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 80, after: 80 },
        children: [new TextRun({ text: row, size: 24 })],
      })
    )
  }

  if (
    hasCoverContent &&
    (shouldIncludeAcademicToc(input) ||
      input.abstract ||
      (!!input.keywords && !isEmpty(input.keywords)))
  ) {
    children.push(new Paragraph({ text: '', pageBreakBefore: true }))
  }

  if (shouldIncludeAcademicToc(input)) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 160, after: 240 },
        children: [new TextRun({ text: labels.toc, bold: true, size: 30 })],
      })
    )
    children.push(
      new TableOfContents(labels.toc, {
        hyperlink: true,
        headingStyleRange: '1-3',
        beginDirty: true,
      })
    )
    if (input.abstract || (!!input.keywords && !isEmpty(input.keywords))) {
      children.push(new Paragraph({ text: '', pageBreakBefore: true }))
    }
  }

  if (input.abstract || (!!input.keywords && !isEmpty(input.keywords))) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun({ text: labels.abstract, bold: true, size: 28 })],
      })
    )
    if (input.abstract) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.BOTH,
          spacing: { after: 180, line: 360, lineRule: LineRuleType.AUTO },
          children: [new TextRun({ text: input.abstract, size: 24 })],
        })
      )
    }
    if (!!input.keywords && !isEmpty(input.keywords)) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.BOTH,
          spacing: { after: 260 },
          children: [
            new TextRun({ text: `${labels.keywords}: `, bold: true, size: 24 }),
            new TextRun({
              text: input.keywords.join(language === 'en-US' ? '; ' : '；'),
              size: 24,
            }),
          ],
        })
      )
    }
    children.push(new Paragraph({ text: '', pageBreakBefore: true }))
  }
}

export function buildAcademicMetadataRows(
  input: Pick<CreateWordDocumentInput, 'author' | 'metadata'>,
  labels: Record<string, string>
): string[] {
  const metadata = input.metadata ?? {}
  const pairs: Array<[string, string | undefined]> = [
    [labels.school, metadata.school],
    [labels.organization, metadata.organization],
    [labels.department, metadata.department],
    [labels.major, metadata.major],
    [labels.course, metadata.course],
    [labels.className, metadata.className],
    [labels.studentId, metadata.studentId],
    [labels.author, input.author],
    [labels.advisor, metadata.advisor],
    [labels.date, metadata.date],
  ]

  return pairs
    .filter(([, value]) => isNonBlankString(value))
    .map(([label, value]) => `${label}: ${value?.trim()}`)
}

export function buildAcademicWordStyles(language: 'zh-CN' | 'en-US') {
  const { body: bodyFont, heading: headingFont } = resolveWordFontFamilies(language)

  return {
    default: {
      document: {
        run: { font: { ascii: bodyFont, hAnsi: bodyFont, eastAsia: bodyFont }, size: 24 },
        paragraph: {
          spacing: { after: 160, line: 360, lineRule: LineRuleType.AUTO },
          alignment: AlignmentType.BOTH,
        },
      },
      title: {
        run: { font: { ascii: headingFont, hAnsi: headingFont, eastAsia: headingFont }, size: 40 },
        paragraph: { spacing: { after: 320 }, alignment: AlignmentType.CENTER },
      },
      heading1: {
        run: {
          bold: true,
          size: 30,
          color: '0F172A',
          font: { ascii: headingFont, hAnsi: headingFont, eastAsia: headingFont },
        },
        paragraph: { spacing: { before: 280, after: 180 }, outlineLevel: 0 },
      },
      heading2: {
        run: {
          bold: true,
          size: 26,
          color: '1E293B',
          font: { ascii: headingFont, hAnsi: headingFont, eastAsia: headingFont },
        },
        paragraph: { spacing: { before: 220, after: 140 }, outlineLevel: 1 },
      },
      heading3: {
        run: {
          bold: true,
          size: 24,
          color: '334155',
          font: { ascii: headingFont, hAnsi: headingFont, eastAsia: headingFont },
        },
        paragraph: { spacing: { before: 180, after: 100 }, outlineLevel: 2 },
      },
    },
    paragraphStyles: [
      {
        id: 'Abstract',
        name: 'Abstract',
        basedOn: 'Normal',
        run: { font: { ascii: bodyFont, hAnsi: bodyFont, eastAsia: bodyFont }, size: 22 },
        paragraph: { spacing: { after: 120, line: 320, lineRule: LineRuleType.AUTO } },
      },
      {
        id: 'Bibliography',
        name: 'Bibliography',
        basedOn: 'Normal',
        run: { font: { ascii: bodyFont, hAnsi: bodyFont, eastAsia: bodyFont }, size: 22 },
        paragraph: { spacing: { after: 80 }, indent: { hanging: 360 } },
      },
    ],
  }
}

export function buildStandardWordStyles(language: 'zh-CN' | 'en-US') {
  const { body: bodyFont, heading: headingFont } = resolveWordFontFamilies(language)
  return {
    default: {
      document: {
        run: { font: { ascii: bodyFont, hAnsi: bodyFont, eastAsia: bodyFont }, size: 22 },
        paragraph: {
          spacing: { after: 140, line: 320, lineRule: LineRuleType.AUTO },
        },
      },
      title: {
        run: {
          bold: true,
          size: 36,
          font: { ascii: headingFont, hAnsi: headingFont, eastAsia: headingFont },
        },
        paragraph: { spacing: { after: 320 }, alignment: AlignmentType.CENTER },
      },
      heading1: {
        run: {
          bold: true,
          size: 30,
          color: '0F172A',
          font: { ascii: headingFont, hAnsi: headingFont, eastAsia: headingFont },
        },
        paragraph: { spacing: { before: 260, after: 140 }, outlineLevel: 0 },
      },
      heading2: {
        run: {
          bold: true,
          size: 26,
          color: '1E293B',
          font: { ascii: headingFont, hAnsi: headingFont, eastAsia: headingFont },
        },
        paragraph: { spacing: { before: 220, after: 120 }, outlineLevel: 1 },
      },
      heading3: {
        run: {
          bold: true,
          size: 24,
          color: '334155',
          font: { ascii: headingFont, hAnsi: headingFont, eastAsia: headingFont },
        },
        paragraph: { spacing: { before: 180, after: 100 }, outlineLevel: 2 },
      },
    },
  }
}

export function buildAcademicWordFooter(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            children: [PageNumber.CURRENT],
            size: 18,
            color: '64748B',
          }),
        ],
      }),
    ],
  })
}

export function buildWordDocument(
  input: Pick<
    CreateWordDocumentInput,
    | 'title'
    | 'author'
    | 'profile'
    | 'language'
    | 'metadata'
    | 'abstract'
    | 'keywords'
    | 'includeTableOfContents'
    | 'blocks'
  >
): Document {
  const language = getWordLanguage(input)
  const isAcademic = isAcademicWordProfile(input.profile)

  return new Document({
    title: input.title,
    creator: input.author ?? 'VelarOS',
    keywords: input.keywords?.join(', '),
    description: input.abstract,
    features: optionalWhenLazy(shouldIncludeAcademicToc(input), () => ({ updateFields: true })),
    styles: isAcademic
      ? buildAcademicWordStyles(language)
      : buildStandardWordStyles(language),
    sections: [
      {
        properties: optionalWhenLazy(isAcademic, () => ({
              page: {
                margin: {
                  top: 1_440,
                  right: 1_440,
                  bottom: 1_440,
                  left: 1_800,
                  header: 720,
                  footer: 720,
                },
              },
            })),
        footers: optionalWhenLazy(isAcademic, () => ({ default: buildAcademicWordFooter() })),
        children: buildWordChildren(input),
      },
    ],
  })
}

// ─── Output path & append helpers ──────────────────────────────────────────────

/** 准备 Word 输出路径；appendMode 可在已有 docx 后追加内容。 */
export async function prepareWordDocumentOutputPath(
  ctx: OfficeToolContext,
  input: Pick<CreateWordDocumentInput, 'outputPath' | 'overwrite' | 'appendMode'>
): Promise<{ path: string; created: boolean; append: boolean }> {
  const resolvedPath = normalizeExtensionPath(
    ctx.office.project.getRootPath(),
    input.outputPath,
    '.docx'
  )
  const existing = await getFileStats(resolvedPath)
  if (existing && !existing.isFile())
    throw new AppError('VALIDATION', `目标路径不是文件：${input.outputPath}`)
  await mkdir(dirname(resolvedPath), { recursive: true })
  // appendMode 只在目标文件已存在时生效。
  if (input.appendMode && existing) return { path: resolvedPath, created: false, append: true }
  if (existing && !input.overwrite)
    throw new AppError(
      'VALIDATION',
      `文件已存在，覆盖写入需要显式设置 overwrite=true：${input.outputPath}`
    )
  return { path: resolvedPath, created: !existing, append: false }
}

/** 将 fragment docx 的 body 内容追加到已有 docx。 */
export async function appendWordDocumentBuffer(
  prepared: { path: string; created: boolean },
  fragmentBuffer: Buffer
): Promise<OfficeOutput> {
  const existingZip = await JSZip.loadAsync(await readFile(prepared.path))
  const fragmentZip = await JSZip.loadAsync(fragmentBuffer)
  const existingDocumentFile = existingZip.file(WordDocumentXmlPath)
  const fragmentDocumentFile = fragmentZip.file(WordDocumentXmlPath)
  if (!existingDocumentFile || !fragmentDocumentFile)
    throw new AppError('VALIDATION', '目标 Word 文档缺少 word/document.xml，无法追加内容。')

  const existingDocumentXml = await existingDocumentFile.async('string')
  const fragmentDocumentXml = await fragmentDocumentFile.async('string')
  let fragmentChildrenXml = extractWordBodyChildrenXml(fragmentDocumentXml).trim()
  if (!fragmentChildrenXml) throw new AppError('VALIDATION', '追加内容为空，未写入 Word 文档。')

  // 追加超链接/媒体时要合并 relationship，并重写 fragment 中的 rId。
  const existingRelsFile = existingZip.file(WordDocumentRelsPath)
  const fragmentRelsFile = fragmentZip.file(WordDocumentRelsPath)
  const existingRelsXml = existingRelsFile
    ? await existingRelsFile.async('string')
    : createEmptyWordDocumentRelsXml()
  const fragmentRelsXml = fragmentRelsFile ? await fragmentRelsFile.async('string') : null
  const mergedRels = mergeWordDocumentRelationships(
    existingRelsXml,
    fragmentRelsXml,
    fragmentChildrenXml
  )
  fragmentChildrenXml = mergedRels.fragmentChildrenXml

  existingZip.file(
    WordDocumentXmlPath,
    insertWordBodyChildrenXml(existingDocumentXml, fragmentChildrenXml)
  )
  existingZip.file(WordDocumentRelsPath, mergedRels.relationshipsXml)
  const mergedBuffer = await existingZip.generateAsync({ type: 'nodebuffer' })
  return writeOfficeBuffer(prepared, mergedBuffer, 'docx')
}

/**
 * ── OOXML 追加写的四条不变量（§5.3b ①算法与协议）──────────────────────────────
 *
 * 追加模式不重排版整篇文档，而是**把新片段的 XML 直接缝进已有 .docx 的 zip 里**。这么做的原因是
 * 读回再重排会丢掉原文档里 docx 库不认识的一切（样式、编号、页眉页脚、批注）。代价是必须自己
 * 守住 OOXML 的四条结构约束——下面每个 helper 各守一条，改任意一处前先确认还成立：
 *
 * 1. **`w:sectPr` 必须留在 body 末尾**。它是整节的排版设置（纸张、页边距、页眉引用）；
 *    被复制到中间或被新内容挤到后面，Word 会判定文档损坏或分节错乱。故取片段时剔除它
 *    （`extractWordBodyChildrenXml`），插入时插到它**之前**（`insertWordBodyChildrenXml`）。
 * 2. **relationship id 是每文档局部的**。片段里的 `rId3` 与原文档的 `rId3` 毫不相干，
 *    直接合并会让超链接指向错误目标、图片错位。故 `mergeWordDocumentRelationships` 逐条重发号
 *    （`rIdAppendN`，同时避开已有的 `rIdN`）并同步改写片段正文里的 `r:id/r:embed/r:link`。
 * 3. **只合并被真正引用的 relationship**（`wordChildrenReferenceRelationship`）。docx 库会给片段
 *    带一堆默认关系，全并进去会在原文档里留下悬空条目。
 * 4. **结构不完整一律拒绝，不"尽力而为"**：找不到 `w:body`、`w:sectPr` 不闭合、`</Relationships>`
 *    缺失，全部抛 VALIDATION。这里的失败方向必须是"不写"——半写成功的 .docx 打不开，
 *    而用户的原文档已经被覆盖（§2.4 最坏失败模式决定设计）。
 */

/** 提取 document.xml body 中除 sectPr 外的内容。 */
export function extractWordBodyChildrenXml(documentXml: string): string {
  const body = findWordBodyRange(documentXml)
  const bodyInner = documentXml.slice(body.openEnd, body.closeStart)
  const sectPr = findWordSectPrRange(bodyInner)
  if (!sectPr) return bodyInner
  return `${bodyInner.slice(0, sectPr.start)}${bodyInner.slice(sectPr.end)}`
}

/** 将新的 children XML 插入到 body 末尾、sectPr 之前。 */
export function insertWordBodyChildrenXml(documentXml: string, childrenXml: string): string {
  const body = findWordBodyRange(documentXml)
  const bodyInner = documentXml.slice(body.openEnd, body.closeStart)
  const sectPr = findWordSectPrRange(bodyInner)
  const insertOffset = body.openEnd + (sectPr?.start ?? bodyInner.length)
  return `${documentXml.slice(0, insertOffset)}${childrenXml}${documentXml.slice(insertOffset)}`
}

/** 定位 Word document.xml 中 w:body 的内层范围。 */
export function findWordBodyRange(documentXml: string): { openEnd: number; closeStart: number } {
  const bodyOpen = /<w:body(?:\s[^>]*)?>/.exec(documentXml)
  const bodyCloseStart = documentXml.lastIndexOf('</w:body>')
  if (!bodyOpen || bodyOpen.index < 0 || bodyCloseStart < 0)
    throw new AppError('VALIDATION', 'Word 文档 XML 缺少 w:body，无法追加内容。')
  return { openEnd: bodyOpen.index + bodyOpen[0].length, closeStart: bodyCloseStart }
}

/** 定位 w:sectPr 范围；追加内容时不能把它复制到中间。 */
export function findWordSectPrRange(bodyInnerXml: string): Nullable<{ start: number; end: number }> {
  const start = bodyInnerXml.lastIndexOf('<w:sectPr')
  if (start < 0) return null
  const openEnd = bodyInnerXml.indexOf('>', start)
  if (openEnd < 0) throw new AppError('VALIDATION', 'Word 文档 XML 中 w:sectPr 结构不完整。')
  if (bodyInnerXml[openEnd - 1] === '/') return { start, end: openEnd + 1 }
  const closeTag = '</w:sectPr>'
  const closeStart = bodyInnerXml.indexOf(closeTag, openEnd)
  if (closeStart < 0) throw new AppError('VALIDATION', 'Word 文档 XML 中 w:sectPr 缺少结束标签。')
  return { start, end: closeStart + closeTag.length }
}

/** 合并 fragment relationships，并重写 fragment children 中引用的 rId。 */
export function mergeWordDocumentRelationships(
  existingRelsXml: string,
  fragmentRelsXml: Nullable<string>,
  fragmentChildrenXml: string
): { relationshipsXml: string; fragmentChildrenXml: string } {
  if (!fragmentRelsXml) return { relationshipsXml: existingRelsXml, fragmentChildrenXml }
  const existingIds = collectWordRelationshipIds(existingRelsXml)
  const additions: string[] = []
  let remappedChildrenXml = fragmentChildrenXml
  for (const match of fragmentRelsXml.matchAll(WordRelationshipElementRegex)) {
    const oldId = match[1]
    const relationshipXml = match[0]
    // 只合并 fragment body 实际引用到的 relationship。
    if (!oldId || !wordChildrenReferenceRelationship(remappedChildrenXml, oldId)) continue
    const newId = createUniqueWordRelationshipId(existingIds)
    additions.push(replaceWordRelationshipElementId(relationshipXml, oldId, newId))
    remappedChildrenXml = replaceWordChildRelationshipReferences(remappedChildrenXml, oldId, newId)
  }
  if (isEmpty(additions))
    return { relationshipsXml: existingRelsXml, fragmentChildrenXml: remappedChildrenXml }
  const closeIndex = existingRelsXml.lastIndexOf('</Relationships>')
  if (closeIndex < 0)
    throw new AppError('VALIDATION', 'Word 文档关系文件结构不完整，无法追加链接或媒体关系。')
  return {
    relationshipsXml: `${existingRelsXml.slice(0, closeIndex)}${additions.join('')}${existingRelsXml.slice(closeIndex)}`,
    fragmentChildrenXml: remappedChildrenXml,
  }
}

/** 收集现有 relationship id，用于生成不冲突的新 id。 */
export function collectWordRelationshipIds(relsXml: string): Set<string> {
  const ids = new Set<string>()
  for (const match of relsXml.matchAll(WordRelationshipIdRegex)) {
    if (match[1]) ids.add(match[1])
  }
  return ids
}

/** 判断 body children 是否引用指定 relationship。 */
export function wordChildrenReferenceRelationship(childrenXml: string, relationshipId: string): boolean {
  return new RegExp(`\\br:(?:id|embed|link)=["']${escapeRegExp(relationshipId)}["']`).test(
    childrenXml
  )
}

/** 替换 Relationship 元素本身的 Id。 */
export function replaceWordRelationshipElementId(
  relationshipXml: string,
  oldId: string,
  newId: string
): string {
  return relationshipXml.replace(new RegExp(`\\bId="${escapeRegExp(oldId)}"`), `Id="${newId}"`)
}

/** 替换 body children 中的 r:id/r:embed/r:link 引用。 */
export function replaceWordChildRelationshipReferences(
  childrenXml: string,
  oldId: string,
  newId: string
): string {
  return childrenXml.replace(
    new RegExp(`(\\br:(?:id|embed|link)=["'])${escapeRegExp(oldId)}(["'])`, 'g'),
    `$1${newId}$2`
  )
}

/** 创建不会与已有 rId 冲突的新 relationship id。 */
export function createUniqueWordRelationshipId(existingIds: Set<string>): string {
  let index = 1
  while (existingIds.has(`rIdAppend${index}`) || existingIds.has(`rId${index}`)) index += 1
  const id = `rIdAppend${index}`
  existingIds.add(id)
  return id
}

/** 没有 relationships 文件时创建最小空关系 XML。 */
export function createEmptyWordDocumentRelsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '</Relationships>',
  ].join('')
}

/** 正则转义。 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
