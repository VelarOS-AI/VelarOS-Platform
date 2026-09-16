/** PDF 域的数据形状：pdfjs 的窄视图、逐页文本、文字戳、元数据与 LaTeX 编译器。 */

/** pdfjs-dist 里本包真正用到的那一面；体积大且依赖浏览器全局，所以只声明这几个成员。 */
export interface PdfjsModule {
  getDocument(params: Record<string, unknown>): {
    promise: Promise<{
      numPages: number
      getPage(pageNumber: number): Promise<{
        getTextContent(): Promise<{ items: Array<{ str?: string }> }>
        getViewport(input: { scale: number }): { width: number; height: number }
        render(input: Record<string, unknown>): { promise: Promise<void> }
      }>
    }>
    destroy(): Promise<void> | void
  }
}

/** pdfjs 在 Node 环境里会访问的三个浏览器图形全局；缺失时由 canvas 实现或内联替身补齐。 */
export type PdfjsNodeGlobals = {
  DOMMatrix?: unknown
  ImageData?: unknown
  Path2D?: unknown
}

/** 一页 PDF 抽出来的文本。 */
export type ExtractedPdfTextPage = {
  page: number
  text: string
}

/** 一次按页提取的结果：文档总页数与实际读到的那几页。 */
export type ExtractedPdfText = {
  pageCount: number
  pages: ExtractedPdfTextPage[]
}

/** PDF 文字戳/水印配置，page 指源 PDF 页码，allPages 则应用到所有输出页。 */
export type PdfTextStampInput = {
  text: string
  page?: number
  allPages?: boolean
  x?: number
  y?: number
  size?: number
  color?: string
  opacity?: number
}

/** 可写入 PDF 文档信息字典的元数据。 */
export type PdfMetadataInput = {
  title?: string
  author?: string
  subject?: string
  keywords?: string[]
}

/** 支持自动选择，也支持用户指定具体 LaTeX 编译器。 */
export type LatexCompiler = 'auto' | 'tectonic' | 'latexmk' | 'xelatex' | 'pdflatex'
