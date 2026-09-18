/**
 * 真正干活的渲染：Office 文档预览与 PDF 单页位图，经 `@velaros-ai/velar/office` 的渲染原语。
 * 两种操作都先过路径准入，再落盘；认不出的扩展名与渲染不出来的页都收成 UNSUPPORTED_FORMAT。
 */
import { stat, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'

import { AppError } from '@velaros-ai/core'
import {
  officeDocumentRenderer,
  OfficeErrorCodes,
  type OfficePreviewKind,
} from '@velaros-ai/velar/office/renderer'

import {
  DocumentRendererErrorCodes,
  DocumentRendererFormats,
  DocumentRendererLimits,
} from '../contract/constants.js'
import type { RenderOfficeRequest, RenderPdfPageRequest } from '../types/rendering.js'
import { pdfStandardFontDataUrl } from '../utils/paths.js'
import { DocumentRendererTuning } from '../utils/tuning.js'

import { rendererPaths, type RendererPathsApi } from './RendererPaths.js'

/**
 * 两种渲染操作的执行者。实例是 `officeRenderer`，由 `DocumentRenderer` 持有；
 * 每个方法返回写进成功回执的结果对象（落盘位置、字节数、尺寸这些）。失败一律抛 `AppError`，由调用方收成回执。
 */
export interface OfficeRendererApi {
  /**
   * 把 `.docx`、`.pptx`、`.xlsx` 渲染成 `.html` 预览页或 `.png` 整页位图，写到 outputPath。
   * 输入或输出的扩展名不在格式表里时抛 UNSUPPORTED_FORMAT；路径越界时抛 PATH_DENIED。
   */
  renderOffice: (request: RenderOfficeRequest) => Promise<PlainObject>
  /**
   * 把 `.pdf` 的一页渲染成 `.png`，写到 outputPath；不填 page 就渲染第一页。
   * 扩展名不对、这一页渲染不出来时抛 UNSUPPORTED_FORMAT；路径越界时抛 PATH_DENIED。
   */
  renderPdfPage: (request: RenderPdfPageRequest) => Promise<PlainObject>
}

class OfficeRenderer implements OfficeRendererApi {
  /** office 的 PDF 单页渲染拒绝这一页时用的错误码；命中就收成 UNSUPPORTED_FORMAT。 */
  private static readonly PdfPageRenderErrorCodes = new Set<string>([
    OfficeErrorCodes.pdfPageInvalid,
    OfficeErrorCodes.pdfPageOutOfRange,
    OfficeErrorCodes.pdfRenderScaleInvalid,
    OfficeErrorCodes.pdfRenderPixelLimit,
  ])

  /** 三种输入扩展名各自对应 office 的哪一种预览。 */
  private static readonly InputKinds = new Map<string, OfficePreviewKind>([
    ['.docx', 'docx'],
    ['.pptx', 'pptx'],
    ['.xlsx', 'xlsx'],
  ])

  public constructor(private readonly paths: RendererPathsApi) {}

  public async renderOffice(request: RenderOfficeRequest): Promise<PlainObject> {
    const paths = await this.paths.resolve(request)
    const inputExtension = extname(paths.inputPath).toLowerCase()
    const outputExtension = extname(paths.outputPath).toLowerCase()
    const kind = OfficeRenderer.InputKinds.get(inputExtension)
    if (!kind) {
      throw new AppError(
        DocumentRendererErrorCodes.unsupportedFormat,
        `render-office 只接受 ${DocumentRendererFormats.renderOffice.inputExtensions.join('、')}，收到的是 ${inputExtension || '没有扩展名'}。`,
      )
    }
    if (outputExtension !== '.html' && outputExtension !== '.png') {
      throw new AppError(
        DocumentRendererErrorCodes.unsupportedFormat,
        `render-office 的输出只能是 ${DocumentRendererFormats.renderOffice.outputExtensions.join(' 或 ')}，收到的是 ${outputExtension || '没有扩展名'}。`,
      )
    }

    const parsed = await officeDocumentRenderer.parsePreview(
      paths.inputPath,
      kind,
      request.maxItems ?? DocumentRendererTuning.office.defaultMaxItems,
    )
    if (outputExtension === '.html') {
      const html = officeDocumentRenderer.buildPreviewHtml({
        parsed,
        inputPath: paths.inputPath,
        normalizedInput: null,
        autoRefresh: false,
      })
      await writeFile(paths.outputPath, html, 'utf8')
      const outputStats = await stat(paths.outputPath)
      return {
        kind: 'html',
        path: paths.outputPath,
        bytes: outputStats.size,
        documentKind: kind,
        summary: parsed.summary,
      }
    }

    const image = await officeDocumentRenderer.renderPreviewPng(parsed)
    await writeFile(paths.outputPath, image.buffer)
    return {
      kind: 'png',
      path: paths.outputPath,
      bytes: image.buffer.byteLength,
      width: image.width,
      height: image.height,
      documentKind: kind,
      summary: parsed.summary,
    }
  }

  public async renderPdfPage(request: RenderPdfPageRequest): Promise<PlainObject> {
    const paths = await this.paths.resolve(request)
    if (extname(paths.inputPath).toLowerCase() !== '.pdf') {
      throw new AppError(
        DocumentRendererErrorCodes.unsupportedFormat,
        'render-pdf-page 的输入必须是 .pdf 文件。',
      )
    }
    if (extname(paths.outputPath).toLowerCase() !== '.png') {
      throw new AppError(
        DocumentRendererErrorCodes.unsupportedFormat,
        'render-pdf-page 的输出必须是 .png 文件。',
      )
    }

    try {
      const rendered = await officeDocumentRenderer.renderPdfPagePng({
        inputPath: paths.inputPath,
        maximumPixels: DocumentRendererLimits.maximumPdfPixels,
        page: request.page,
        scale: request.scale,
        standardFontDataUrl: pdfStandardFontDataUrl(),
      })
      await writeFile(paths.outputPath, rendered.buffer)
      return {
        kind: 'png',
        path: paths.outputPath,
        bytes: rendered.buffer.byteLength,
        width: rendered.width,
        height: rendered.height,
        page: rendered.page,
        pageCount: rendered.pageCount,
        scale: rendered.scale,
      }
    } catch (error) {
      if (error instanceof AppError && OfficeRenderer.PdfPageRenderErrorCodes.has(error.code)) {
        throw new AppError(DocumentRendererErrorCodes.unsupportedFormat, error.message)
      }
      throw error
    }
  }
}

/** 进程里的那一份渲染能力。 */
export const officeRenderer: OfficeRendererApi = new OfficeRenderer(rendererPaths)
