import { readFile } from 'node:fs/promises'

import { createCanvas } from '@napi-rs/canvas'

import { getPdfjsStandardFontDataUrl, loadPdfjs } from './pdfTools'

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

export type RenderPdfPagePngInput = {
  readonly inputPath: string
  readonly page?: number
  readonly scale?: number
  readonly maximumPixels?: number
  readonly standardFontDataUrl?: string
}

export type RenderedPdfPagePng = {
  readonly buffer: Buffer
  readonly width: number
  readonly height: number
  readonly page: number
  readonly pageCount: number
  readonly scale: number
}

/**
 * Office owns the PDF.js + Canvas runtime pair. Product renderers call this narrow operation instead
 * of installing another native Canvas and another PDF.js font tree beside the Office dependency.
 */
export async function renderPdfPagePng(
  input: RenderPdfPagePngInput
): Promise<RenderedPdfPagePng> {
  const pageNumber = input.page ?? 1
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new OfficePdfPageRenderError('INVALID_PAGE', 'PDF page must be a positive integer.')
  }

  const scale = input.scale ?? 1.5
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new OfficePdfPageRenderError('INVALID_SCALE', 'PDF scale must be greater than zero.')
  }

  const maximumPixels = input.maximumPixels ?? 40_000_000
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
        `PDF contains ${document.numPages} page(s); requested page ${pageNumber}.`
      )
    }

    const page = await document.getPage(pageNumber)
    const viewport = page.getViewport({ scale })
    const width = Math.max(1, Math.ceil(viewport.width))
    const height = Math.max(1, Math.ceil(viewport.height))
    if (width * height > maximumPixels) {
      throw new OfficePdfPageRenderError(
        'PIXEL_LIMIT',
        `Rendered PDF page exceeds the ${maximumPixels.toLocaleString('en-US')} pixel safety limit.`
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
