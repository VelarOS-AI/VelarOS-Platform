/** 把结构化内容块翻译成 docx 对象：文本片段、段落、表格、标准模板样式与整篇文档。 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  type FileChild,
  HeadingLevel,
  type IRunOptions,
  type ITableCellOptions,
  LineRuleType,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  UnderlineType,
  VerticalAlign,
  WidthType,
} from 'docx'

import { isArray, isEmpty, isNonBlankString, isString, optionalWhen, optionalWhenLazy } from '@velaros-ai/core'

import { OfficeInputLimits } from '../../contract/constants.js'
import type { CreateWordDocumentInput } from '../../types/inputs.js'
import type { WordBlock, WordDocumentLanguage, WordTableCellInput, WordTextRun } from '../../types/word.js'
import { OfficeTuning } from '../tuning.js'

import {
  buildAcademicWordFooter,
  buildAcademicWordFrontMatter,
  buildAcademicWordStyles,
  getWordLanguage,
  isAcademicWordProfile,
  shouldIncludeAcademicToc,
} from './academic.js'
import { resolveWordFontFamilies } from './fonts.js'

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
    width: { size: block.widthPct ?? OfficeInputLimits.word.maxWidthPercent, type: WidthType.PERCENTAGE },
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

/** 构建标准文档的抬头：标题、副标题和「单位 · 作者 · 日期」一行。 */
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
                spacing: { before: block.spaceBefore, after: block.spaceAfter ?? OfficeTuning.word.paragraphSpaceAfter },
                indent: optionalWhenLazy(block.indent, () => ({ left: block.indent })),
                children: [new TextRun({ text: line })],
              })
            )
          }
        } else {
          children.push(
            new Paragraph({
              alignment: alignToDocx(block.align),
              spacing: { before: block.spaceBefore, after: block.spaceAfter ?? OfficeTuning.word.paragraphSpaceAfter },
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

/** 标准文档的样式表：正文与三级标题。 */
export function buildStandardWordStyles(language: WordDocumentLanguage) {
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

/** 构建整篇 Word 文档：按 profile 选样式表、页边距与页脚，正文交给 buildWordChildren。 */
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
