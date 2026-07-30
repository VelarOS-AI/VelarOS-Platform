/**
 * PDF 相关工具集合：
 *   - 将 Word 文档转换为 PDF（依赖 LibreOffice）
 *   - 从 PDF 提取文本并生成 Word 文档
 *   - 将 LaTeX 源码编译为 PDF
 *   - 处理 PDF 页面、文字水印和元数据
 *
 * 依赖共享办公工具模块提供的类型、路径和系统辅助能力。
 */
import { readFile } from 'node:fs/promises'

import { type PDFDocument, type PDFPage, type RGB, rgb } from 'pdf-lib'
import { z } from 'zod'

import { isEmpty,isFunction, isPlainObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/core/utils/ToolDescription'

import type {
  OfficeEnvironmentCommandAvailability,
  OfficeSystemCommandResult,
} from './OfficeContracts'
import {
  commandExecutable,
  dirname,
  extname,
  findAvailableCommand,
  type OfficeToolContext,
  outputPathSchema,
  requireFromOfficeModule,
  runOfficeSystemCommand,
} from './officeShared'

export const log = logRuntime.tag('PdfTools')

// pdfjs-dist 体积较大且依赖浏览器全局对象，因此只在 PDF 文本提取时按需加载。
export interface PdfjsModule {
  getDocument(params: Record<string, unknown>): {
    promise: Promise<{
      numPages: number
      getPage(pageNumber: number): Promise<{
        getTextContent(): Promise<{ items: Array<{ str?: string }> }>
      }>
      destroy(): Promise<void> | void
    }>
  }
}

function isPdfjsModule(value: unknown): value is PdfjsModule {
  return isPlainObject(value) && isFunction(value.getDocument)
}

// pdfjs 在 Node 环境里会访问这些浏览器图形对象；缺失时由 @napi-rs/canvas 补齐。
export type PdfjsNodeGlobals = {
  DOMMatrix?: unknown
  ImageData?: unknown
  Path2D?: unknown
}

/**
 * 以 pdfjs 需要的那一面看待全局作用域。
 *
 * 判据（§1.4）：`typeof globalThis` 里没有这三个浏览器全局的声明（本包不引 DOM lib——引了会
 * 让整个 Node 侧类型面凭空多出一整套浏览器 API）。所以这里在**唯一一处**把全局收窄成
 * 「可选三成员」的视图，其余代码只跟这个视图打交道，不再各自断言。
 */
function readPdfjsNodeGlobals(): PdfjsNodeGlobals {
  return globalThis
}

// 确保 Node 进程拥有 pdfjs 需要的 DOMMatrix/ImageData/Path2D 全局对象。
/** 提供覆盖文本提取路径所需的最小 DOMMatrix 替身。 */
export function makeDOMMatrixStub() {
  return class DOMMatrixStub {
    a = 1
    b = 0
    c = 0
    d = 1
    e = 0
    f = 0
    m11 = 1
    m12 = 0
    m13 = 0
    m14 = 0
    m21 = 0
    m22 = 1
    m23 = 0
    m24 = 0
    m31 = 0
    m32 = 0
    m33 = 1
    m34 = 0
    m41 = 0
    m42 = 0
    m43 = 0
    m44 = 1
    is2D = true
    isIdentity = true
    constructor(_init?: unknown) {}
    public multiply(_m: unknown) {
      return new DOMMatrixStub()
    }
    public inverse() {
      return new DOMMatrixStub()
    }
    public transformPoint(p?: unknown) {
      return p ?? { x: 0, y: 0, w: 0 }
    }
    public translate(_x?: number, _y?: number) {
      return new DOMMatrixStub()
    }
    public scale(_x?: number, _y?: number) {
      return new DOMMatrixStub()
    }
    public rotate(_r?: number) {
      return new DOMMatrixStub()
    }
    public static fromMatrix(_m?: unknown) {
      return new DOMMatrixStub()
    }
    public static fromFloat32Array(_a: Float32Array) {
      return new DOMMatrixStub()
    }
    public static fromFloat64Array(_a: Float64Array) {
      return new DOMMatrixStub()
    }
  }
}

/**
 * 安装 pdfjs 在 Node 环境中需要的浏览器全局对象。
 *
 * 策略：
 * 1. 先使用轻量内联替身，让文本提取不依赖原生模块。
 * 2. 如果安装了画布模块，再升级为真实实现以增强图像处理支持。
 */
export async function ensurePdfjsNodeGlobals(): Promise<void> {
  const g = readPdfjsNodeGlobals()

  // 先安装内联替身；这条路径不依赖外部原生模块。
  if (!g.DOMMatrix) g.DOMMatrix = makeDOMMatrixStub()
  if (!g.ImageData) {
    g.ImageData = class ImageData {
      width: number
      height: number
      data: Uint8ClampedArray
      constructor(widthOrData: number | Uint8ClampedArray, height: number) {
        if (widthOrData instanceof Uint8ClampedArray) {
          this.data = widthOrData
          this.width = height
          this.height = widthOrData.length / (4 * height)
        } else {
          this.width = widthOrData
          this.height = height
          this.data = new Uint8ClampedArray(widthOrData * height * 4)
        }
      }
    }
  }
  if (!g.Path2D) {
    g.Path2D = class Path2D {
      public moveTo(_x?: number, _y?: number) {}
      public lineTo(_x?: number, _y?: number) {}
      public closePath() {}
      public rect(_x?: number, _y?: number, _w?: number, _h?: number) {}
      public arc(_x?: number, _y?: number, _r?: number, _sa?: number, _ea?: number) {}
      public addPath(_p?: unknown) {}
    }
  }

  // 如果安装了画布模块，则升级为真实实现。
  try {
    const canvas = (await import('@napi-rs/canvas')) as {
      DOMMatrix?: unknown
      ImageData?: unknown
      Path2D?: unknown
    }
    if (canvas.DOMMatrix) g.DOMMatrix = canvas.DOMMatrix
    if (canvas.ImageData) g.ImageData = canvas.ImageData
    if (canvas.Path2D) g.Path2D = canvas.Path2D
  } catch (error) {
    log.debug('加载可选 canvas 依赖失败，使用 PDF 文本提取兜底全局对象', {
      error: String(error),
    })
  }
}

// 懒加载 pdfjs，并在加载前准备好 Node 运行时的图形全局对象。
export async function loadPdfjs(): Promise<PdfjsModule> {
  await ensurePdfjsNodeGlobals()
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs')
  if (!isPdfjsModule(pdfjs)) {
    throw new AppError('EXECUTION_FAILED', 'pdfjs-dist did not expose getDocument.')
  }
  return pdfjs
}

// ─── Types ─────────────────────────────────────────────────────────────────────

// PDF 转 Word 的输入：读取 PDF 文本，再写成 docx。
export type ConvertPdfToWordInput = {
  cwd?: string
  inputPath: string
  outputPath: string
  title?: string
  author?: string
  maxPages?: number
  overwrite?: boolean
}

// Word 转 PDF 的输入：依赖本机 LibreOffice/soffice。
export type ConvertWordToPdfInput = {
  cwd?: string
  inputPath: string
  outputPath: string
  overwrite?: boolean
}

// PDF 文字戳/水印配置，page 指源 PDF 页码，allPages 则应用到所有输出页。
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

// 可写入 PDF 文档信息字典的元数据。
export type PdfMetadataInput = {
  title?: string
  author?: string
  subject?: string
  keywords?: string[]
}

// PDF 编辑工具输入：页面选择、删除、旋转、水印和元数据都在这里声明。
export type EditPdfDocumentInput = {
  cwd?: string
  inputPath: string
  outputPath: string
  overwrite?: boolean
  pageSelection?: number[]
  removePages?: number[]
  rotatePages?: Array<{ page: number; degrees: 90 | 180 | 270 }>
  textStamps?: PdfTextStampInput[]
  metadata?: PdfMetadataInput
}

// 支持自动选择，也支持用户指定具体 LaTeX 编译器。
export type LatexCompiler = 'auto' | 'tectonic' | 'latexmk' | 'xelatex' | 'pdflatex'

// LaTeX 生成 PDF 的输入；源码会先落盘为 .tex，再调用系统编译器。
export type CreateLatexPdfInput = {
  cwd?: string
  outputPath: string
  sourcePath?: string
  latexSource: string
  compiler?: LatexCompiler
  runs?: number
  overwrite?: boolean
}

// ─── Zod schemas ───────────────────────────────────────────────────────────────

// PDF 输入路径 schema 会在具体执行时解析成工作区内的真实文件路径。
export const inputPdfPathSchema = z
  .string()
  .min(1)
  .max(1200)
  .describe(
    parameterDescription({
      description: '输入 PDF 文件路径。',
      usage: ['支持相对当前工作区的路径。'],
    })
  )

// PDF 转 Word 参数校验，maxPages 用于限制提取页数，避免超大 PDF 长时间运行。
export const convertPdfToWordSchema = z.object({
  cwd: z.string().optional(),
  inputPath: inputPdfPathSchema,
  outputPath: outputPathSchema,
  title: z.string().min(1).max(200).optional(),
  author: z.string().min(1).max(120).optional(),
  maxPages: z.number().int().min(1).max(500).optional(),
  overwrite: z.boolean().optional(),
})

// Word 输入路径允许 .docx/.doc，后续会按扩展名补全查找。
export const inputWordPathSchema = z
  .string()
  .min(1)
  .max(1200)
  .describe(
    parameterDescription({
      description: '输入 Word 文件路径。',
      usage: ['支持 .docx 或 .doc，也支持相对当前工作区的路径。'],
    })
  )

// Word 转 PDF 参数校验，只负责路径和覆盖策略，实际转换由 LibreOffice 完成。
export const convertWordToPdfSchema = z.object({
  cwd: z.string().optional(),
  inputPath: inputWordPathSchema,
  outputPath: outputPathSchema,
  overwrite: z.boolean().optional(),
})

// 文字戳 schema 控制文本长度、字号、透明度和目标页范围。
export const pdfTextStampSchema = z.object({
  text: z.string().min(1).max(2000),
  page: z.number().int().positive().optional(),
  allPages: z.boolean().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  size: z.number().min(4).max(96).optional(),
  color: z.string().optional(),
  opacity: z.number().min(0).max(1).optional(),
})

// PDF 编辑 schema 汇总页面操作、文字戳和元数据写入。
export const editPdfDocumentSchema = z.object({
  cwd: z.string().optional(),
  inputPath: inputPdfPathSchema,
  outputPath: outputPathSchema,
  overwrite: z.boolean().optional(),
  pageSelection: z.array(z.number().int().positive()).min(1).max(1000).optional(),
  removePages: z.array(z.number().int().positive()).max(1000).optional(),
  rotatePages: z
    .array(
      z.object({
        page: z.number().int().positive(),
        degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]),
      })
    )
    .max(1000)
    .optional(),
  textStamps: z.array(pdfTextStampSchema).max(500).optional(),
  metadata: z
    .object({
      title: z.string().min(1).max(200).optional(),
      author: z.string().min(1).max(120).optional(),
      subject: z.string().min(1).max(300).optional(),
      keywords: z.array(z.string().min(1).max(80)).max(30).optional(),
    })
    .optional(),
})

