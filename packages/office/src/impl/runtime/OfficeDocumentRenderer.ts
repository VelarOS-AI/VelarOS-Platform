/**
 * 文档渲染面：`OfficeDocumentRenderer` 与整个进程唯一的 `officeDocumentRenderer`。接口 `OfficeDocumentRendererApi` 在本文件的类上方。
 * 这是 `./renderer` 入口交出去的那一件能力：独立发布的 Document Renderer 用它解析预览、画预览图、渲染 PDF 单页，
 * 不必在 office 依赖旁边再装一份原生 Canvas 和一棵 pdfjs 字体树。整条值引用链不经过工具文件，因此也不需要 agent。
 */

import { readFile } from 'node:fs/promises'

import { createCanvas } from '@napi-rs/canvas'

import { AppError } from '@velaros-ai/core/error'

import { OfficeErrorCodes } from '../../contract/constants.js'
import type { NormalizedWordInput } from '../../types/office.js'
import type {
  OfficePreviewKind,
  ParsedOfficePreview,
  RenderedOfficePreviewPng,
  RenderedPdfPagePng,
  RenderPdfPagePngInput,
} from '../../types/preview.js'
import { getPdfjsStandardFontDataUrl } from '../../utils/pdf/pdfjs-globals.js'
import { buildOfficePreviewHtml } from '../../utils/preview/html.js'
import { parseOfficePreview } from '../../utils/preview/parse.js'
import { renderOfficePreviewPng } from '../../utils/preview/png.js'
import { OfficeTuning } from '../../utils/tuning.js'

import { pdfjsRuntime } from './PdfjsRuntime.js'

/**
 * 文档渲染面：四件操作，全部只读输入文件、只返回内存结果，落盘由调用方决定。
 * 失败一律抛 `AppError`，码见 `OfficeErrorCodes` 的 pdfPage / pdfRender 那几项；调用方按码分支，不按文字判断。
 */
export interface OfficeDocumentRendererApi {
  /** 解析 docx / pptx / xlsx，得到标题、摘要、大纲或分页数据，以及净化过的正文 HTML。 */
  parsePreview(
    inputPath: string,
    kind: OfficePreviewKind,
    maxItems: number
  ): Promise<ParsedOfficePreview>
  /** 把解析结果拼成一张能在浏览器里直接打开的预览页。 */
  buildPreviewHtml(input: {
    parsed: ParsedOfficePreview
    inputPath: string
    normalizedInput: Nullable<NormalizedWordInput>
    autoRefresh: boolean
  }): string
  /** 把解析结果画成一张预览 PNG，给不方便开 HTML 的地方看。 */
  renderPreviewPng(parsed: ParsedOfficePreview): Promise<RenderedOfficePreviewPng>
  /** 渲染 PDF 的某一页成 PNG；页码非法、超出页数、倍率非法或超过像素上限时抛 AppError。 */
  renderPdfPagePng(input: RenderPdfPagePngInput): Promise<RenderedPdfPagePng>
}

export class OfficeDocumentRenderer implements OfficeDocumentRendererApi {
  public async parsePreview(
    inputPath: string,
    kind: OfficePreviewKind,
    maxItems: number
  ): Promise<ParsedOfficePreview> {
    return parseOfficePreview(inputPath, kind, maxItems)
  }

  public buildPreviewHtml(input: {
    parsed: ParsedOfficePreview
    inputPath: string
    normalizedInput: Nullable<NormalizedWordInput>
    autoRefresh: boolean
  }): string {
    return buildOfficePreviewHtml(input)
  }

  public async renderPreviewPng(parsed: ParsedOfficePreview): Promise<RenderedOfficePreviewPng> {
    return renderOfficePreviewPng(parsed)
  }

  public async renderPdfPagePng(input: RenderPdfPagePngInput): Promise<RenderedPdfPagePng> {
    const pageNumber = input.page ?? 1
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      throw new AppError(OfficeErrorCodes.pdfPageInvalid, 'PDF 页码必须是正整数。')
    }

    const scale = input.scale ?? OfficeTuning.pdf.renderScale
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new AppError(OfficeErrorCodes.pdfRenderScaleInvalid, 'PDF 渲染倍率必须大于零。')
    }

    const maximumPixels = input.maximumPixels ?? OfficeTuning.pdf.renderPixels
    const pdfjs = await pdfjsRuntime.load()
    const task = pdfjs.getDocument({
      data: new Uint8Array(await readFile(input.inputPath)),
      isEvalSupported: false,
      standardFontDataUrl: input.standardFontDataUrl ?? getPdfjsStandardFontDataUrl(),
      useWorkerFetch: false,
    })
    const document = await task.promise

    try {
      if (pageNumber > document.numPages) {
        throw new AppError(
          OfficeErrorCodes.pdfPageOutOfRange,
          `PDF 共 ${document.numPages} 页，请求的是第 ${pageNumber} 页。`
        )
      }

      const page = await document.getPage(pageNumber)
      const viewport = page.getViewport({ scale })
      const width = Math.max(1, Math.ceil(viewport.width))
      const height = Math.max(1, Math.ceil(viewport.height))
      if (width * height > maximumPixels) {
        throw new AppError(
          OfficeErrorCodes.pdfRenderPixelLimit,
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
}

/** 整个进程共用的文档渲染面，`./renderer` 入口交出去的就是它。 */
export const officeDocumentRenderer: OfficeDocumentRendererApi = new OfficeDocumentRenderer()
