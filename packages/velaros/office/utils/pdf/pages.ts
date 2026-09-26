/** PDF 页面原语：颜色解析、页码计算、元数据写入，文字戳的字符核对与绘制。逐页取文在 `impl/runtime/PdfjsRuntime.ts`。 */

import { type PDFDocument, type PDFPage, type RGB, rgb } from 'pdf-lib'

import { isEmpty, isUndefined } from '@velaros-ai/core'

import type { PdfMetadataInput, PdfTextStampInput } from '../../types/office.js'
import { officeError } from '../errors.js'
import { OfficeTuning } from '../tuning.js'

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
  if (isEmpty(pages)) throw officeError('VALIDATION', 'PDF 处理后没有剩余页面。')
  return pages
}

/** 将用户传入的标题、作者、主题和关键词写入输出 PDF。 */
export function applyPdfMetadata(document: PDFDocument, metadata?: PdfMetadataInput): void {
  if (!metadata) return
  if (metadata.title) document.setTitle(metadata.title)
  if (metadata.author) document.setAuthor(metadata.author)
  if (metadata.subject) document.setSubject(metadata.subject)
  if (!!metadata.keywords && !isEmpty(metadata.keywords)) document.setKeywords(metadata.keywords)
}

/**
 * 文字戳用的是标准字体 Helvetica，只写得了 WinAnsi（西欧拉丁）字符；supportedCodePoints 是字体自己报的字符集。
 * 有写不了的字就当场 `VALIDATION`，点名是哪一条、哪个字——免得画到一半才炸。换行与制表符由绘制拆行，不算在内。
 */
export function assertTextStampsEncodable(
  stamps: readonly PdfTextStampInput[],
  supportedCodePoints: readonly number[]
): void {
  const supported = new Set(supportedCodePoints)
  for (const [index, stamp] of stamps.entries()) {
    for (const character of stamp.text.replace(/[\n\r\t\f\v]/g, '')) {
      const codePoint = character.codePointAt(0)
      if (isUndefined(codePoint) || supported.has(codePoint)) continue
      throw officeError(
        'VALIDATION',
        `textStamps[${index}].text 里的「${character}」写不进 PDF：文字戳用的是标准字体 Helvetica，只认拉丁字母、数字和常见西文标点，中文等其他文字写不了。`
      )
    }
  }
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