// LaTeX 源文件路径可选；省略时根据 outputPath 推导出同名 .tex。
export const latexSourcePathSchema = z
  .string()
  .min(1)
  .max(1200)
  .describe(
    parameterDescription({
      description: '可选的 .tex 源文件输出路径。',
      notes: ['省略时与 PDF 同名写在同目录。'],
    })
  )

// LaTeX 生成 PDF 参数校验，同时限制源码长度和编译轮数。
export const createLatexPdfSchema = z.object({
  cwd: z.string().optional(),
  outputPath: outputPathSchema,
  sourcePath: latexSourcePathSchema.optional(),
  latexSource: z
    .string()
    .min(1)
    .max(1_000_000)
    .describe(
      parameterDescription({
        description: '完整 LaTeX 源码。',
        notes: ['工具会写入 .tex 并编译为 PDF。'],
      })
    ),
  compiler: z
    .enum(['auto', 'tectonic', 'latexmk', 'xelatex', 'pdflatex'])
    .optional()
    .describe(
      parameterDescription({
        description: 'LaTeX 编译器选择。',
        values: [
          'auto：按可用性自动尝试。',
          'tectonic：使用 tectonic。',
          'latexmk：使用 latexmk。',
          'xelatex：使用 xelatex。',
          'pdflatex：使用 pdflatex。',
        ],
      })
    ),
  runs: z
    .number()
    .int()
    .min(1)
    .max(3)
    .optional()
    .describe(
      parameterDescription({
        description: 'xelatex 或 pdflatex 编译轮数。',
        notes: ['默认 2；latexmk 和 tectonic 会忽略该值。'],
      })
    ),
  overwrite: z.boolean().optional(),
})

