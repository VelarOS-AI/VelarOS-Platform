/**
 * 十个 office 工具的入参形状。手写在这里、schema 用 `satisfies`/断言对齐：
 * 执行类的签名读的是这些类型，schema 只负责在 wire 面校验。
 */

import type { LatexCompiler, PdfMetadataInput, PdfTextStampInput } from './pdf.js'
import type { PptxTheme, PresentationSlideInput, PresentationTemplate } from './presentation.js'
import type { SpreadsheetSheetInput } from './spreadsheet.js'
import type { WordBlock, WordDocumentLanguage, WordDocumentMetadata, WordDocumentProfile } from './word.js'

/** office:create_word_document 的入参。 */
export type CreateWordDocumentInput = {
  cwd?: string
  outputPath: string
  title?: string
  author?: string
  profile?: WordDocumentProfile
  language?: WordDocumentLanguage
  metadata?: WordDocumentMetadata
  abstract?: string
  keywords?: string[]
  includeTableOfContents?: boolean
  blocks?: WordBlock[] | string
  content?: string
  overwrite?: boolean
  appendMode?: boolean
}

/** office:create_presentation 的入参。 */
export type CreatePresentationInput = {
  cwd?: string
  outputPath: string
  title?: string
  author?: string
  layout?: 'LAYOUT_4x3' | 'LAYOUT_16x9' | 'LAYOUT_16x10' | 'LAYOUT_WIDE'
  rtlMode?: boolean
  template?: PresentationTemplate
  theme?: PptxTheme
  slides?: PresentationSlideInput[] | string
  content?: string
  overwrite?: boolean
}

/** office:create_spreadsheet 的入参。 */
export type CreateSpreadsheetInput = {
  cwd?: string
  outputPath: string
  title?: string
  author?: string
  sheets?: SpreadsheetSheetInput[] | string
  content?: string
  overwrite?: boolean
}

/** office:extract_pdf_text 的入参；页码用从 1 开始的编号，pages 与 maxPages 互斥。 */
export type ExtractPdfTextInput = {
  cwd?: string
  inputPath: string
  pages?: number[]
  maxPages?: number
}

/** office:convert_pdf_to_word 的入参。 */
export type ConvertPdfToWordInput = {
  cwd?: string
  inputPath: string
  outputPath: string
  title?: string
  author?: string
  maxPages?: number
  overwrite?: boolean
}

/** office:convert_word_to_pdf 的入参；转换依赖本机 LibreOffice。 */
export type ConvertWordToPdfInput = {
  cwd?: string
  inputPath: string
  outputPath: string
  overwrite?: boolean
}

/** office:create_latex_pdf 的入参；源码会先落盘为 .tex，再调用系统编译器。 */
export type CreateLatexPdfInput = {
  cwd?: string
  outputPath: string
  sourcePath?: string
  latexSource: string
  compiler?: LatexCompiler
  runs?: number
  overwrite?: boolean
}

/** office:edit_pdf_document 的入参：选页、删页、旋转、文字戳和元数据。 */
export type EditPdfDocumentInput = {
  cwd?: string
  inputPath: string
  outputPath: string
  overwrite?: boolean
  pageSelection?: number[]
  removePages?: number[]
  rotatePages?: Array<{ page: number; degrees: 90 | 180 | 270 }>
  textStamps?: PdfTextStampInput[]
  metadata?: PdfMetadataInput
}

/** office:preview_document 的入参。 */
export type PreviewOfficeDocumentInput = {
  cwd?: string
  inputPath: string
  outputPath?: string
  overwrite?: boolean
  maxItems?: number
  autoRefresh?: boolean
}

/** office:convert_document_to_markdown 的入参。 */
export type ConvertDocumentToMarkdownInput = {
  cwd?: string
  inputPath: string
  outputPath?: string
  overwrite?: boolean
  maxChars?: number
}
