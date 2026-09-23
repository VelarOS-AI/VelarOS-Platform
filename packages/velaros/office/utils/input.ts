/**
 * `velaros:office` 九个操作的入参核对：形状、取值与上限在做事之前一次核对完，不合法当场 `VALIDATION`，空间端口一次都不调。
 * 上限都引 `contract/constants.ts` 的表——声明里写给模型的数字就是它们。顶层入参是严格对象：多给的字段（比如 cwd）直接拒绝，不静默丢掉。
 */

import { z } from 'zod'

import { isNonBlankString, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  OfficeInputLimits,
  OfficeMarkdownLimits,
  OfficePdfLimits,
  OfficePreviewLimits,
} from '../contract/constants.js'
import type {
  OfficeEditPdfInput,
  OfficeLatexInput,
  OfficeMarkdownInput,
  OfficePresentationInput,
  OfficePreviewInput,
  OfficeReadPdfInput,
  OfficeSpreadsheetInput,
  OfficeWordInput,
  OfficeWordToPdfInput,
} from '../types/office.js'

import { spreadsheetSheetArraySchema } from './spreadsheet/content.js'
import { OfficeTuning } from './tuning.js'

// ── 共用片段 ────────────────────────────────────────────────────

const pathSchema = z.string().trim().min(1).max(OfficeInputLimits.pathChars)
const titleSchema = z.string().min(1).max(OfficeInputLimits.titleChars)
const authorSchema = z.string().min(1).max(OfficeInputLimits.shortFieldChars)
const textSchema = z.string().min(1).max(OfficeInputLimits.textChars)
const keywordsSchema = z
  .array(z.string().min(1).max(OfficeInputLimits.tinyFieldChars))
  .max(OfficeInputLimits.keywords)
const pageNumberSchema = z.number().int().positive()

// ── Word ────────────────────────────────────────────────────────

const wordHighlightSchema = z.enum([
  'yellow',
  'green',
  'cyan',
  'magenta',
  'blue',
  'red',
  'darkBlue',
  'darkCyan',
  'darkGreen',
  'darkMagenta',
  'darkRed',
  'darkYellow',
  'darkGray',
  'lightGray',
  'black',
])

const wordTextRunSchema = z.object({
  text: z.string(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strike: z.boolean().optional(),
  color: z.string().optional(),
  highlight: wordHighlightSchema.optional(),
  fontSize: z.number().positive().optional(),
  font: z.string().optional(),
  superScript: z.boolean().optional(),
  subScript: z.boolean().optional(),
  link: z.string().optional(),
  break: z.number().int().min(0).optional(),
})

const wordTableCellSchema = z.object({
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

const wordBlockSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('heading'),
    text: z.string().min(1).max(OfficeInputLimits.word.headingChars),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    color: z.string().optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
  }),
  z.object({
    kind: z.literal('paragraph'),
    text: z.string().max(OfficeInputLimits.word.paragraphChars).optional(),
    runs: z.array(wordTextRunSchema).optional(),
    align: z.enum(['left', 'center', 'right', 'justify']).optional(),
    spaceBefore: z.number().min(0).optional(),
    spaceAfter: z.number().min(0).optional(),
    indent: z.number().min(0).optional(),
  }),
  z.object({
    kind: z.literal('bullets'),
    items: z
      .array(
        z.union([
          z.string().min(1).max(OfficeInputLimits.word.bulletChars),
          z.object({
            text: z.string().max(OfficeInputLimits.word.bulletChars),
            runs: z.array(wordTextRunSchema).optional(),
            level: z.number().int().min(0).max(OfficeInputLimits.word.bulletLevel).optional(),
          }),
        ])
      )
      .min(1)
      .max(OfficeInputLimits.word.bulletItems),
  }),
  z.object({
    kind: z.literal('table'),
    rows: z
      .array(z.array(wordTableCellSchema).min(1).max(OfficeInputLimits.word.tableColumns))
      .min(1)
      .max(OfficeInputLimits.word.tableRows),
    header: z.boolean().optional(),
    headerBgColor: z.string().optional(),
    borderColor: z.string().optional(),
    widthPct: z
      .number()
      .min(OfficeInputLimits.word.minWidthPercent)
      .max(OfficeInputLimits.word.maxWidthPercent)
      .optional(),
  }),
  z.object({ kind: z.literal('pageBreak') }),
])

const wordMetadataSchema = z.object({
  subtitle: z.string().max(OfficeInputLimits.titleChars).optional(),
  school: z.string().max(OfficeInputLimits.shortFieldChars).optional(),
  department: z.string().max(OfficeInputLimits.shortFieldChars).optional(),
  major: z.string().max(OfficeInputLimits.shortFieldChars).optional(),
  course: z.string().max(OfficeInputLimits.shortFieldChars).optional(),
  className: z.string().max(OfficeInputLimits.tinyFieldChars).optional(),
  studentId: z.string().max(OfficeInputLimits.tinyFieldChars).optional(),
  advisor: z.string().max(OfficeInputLimits.shortFieldChars).optional(),
  date: z.string().max(OfficeInputLimits.tinyFieldChars).optional(),
  organization: z.string().max(OfficeInputLimits.shortFieldChars).optional(),
})