// ─── PDF helpers ───────────────────────────────────────────────────────────────

// 将 #RRGGBB 文本转换成 pdf-lib 的 RGB；非法颜色回退到默认红色。
export function parsePdfColor(input?: string): RGB {
  const hex = (input ?? 'DC2626').replace(/^#/, '').trim()
  const normalized = /^[0-9a-fA-F]{6}$/.test(hex) ? hex : 'DC2626'
  return rgb(
    Number.parseInt(normalized.slice(0, 2), 16) / 255,
    Number.parseInt(normalized.slice(2, 4), 16) / 255,
    Number.parseInt(normalized.slice(4, 6), 16) / 255
  )
}

// 根据选择页和删除页计算最终保留的源页码，页码保持 1-based 便于用户理解。
export function resolvePdfPageNumbers(
  pageCount: number,
  selection?: number[],
  removePages?: number[]
): number[] {
  const removed = new Set(removePages ?? [])
  const rawPages =
    !!selection && !isEmpty(selection)
      ? selection
      : Array.from({ length: pageCount }, (_, index) => index + 1)
  const pages = rawPages.filter((page) => page >= 1 && page <= pageCount && !removed.has(page))
  if (isEmpty(pages)) throw new AppError('VALIDATION', 'PDF 处理后没有剩余页面。')
  return pages
}

// pdfjs 的标准字体路径从包安装位置推导，失败时交给 pdfjs 使用默认策略。
export function getPdfjsStandardFontDataUrl(): string | undefined {
  try {
    const packageJsonPath = requireFromOfficeModule.resolve('pdfjs-dist/package.json')
    return `${dirname(packageJsonPath).replaceAll('\\', '/')}/standard_fonts/`
  } catch (error) {
    log.debug('解析 pdfjs 标准字体数据路径失败', { error })
    return undefined
  }
}

// 使用 pdfjs 逐页提取文本；这里保留页码，后续转 Word 时生成每页标题。
export async function extractPdfTextPages(
  path: string,
  maxPages?: number
): Promise<Array<{ page: number; text: string }>> {
  const pdfjs = await loadPdfjs()
  const bytes = new Uint8Array(await readFile(path))
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    useWorkerFetch: false,
    isEvalSupported: false,
    standardFontDataUrl: getPdfjsStandardFontDataUrl(),
  })
  const document = await loadingTask.promise
  const pageLimit = Math.min(document.numPages, maxPages ?? document.numPages)
  const pages: Array<{ page: number; text: string }> = []
  try {
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      // pdfjs 返回的是文本片段数组，这里压成单行文本，避免 Word 里出现大量碎片空白。
      const text = content.items
        .map((item: { str?: string }) => item.str ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      pages.push({ page: pageNumber, text })
    }
  } finally {
    await document.destroy()
  }
  return pages
}

