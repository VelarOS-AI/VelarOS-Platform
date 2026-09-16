import { readFile } from 'node:fs/promises'

import { createCanvas } from '@napi-rs/canvas'

import type { RenderedPdfPagePng, RenderPdfPagePngInput } from '../types/preview.js'
import { getPdfjsStandardFontDataUrl, loadPdfjs } from '../utils/pdf/pdfjs-globals.js'
import { OfficeTuning } from '../utils/tuning.js'

export type OfficePdfPageRenderErrorCode =
  | 'INVALID_PAGE'
  | 'INVALID_SCALE'
  | 'PAGE_OUT_OF_RANGE'
  | 'PIXEL_LIMIT'

export class OfficePdfPageRenderError extends Error {
  public constructor(
    public readonly code: OfficePdfPageRenderErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'OfficePdfPageRenderError'
  }
}

export type { RenderedPdfPagePng, RenderPdfPagePngInput }

/**
 * pdfjs 与 Canvas 这对运行时由 office 持有。产品侧的渲染器调这一个窄操作，
 * 而不是在 office 依赖旁边再装一份原生 Canvas 和一棵 pdfjs 字体树。
 */
export async function renderPdfPagePng(
  input: RenderPdfPagePngInput
): Promise<RenderedPdfPagePng> {
  const pageNumber = input.page ?? 1
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new OfficePdfPageRenderError('INVALID_PAGE', 'PDF 页码必须是正整数。')
  }

  const scale = input.scale ?? OfficeTuning.pdf.renderScale
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new OfficePdfPageRenderError('INVALID_SCALE', 'PDF 渲染倍率必须大于零。')
  }

  const maximumPixels = input.maximumPixels ?? OfficeTuning.pdf.renderPixels
  const pdfjs = await loadPdfjs()
  const task = pdfjs.getDocument({
    data: new Uint8Array(await readFile(input.inputPath)),
    isEvalSupported: false,
    standardFontDataUrl: input.standardFontDataUrl ?? getPdfjsStandardFontDataUrl(),
    useWorkerFetch: false,
  })
  const document = await task.promise

  try {
    if (pageNumber > document.numPages) {
      throw new OfficePdfPageRenderError(
        'PAGE_OUT_OF_RANGE',
        `PDF 共 ${document.numPages} 页，请求的是第 ${pageNumber} 页。`
      )
    }

    const page = await document.getPage(pageNumber)
    const viewport = page.getViewport({ scale })
    const width = Math.max(1, Math.ceil(viewport.width))
    const height = Math.max(1, Math.ceil(viewport.height))
    if (width * height > maximumPixels) {
      throw new OfficePdfPageRenderError(
        'PIXEL_LIMIT',
        `渲染这一页会超过 ${maximumPixels.toLocaleString('en-US')} 像素的安全上限。`
      )
    }

    const canvas = createCanvas(width, height)
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    return {
      buffer: canvas.toBuffer('image/png'),
      width,
      height,
      page: pageNumber,
      pageCount: document.numPages,
      scale,
    }
  } finally {
    await task.destroy()
  }
}