const wordInputSchema = z
  .strictObject({
    outputPath: pathSchema,
    content: textSchema.optional(),
    blocks: z.array(wordBlockSchema).min(1).max(OfficeInputLimits.word.blocks).optional(),
    title: titleSchema.optional(),
    author: authorSchema.optional(),
    profile: z.enum(['standard', 'academic-paper', 'thesis']).optional(),
    language: z.enum(['zh-CN', 'en-US']).optional(),
    metadata: wordMetadataSchema.optional(),
    abstract: z.string().max(OfficeInputLimits.word.abstractChars).optional(),
    keywords: keywordsSchema.optional(),
    includeTableOfContents: z.boolean().optional(),
    overwrite: z.boolean().optional(),
    appendMode: z.boolean().optional(),
  })
  .refine((input) => exactlyOne(input.content, input.blocks), {
    path: ['content'],
    message: '正文给 content（Markdown 或纯文本）或 blocks（内容块），只给一样',
  })

// ── PowerPoint ──────────────────────────────────────────────────

const pptOptionsSchema = z.record(z.string(), z.unknown())
const pptBoxShape = {
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  options: pptOptionsSchema.optional(),
}

const pptElementSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    value: z.union([
      z.string(),
      z.array(z.object({ text: z.string(), options: pptOptionsSchema.optional() })),
    ]),
    ...pptBoxShape,
  }),
  z.object({
    kind: z.literal('table'),
    rows: z
      .array(
        z.array(
          z.union([
            z.string(),
            z.number(),
            z.object({ text: z.string(), options: pptOptionsSchema.optional() }),
          ])
        )
      )
      .min(1),
    ...pptBoxShape,
  }),
  z.object({ kind: z.literal('shape'), shape: z.string().min(1), ...pptBoxShape }),
  z.object({
    kind: z.literal('image'),
    data: z.string().min(1),
    type: z.enum(['png', 'jpeg', 'gif', 'svg', 'bmp', 'webp']).optional(),
    ...pptBoxShape,
  }),
  z.object({
    kind: z.literal('chart'),
    chartType: z.string().min(1),
    data: z.array(z.record(z.string(), z.unknown())).min(1),
    ...pptBoxShape,
  }),
])

const presentationInputSchema = z
  .strictObject({
    outputPath: pathSchema,
    content: textSchema.optional(),
    slides: z
      .array(
        z.object({
          background: z
            .object({
              color: z.string().optional(),
              path: z.string().optional(),
              data: z.string().optional(),
            })
            .optional(),
          elements: z.array(pptElementSchema).max(OfficeInputLimits.presentation.elements),
          notes: z.string().optional(),
        })
      )
      .min(1)
      .max(OfficeInputLimits.presentation.slides)
      .optional(),
    template: z.enum(['modern', 'consulting', 'academic', 'minimal']).optional(),
    layout: z.enum(['LAYOUT_4x3', 'LAYOUT_16x9', 'LAYOUT_16x10', 'LAYOUT_WIDE']).optional(),
    theme: z
      .object({ headFontFace: z.string().optional(), bodyFontFace: z.string().optional() })
      .optional(),
    title: titleSchema.optional(),
    author: authorSchema.optional(),
    rtlMode: z.boolean().optional(),
    overwrite: z.boolean().optional(),
  })
  .refine((input) => exactlyOne(input.content, input.slides), {
    path: ['content'],
    message: '给 content（Markdown 或纯文本，自动拆页）或 slides（结构化页面），只给一样',
  })

// ── Excel ───────────────────────────────────────────────────────

const spreadsheetInputSchema = z
  .strictObject({
    outputPath: pathSchema,
    content: textSchema.optional(),
    sheets: spreadsheetSheetArraySchema.optional(),
    title: titleSchema.optional(),
    author: authorSchema.optional(),
    overwrite: z.boolean().optional(),
  })
  .refine((input) => exactlyOne(input.content, input.sheets), {
    path: ['content'],
    message: '给 content（CSV、TSV、Markdown 表格或 JSON 行）或 sheets（结构化工作表），只给一样',
  })

// ── PDF ─────────────────────────────────────────────────────────

const readPdfInputSchema = z
  .strictObject({
    inputPath: pathSchema,
    pages: z.array(pageNumberSchema).min(1).max(OfficePdfLimits.readPages).optional(),
    maxPages: z.number().int().min(1).max(OfficePdfLimits.readPages).optional(),
  })
  .refine((input) => !(isPresent(input.pages) && isPresent(input.maxPages)), {
    path: ['pages'],
    message: 'pages 与 maxPages 只能给一样',
  })

const wordToPdfInputSchema = z.strictObject({
  inputPath: pathSchema,
  outputPath: pathSchema,
  overwrite: z.boolean().optional(),
})

