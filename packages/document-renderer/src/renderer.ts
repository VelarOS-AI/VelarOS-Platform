import { readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas'

import { Log } from '@velaros-ai/core'
import {
  buildOfficePreviewHtml,
  type OfficePreviewKind,
  parseOfficePreview,
  renderOfficePreviewPng,
} from '@velaros-ai/office/renderer'

import { resolveRendererPaths } from './path-policy'
import {
  DocumentRendererProtocolVersion,
  DocumentRendererVersion,
  type RendererDescriptor,
} from './protocol'

const OfficeInputKinds = new Map<string, OfficePreviewKind>([
  ['.docx', 'docx'],
  ['.pptx', 'pptx'],
  ['.xlsx', 'xlsx'],
])
const MaximumPdfPixels = 40_000_000
const require = createRequire(import.meta.url)

export class UnsupportedRendererFormatError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'UnsupportedRendererFormatError'
  }
}

export function describeRenderer(): RendererDescriptor {
  return {
    protocolVersion: DocumentRendererProtocolVersion,
    product: 'velar-document-renderer',
    version: DocumentRendererVersion,
    transport: 'one-json-request-per-process',
    operations: [
      {
        name: 'render-office',
        inputExtensions: ['.docx', '.pptx', '.xlsx'],
        outputExtensions: ['.html', '.png'],
      },
      {
        name: 'render-pdf-page',
        inputExtensions: ['.pdf'],
        outputExtensions: ['.png'],
      },
    ],
  }
}

export async function renderOfficeDocument(input: {
  readonly projectRoot: string
  readonly inputPath: string
  readonly outputPath: string
  readonly maxItems?: number
}): Promise<Record<string, unknown>> {
  const paths = await resolveRendererPaths(input)
  const inputExtension = extname(paths.inputPath).toLowerCase()
  const outputExtension = extname(paths.outputPath).toLowerCase()
  const kind = OfficeInputKinds.get(inputExtension)
  if (!kind) {
    throw new UnsupportedRendererFormatError(
      `render-office supports .docx, .pptx, and .xlsx; received ${inputExtension || 'no extension'}.`,
    )
  }
  if (outputExtension !== '.html' && outputExtension !== '.png') {
    throw new UnsupportedRendererFormatError(
      `render-office output must be .html or .png; received ${outputExtension || 'no extension'}.`,
    )
  }

  const parsed = await parseOfficePreview(paths.inputPath, kind, input.maxItems ?? 80)
  if (outputExtension === '.html') {
    const html = buildOfficePreviewHtml({
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

  const image = await renderOfficePreviewPng(parsed)
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

function pdfStandardFontDataUrl(): string | undefined {
  const resourcesRoot = process.env.VELAROS_DOCUMENT_RENDERER_RESOURCES_ROOT?.trim()
  if (resourcesRoot) return `${pathToFileURL(join(resourcesRoot, 'pdfjs-standard-fonts')).href}/`
  try {
    const packagePath = require.resolve('pdfjs-dist/package.json')
    return `${pathToFileURL(join(dirname(packagePath), 'standard_fonts')).href}/`
  } catch (error) {
    Log.tag('DocumentRenderer').warn(
      '未找到 PDF.js 标准字体目录，将继续使用 PDF.js 的默认字体策略。',
      { error },
    )
    return undefined
  }
}

export async function renderPdfPage(input: {
  readonly projectRoot: string
  readonly inputPath: string
  readonly outputPath: string
  readonly page?: number
  readonly scale?: number
}): Promise<Record<string, unknown>> {
  const paths = await resolveRendererPaths(input)
  if (extname(paths.inputPath).toLowerCase() !== '.pdf') {
    throw new UnsupportedRendererFormatError('render-pdf-page input must be a .pdf file.')
  }
  if (extname(paths.outputPath).toLowerCase() !== '.png') {
    throw new UnsupportedRendererFormatError('render-pdf-page output must be a .png file.')
  }

  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D })
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({
    data: new Uint8Array(await readFile(paths.inputPath)),
    isEvalSupported: false,
    standardFontDataUrl: pdfStandardFontDataUrl(),
    useWorkerFetch: false,
  })
  const document = await task.promise
  try {
    const pageNumber = input.page ?? 1
    if (pageNumber > document.numPages) {
      throw new UnsupportedRendererFormatError(
        `PDF contains ${document.numPages} page(s); requested page ${pageNumber}.`,
      )
    }
    const page = await document.getPage(pageNumber)
    const scale = input.scale ?? 1.5
    const viewport = page.getViewport({ scale })
    const width = Math.max(1, Math.ceil(viewport.width))
    const height = Math.max(1, Math.ceil(viewport.height))
    if (width * height > MaximumPdfPixels) {
      throw new UnsupportedRendererFormatError(
        `Rendered PDF page exceeds the ${MaximumPdfPixels.toLocaleString('en-US')} pixel safety limit.`,
      )
    }
    const canvas = createCanvas(width, height)
    const context = canvas.getContext('2d')
    await page.render({ canvasContext: context, viewport }).promise
    const buffer = canvas.toBuffer('image/png')
    await writeFile(paths.outputPath, buffer)
    return {
      kind: 'png',
      path: paths.outputPath,
      bytes: buffer.byteLength,
      width,
      height,
      page: pageNumber,
      pageCount: document.numPages,
      scale,
    }
  } finally {
    await document.destroy()
  }
}
