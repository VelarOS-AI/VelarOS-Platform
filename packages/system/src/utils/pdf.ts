/**
 * PDF：抽出若干页成一份文档，以及这份文档的文件名。
 */

import { PDFDocument } from 'pdf-lib'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

/** 把 PDF 里这几页（从 1 起，去重后按页码排序）抽成一份文档，返回它的字节、实际抽出的页码和原文件的总页数；打不开、页码越界或超过 maxPages 页报错。 */
export async function extractPdfPages(buffer: Buffer, pages: readonly number[], maxPages: number): Promise<{ bytes: Buffer; pages: number[]; pageCount: number }> {
  let source: PDFDocument
  try {
    source = await PDFDocument.load(buffer, { ignoreEncryption: true })
  } catch (error) {
    throw new AppError('VALIDATION', 'PDF could not be opened; it may be corrupt or encrypted', error)
  }
  const pageCount = source.getPageCount()
  const wanted = [...new Set(pages)].sort((a, b) => a - b)
  const outOfRange = wanted.filter((page) => !Number.isInteger(page) || page < 1 || page > pageCount)
  if (!isEmpty(outOfRange)) {
    throw new AppError('VALIDATION', `Page ${outOfRange.join(', ')} is out of range; the PDF has ${pageCount} page(s)`)
  }
  if (wanted.length > maxPages) {
    throw new AppError('VALIDATION', `At most ${maxPages} pages per view; the PDF has ${pageCount} page(s), ask for fewer pages at a time`)
  }
  const document = await PDFDocument.create()
  const copied = await document.copyPages(source, wanted.map((page) => page - 1))
  for (const page of copied) document.addPage(page)
  return { bytes: Buffer.from(await document.save()), pages: wanted, pageCount }
}

/** 抽出的文档叫什么：`<原名>.p2.pdf`、连续的页 `<原名>.p1-3.pdf`、不连续的页 `<原名>.p1+3+5.pdf`。 */
export function pdfPagesFilename(stem: string, pages: readonly number[]): string {
  if (isEmpty(pages)) return `${stem}.pdf`
  const first = pages[0]!
  const last = pages[pages.length - 1]!
  const contiguous = last - first + 1 === pages.length
  const label = pages.length === 1 ? `${first}` : contiguous ? `${first}-${last}` : pages.join('+')
  return `${stem}.p${label}.pdf`
}
