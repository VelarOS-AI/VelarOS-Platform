/** PDF 域的内部形状：pdfjs 的窄视图、Node 里要补的图形全局、逐页文本。模型面的文字戳、文档信息与 LaTeX 编译器在 `office.ts`。 */

import type { OfficePdfPage } from './office.js'

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

/** 一次按页提取的结果：文档总页数与实际读到的那几页。 */
export type ExtractedPdfText = {
  pageCount: number
  pages: OfficePdfPage[]
}
