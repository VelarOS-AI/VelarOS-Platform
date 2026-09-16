/** 文档预览域的数据形状：解析结果、预览产物，以及给 Document Renderer 的 PDF 单页渲染入参与结果。 */

/** 可预览的 Office 文档类型。 */
export type OfficePreviewKind = 'docx' | 'pptx' | 'xlsx'

/** 预览产物：写到磁盘的 HTML 或 PNG。 */
export type OfficePreviewArtifact = {
  path: string
  bytes: number
  created: boolean
  changed: true
  kind: 'html' | 'png'
  width?: number
  height?: number
}

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

/** 文档大纲里的一条标题。 */
export type PreviewOutlineItem = {
  level?: number
  title: string
}

/** 预览里的一页幻灯片：标题与前几条要点。 */
export type PreviewSlide = {
  index: number
  title: string
  bullets: string[]
}

/** 预览里的一张工作表：行列总数与抽样出来的前几行。 */
export type PreviewSheet = {
  name: string
  rowCount: number
  columnCount: number
  rows: string[][]
}

/** 解析一份 Office 文档得到的预览数据；HTML 与 PNG 都由它渲染。 */
export type ParsedOfficePreview = {
  kind: OfficePreviewKind
  title: string
  summary: Record<string, unknown>
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
