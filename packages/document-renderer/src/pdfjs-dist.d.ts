declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export function getDocument(input: Record<string, unknown>): {
    promise: Promise<unknown>
  }
}
