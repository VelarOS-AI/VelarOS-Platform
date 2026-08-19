declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  interface PdfJsDocumentProxy {
    readonly numPages: number
    getPage(pageNumber: number): Promise<{
      getViewport(input: { scale: number }): { width: number; height: number }
      render(input: Record<string, unknown>): { promise: Promise<void> }
    }>
    destroy(): Promise<void> | void
  }

  export function getDocument(input: Record<string, unknown>): {
    promise: Promise<PdfJsDocumentProxy>
  }
}