// 将用户传入的标题、作者、主题和关键词写入输出 PDF。
export function applyPdfMetadata(document: PDFDocument, metadata?: PdfMetadataInput): void {
  if (!metadata) return
  if (metadata.title) document.setTitle(metadata.title)
  if (metadata.author) document.setAuthor(metadata.author)
  if (metadata.subject) document.setSubject(metadata.subject)
  if (!!metadata.keywords && !isEmpty(metadata.keywords)) document.setKeywords(metadata.keywords)
}

// 在指定页面绘制一段文字戳，默认放在页面左下角附近。
export function applyPdfTextStamp(args: {
  page: PDFPage
  stamp: PdfTextStampInput
  font: Awaited<ReturnType<PDFDocument['embedFont']>>
}): void {
  const size = args.stamp.size ?? 14
  args.page.drawText(args.stamp.text, {
    x: args.stamp.x ?? 48,
    y: args.stamp.y ?? 48,
    size,
    font: args.font,
    color: parsePdfColor(args.stamp.color),
    opacity: args.stamp.opacity ?? 0.9,
  })
}

// ─── LaTeX helpers ──────────────────────────────────────────────────────────────

// 未显式指定 sourcePath 时，默认把输出 PDF 同名路径改成 .tex。
export function getDefaultLatexSourcePath(outputPath: string): string {
  const extension = extname(outputPath)
  return extension ? `${outputPath.slice(0, -extension.length)}.tex` : `${outputPath}.tex`
}