const latexInputSchema = z.strictObject({
  outputPath: pathSchema,
  latexSource: textSchema,
  sourcePath: pathSchema.optional(),
  compiler: z.enum(['auto', 'tectonic', 'latexmk', 'xelatex', 'pdflatex']).optional(),
  runs: z.number().int().min(1).max(OfficePdfLimits.compileRuns).optional(),
  overwrite: z.boolean().optional(),
})

const pdfTextStampSchema = z.object({
  text: z.string().min(1).max(OfficePdfLimits.textStampChars),
  page: pageNumberSchema.optional(),
  allPages: z.boolean().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  size: z.number().min(OfficePdfLimits.minFontSize).max(OfficePdfLimits.maxFontSize).optional(),
  color: z.string().optional(),
  opacity: z.number().min(0).max(1).optional(),
})

const editPdfInputSchema = z.strictObject({
  inputPath: pathSchema,
  outputPath: pathSchema,
  pageSelection: z.array(pageNumberSchema).min(1).max(OfficePdfLimits.pageList).optional(),
  removePages: z.array(pageNumberSchema).max(OfficePdfLimits.pageList).optional(),
  rotatePages: z
    .array(
      z.object({
        page: pageNumberSchema,
        degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]),
      })
    )
    .max(OfficePdfLimits.pageList)
    .optional(),
  textStamps: z.array(pdfTextStampSchema).max(OfficePdfLimits.textStamps).optional(),
  metadata: z
    .object({
      title: titleSchema.optional(),
      author: authorSchema.optional(),
      subject: z.string().min(1).max(OfficeInputLimits.subjectChars).optional(),
      keywords: keywordsSchema.optional(),
    })
    .optional(),
  overwrite: z.boolean().optional(),
})

// ── 预览与 Markdown ─────────────────────────────────────────────

const previewInputSchema = z.strictObject({
  inputPath: pathSchema,
  maxItems: z.number().int().min(1).max(OfficePreviewLimits.maxItems).optional(),
  outputPath: pathSchema.optional(),
  overwrite: z.boolean().optional(),
  autoRefresh: z.boolean().optional(),
})

const markdownInputSchema = z.strictObject({
  inputPath: pathSchema,
  maxChars: z
    .number()
    .int()
    .min(OfficeMarkdownLimits.minReturnChars)
    .max(OfficeMarkdownLimits.maxReturnChars)
    .optional(),
  outputPath: pathSchema.optional(),
  overwrite: z.boolean().optional(),
})

// ── 核对入口：一个操作一个 ─────────────────────────────────────

/** createWord 的入参。 */
export function wordInput(input: unknown): OfficeWordInput {
  return parseInput(wordInputSchema, input, 'createWord')
}

/** createPresentation 的入参。 */
export function presentationInput(input: unknown): OfficePresentationInput {
  return parseInput(presentationInputSchema, input, 'createPresentation') as OfficePresentationInput
}

/** createSpreadsheet 的入参。 */
export function spreadsheetInput(input: unknown): OfficeSpreadsheetInput {
  return parseInput(spreadsheetInputSchema, input, 'createSpreadsheet') as OfficeSpreadsheetInput
}

/** readPdf 的入参。 */
export function readPdfInput(input: unknown): OfficeReadPdfInput {
  return parseInput(readPdfInputSchema, input, 'readPdf')
}

/** wordToPdf 的入参。 */
export function wordToPdfInput(input: unknown): OfficeWordToPdfInput {
  return parseInput(wordToPdfInputSchema, input, 'wordToPdf')
}

/** latexToPdf 的入参。 */
export function latexInput(input: unknown): OfficeLatexInput {
  return parseInput(latexInputSchema, input, 'latexToPdf')
}

/** editPdf 的入参。 */
export function editPdfInput(input: unknown): OfficeEditPdfInput {
  return parseInput(editPdfInputSchema, input, 'editPdf')
}

/** preview 的入参。 */
export function previewInput(input: unknown): OfficePreviewInput {
  return parseInput(previewInputSchema, input, 'preview')
}

/** toMarkdown 的入参。 */
export function markdownInput(input: unknown): OfficeMarkdownInput {
  return parseInput(markdownInputSchema, input, 'toMarkdown')
}

/** 两样里恰好给了一样：文字要非空白，数组要给了。 */
function exactlyOne(text: Optional<string>, structured: unknown): boolean {
  return isNonBlankString(text) !== isPresent(structured)
}

/** 按 schema 核对一个操作的入参；不合法当场抛 `VALIDATION`，message 点名哪个字段错在哪。 */
function parseInput<T>(schema: z.ZodType<T>, input: unknown, operation: string): T {
  const parsed = schema.safeParse(input)
  if (parsed.success) return parsed.data
  const issues = parsed.error.issues
    .slice(0, OfficeTuning.input.reportedIssues)
    .map((issue) => `${issue.path.join('.') || '入参'}：${issue.message}`)
  throw new AppError('VALIDATION', `${operation} 的入参不对——${issues.join('；')}`)
}
