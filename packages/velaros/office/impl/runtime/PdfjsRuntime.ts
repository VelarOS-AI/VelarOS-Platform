/**
 * pdfjs 运行时：`PdfjsRuntime` 与整个进程唯一的 `pdfjsRuntime`。接口 `PdfjsRuntimeApi` 在本文件的类上方。
 * 静态导入的 pdfjs 模块由 ESM 复用，每次取用先补齐它在 Node 里要用的浏览器图形全局。
 */

import { readFile } from 'node:fs/promises'

import { isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { OfficeErrorCodes } from '../../contract/constants.js'
import type { OfficePdfPage } from '../../types/office.js'
import type { ExtractedPdfText, PdfjsModule } from '../../types/pdf.js'
import { getPdfjsStandardFontDataUrl, loadPdfjs } from '../../utils/pdf/pdfjs-globals.js'

/**
 * pdfjs 运行时：进程里只此一份。谁要用 pdfjs 都经它拿，免得各处各自补一遍 Node 图形全局、
 * 各自算一遍标准字体目录。实例是 `pdfjsRuntime`。
 */
export interface PdfjsRuntimeApi {
  /** 拿到已经补好 Node 全局的 pdfjs 模块。 */
  load(): Promise<PdfjsModule>
  /** 逐页提取文本型 PDF 的可选择文本；pages 指定离散页码，maxPages 只读前若干页，都不给就整本读。 */
  extractTextPages(
    path: string,
    options?: { pages?: readonly number[]; maxPages?: number }
  ): Promise<ExtractedPdfText>
}

export class PdfjsRuntime implements PdfjsRuntimeApi {
  public async load(): Promise<PdfjsModule> {
    return loadPdfjs()
  }

  public async extractTextPages(
    path: string,
    options: { pages?: readonly number[]; maxPages?: number } = {}
  ): Promise<ExtractedPdfText> {
    const pdfjs = await this.load()
    const bytes = new Uint8Array(await readFile(path))
    const loadingTask = pdfjs.getDocument({
      data: bytes,
      useWorkerFetch: false,
      isEvalSupported: false,
      standardFontDataUrl: getPdfjsStandardFontDataUrl(),
    })
    try {
      const document = await loadingTask.promise
      const pageCount = document.numPages
      const requestedPages = options.pages
        ? [...new Set(options.pages)]
        : Array.from(
            { length: Math.min(pageCount, options.maxPages ?? pageCount) },
            (_, index) => index + 1
          )
      const invalidPage = requestedPages.find(
        (pageNumber) => pageNumber < 1 || pageNumber > pageCount
      )
      if (!isUndefined(invalidPage)) {
        throw new AppError(
          OfficeErrorCodes.pdfPageOutOfRange,
          `这份 PDF 只有 ${pageCount} 页，页码 ${invalidPage} 超出范围。`
        )
      }
      const pages: OfficePdfPage[] = []
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
      return { pageCount, pages }
    } finally {
      await loadingTask.destroy()
    }
  }
}

/** 整个进程共用的 pdfjs 运行时。 */
export const pdfjsRuntime: PdfjsRuntimeApi = new PdfjsRuntime()
