/**
 * PDF：抽出一页。
 */

import { PDFDocument } from 'pdf-lib'

import { AppError } from '@velaros-ai/core/error'

/** 把 PDF 的第 page 页（从 1 起）抽成一份单页 PDF，返回它的字节和原文件的总页数；打不开或页码越界报错。 */
export async function extractPdfPage(buffer: Buffer, page: number): Promise<{ bytes: Buffer; pageCount: number }> {
  let source: PDFDocument
  try {
    source = await PDFDocument.load(buffer, { ignoreEncryption: true })
  } catch (error) {
    throw new AppError('VALIDATION', 'PDF could not be opened; it may be corrupt or encrypted', error)
  }
  const pageCount = source.getPageCount()
  if (!Number.isInteger(page) || page < 1 || page > pageCount) {
    throw new AppError('VALIDATION', `Page ${page} is out of range; the PDF has ${pageCount} page(s)`)
  }
  const single = await PDFDocument.create()
  const [copied] = await single.copyPages(source, [page - 1])
  if (copied) single.addPage(copied)
  return { bytes: Buffer.from(await single.save()), pageCount }
}
