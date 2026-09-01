import { stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  buildOfficePreviewHtml,
  OfficePdfPageRenderError,
  type OfficePreviewKind,
  parseOfficePreview,
  renderOfficePreviewPng,
  renderPdfPagePng,
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
  return undefined
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

  try {
    const rendered = await renderPdfPagePng({
      inputPath: paths.inputPath,
      maximumPixels: MaximumPdfPixels,
      page: input.page,
      scale: input.scale,
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
    if (error instanceof OfficePdfPageRenderError) {
      throw new UnsupportedRendererFormatError(error.message)
    }
    throw error
  }
}