// auto 模式按偏好顺序尝试：tectonic 更独立，latexmk 更完整，然后落到 xelatex/pdflatex。
export function resolveLatexCompilerCandidates(compiler?: LatexCompiler): string[] {
  switch (compiler ?? 'auto') {
    case 'tectonic':
      return ['tectonic']
    case 'latexmk':
      return ['latexmk']
    case 'xelatex':
      return ['xelatex']
    case 'pdflatex':
      return ['pdflatex']
    case 'auto':
      return ['tectonic', 'latexmk', 'xelatex', 'pdflatex']
  }
}

// 在当前系统环境中查找实际可用的 LaTeX 编译器。
export async function resolveLatexCompiler(input: {
  ctx: OfficeToolContext
  compiler?: LatexCompiler
}): Promise<Nullable<OfficeEnvironmentCommandAvailability>> {
  return findAvailableCommand(input.ctx, resolveLatexCompilerCandidates(input.compiler))
}

// 按不同编译器生成命令行；xelatex/pdflatex 需要多轮运行来解析引用和目录。
export function buildLatexCompileCommands(input: {
  compiler: OfficeEnvironmentCommandAvailability
  sourceFileName: string
  tempDir: string
  runs?: number
}): string[] {
  const executable = commandExecutable(input.compiler)
  const quotedSource = `'${input.sourceFileName}'`
  const quotedTempDir = `'${input.tempDir}'`

  switch (input.compiler.name) {
    case 'tectonic':
      return [
        [
          executable,
          '--keep-logs',
          '--keep-intermediates',
          '--outdir',
          quotedTempDir,
          quotedSource,
        ].join(' '),
      ]
    case 'latexmk':
      return [
        [
          executable,
          '-pdf',
          '-interaction=nonstopmode',
          '-halt-on-error',
          `-outdir=${quotedTempDir}`,
          quotedSource,
        ].join(' '),
      ]
    case 'xelatex':
    case 'pdflatex': {
      const runCount = input.runs ?? 2
      const command = [
        executable,
        '-interaction=nonstopmode',
        '-halt-on-error',
        `-output-directory=${quotedTempDir}`,
        quotedSource,
      ].join(' ')
      return Array.from({ length: runCount }, () => command)
    }
    default:
      return [
        [
          executable,
          '-interaction=nonstopmode',
          '-halt-on-error',
          `-output-directory=${quotedTempDir}`,
          quotedSource,
        ].join(' '),
      ]
  }
}

// 顺序执行 LaTeX 命令，遇到失败即停止，方便把失败点返回给调用方。
export async function runLatexCompileCommands(input: {
  ctx: OfficeToolContext
  commands: string[]
  cwd: string
}): Promise<OfficeSystemCommandResult[]> {
  const results: OfficeSystemCommandResult[] = []
  for (const command of input.commands) {
    const result = await runOfficeSystemCommand(input.ctx, command, input.cwd, 180_000)
    results.push(result)
    if (!result.success) break
  }
  return results
}
