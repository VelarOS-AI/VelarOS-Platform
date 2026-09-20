/** 文档预览域的内部形状：mammoth 的窄视图、解析结果、预览产物，以及给 Document Renderer 的 PDF 单页渲染入参与结果。模型面的大纲、幻灯片与工作表摘录在 `office.ts`。 */

import type { PreviewOutlineItem, PreviewSheet, PreviewSlide } from './office.js'

/** 可预览的 Office 文档类型。 */
export type OfficePreviewKind = 'docx' | 'pptx' | 'xlsx'

/** mammoth 转换过程中的一条提示（未识别样式、丢弃的内容）。 */
export type MammothMessage = {
  type: string
  message: string
}

/** mammoth 里本包真正用到的那一面，避免把它的全量 API 泄进签名。 */
export type MammothModule = {
  convertToHtml: (
    input: { path: string },
    options?: Record<string, unknown>
  ) => Promise<{ value: string; messages: MammothMessage[] }>
}

/** 解析一份 Office 文档得到的预览数据；HTML 与 PNG 都由它渲染。 */
export type ParsedOfficePreview = {
  kind: OfficePreviewKind
  title: string
  summary: Record<string, number>
  htmlBody: string
  outline?: PreviewOutlineItem[]
  slides?: PreviewSlide[]
  sheets?: PreviewSheet[]
  messages?: MammothMessage[]
}

/** PDF 单页渲染入参：页码从 1 起，倍率与像素上限缺省由可调参数决定。 */
export type RenderPdfPagePngInput = {
  readonly inputPath: string
  readonly page?: number
  readonly scale?: number
  readonly maximumPixels?: number
  readonly standardFontDataUrl?: string
}

/** PDF 单页渲染结果：PNG 字节、画布尺寸，以及实际渲染的页码与倍率。 */
export type RenderedPdfPagePng = {
  readonly buffer: Buffer
  readonly width: number
  readonly height: number
  readonly page: number
  readonly pageCount: number
  readonly scale: number
}

/** 预览图渲染结果：PNG 字节与画布尺寸。 */
export type RenderedOfficePreviewPng = {
  buffer: Buffer
  width: number
  height: number
}
