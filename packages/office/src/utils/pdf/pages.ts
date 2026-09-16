/** PDF 页面原语：颜色解析、页码计算、逐页取文、元数据写入、文字戳绘制。 */

import { readFile } from 'node:fs/promises'

import { type PDFDocument, type PDFPage, type RGB, rgb } from 'pdf-lib'

import { isEmpty, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ExtractedPdfText, ExtractedPdfTextPage, PdfMetadataInput, PdfTextStampInput } from '../../types/pdf.js'
import { OfficeTuning } from '../tuning.js'

import { getPdfjsStandardFontDataUrl, loadPdfjs } from './pdfjs-globals.js'

/** 将 #RRGGBB 文本转换成 pdf-lib 的 RGB；非法颜色回退到默认红色。 */
export function parsePdfColor(input?: string): RGB {
  const hex = (input ?? 'DC2626').replace(/^#/, '').trim()
  const normalized = /^[0-9a-fA-F]{6}$/.test(hex) ? hex : 'DC2626'
  return rgb(
    Number.parseInt(normalized.slice(0, 2), 16) / 255,
    Number.parseInt(normalized.slice(2, 4), 16) / 255,
    Number.parseInt(normalized.slice(4, 6), 16) / 255
  )
}

/** 根据选择页和删除页计算最终保留的源页码，页码保持 1-based 便于用户理解。 */
export function resolvePdfPageNumbers(
  pageCount: number,
  selection?: number[],
  removePages?: number[]
): number[] {
  const removed = new Set(removePages ?? [])
  const rawPages =
    !!selection && !isEmpty(selection)
      ? selection
      : Array.from({ length: pageCount }, (_, index) => index + 1)
  const pages = rawPages.filter((page) => page >= 1 && page <= pageCount && !removed.has(page))
  if (isEmpty(pages)) throw new AppError('VALIDATION', 'PDF 处理后没有剩余页面。')
  return pages
}

/** 使用 pdfjs 逐页提取文本；保留页码，后续转 Word 时用它生成每页标题。 */
export async function extractPdfTextPages(
  path: string,
  options: { pages?: readonly number[]; maxPages?: number } = {}
): Promise<ExtractedPdfText> {
  const pdfjs = await loadPdfjs()
  const bytes = new Uint8Array(await readFile(path))
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    useWorkerFetch: false,
    isEvalSupported: false,
    standardFontDataUrl: getPdfjsStandardFontDataUrl(),
  })
  const document = await loadingTask.promise
  const pageCount = document.numPages
  const requestedPages = options.pages
    ? [...new Set(options.pages)]
    : Array.from(
        { length: Math.min(pageCount, options.maxPages ?? pageCount) },
        (_, index) => index + 1
      )
  const invalidPage = requestedPages.find((pageNumber) => pageNumber < 1 || pageNumber > pageCount)
  if (!isUndefined(invalidPage)) {
    await loadingTask.destroy()
    throw new AppError(
      'VALIDATION',
      `PDF 页码 ${invalidPage} 超出有效范围 1-${pageCount}。`
    )
  }
  const pages: ExtractedPdfTextPage[] = []
  try {
    for (const pageNumber of requestedPages) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      // pdfjs 返回的是文本片段数组，这里压成单行文本，避免 Word 里出现大量碎片空白。
      const text = content.items
        .map((item: { str?: string }) => item.str ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      pages.push({ page: pageNumber, text })
    }
  } finally {
    await loadingTask.destroy()
  }
  return { pageCount, pages }
}

/** 将用户传入的标题、作者、主题和关键词写入输出 PDF。 */
export function applyPdfMetadata(document: PDFDocument, metadata?: PdfMetadataInput): void {
  if (!metadata) return
  if (metadata.title) document.setTitle(metadata.title)
  if (metadata.author) document.setAuthor(metadata.author)
  if (metadata.subject) document.setSubject(metadata.subject)
  if (!!metadata.keywords && !isEmpty(metadata.keywords)) document.setKeywords(metadata.keywords)
}

/** 在指定页面绘制一段文字戳，默认放在页面左下角附近。 */
export function applyPdfTextStamp(args: {
  page: PDFPage
  stamp: PdfTextStampInput
  font: Awaited<ReturnType<PDFDocument['embedFont']>>
}): void {
  const size = args.stamp.size ?? OfficeTuning.pdf.textStampFontSize
  args.page.drawText(args.stamp.text, {
    x: args.stamp.x ?? OfficeTuning.pdf.textStampX,
    y: args.stamp.y ?? OfficeTuning.pdf.textStampY,
    size,
    font: args.font,
    color: parsePdfColor(args.stamp.color),
    opacity: args.stamp.opacity ?? OfficeTuning.pdf.textStampOpacity,
  })
}
