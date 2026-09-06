/**
 * Office 文档解析与 HTML 预览工具。
 * Word 预览委托给成熟的转换库，演示文稿和表格则读取文档结构
 * 生成摘要，给模型和浏览器预览使用。
 */
import { readFile } from 'node:fs/promises'

import type { SKRSContext2D } from '@napi-rs/canvas'
import ExcelJS, { type CellValue } from 'exceljs'
import JSZip from 'jszip'
import mammothPackage from 'mammoth'
import { type DefaultTreeAdapterTypes, parseFragment, serialize } from 'parse5'
import { z } from 'zod'

import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/agent/tool-contract'
import {
  isArray,
  isEmpty,
  isPlainObject,
  isPresent,
  isString,
  isUndefined,
} from '@velaros-ai/core'

import {
  AppError,
  buildMissingSystemToolResult,
  createBrowserOnlineAlternative,
  createCommandFailureResult,
  extname,
  getFileStats,
  type NormalizedWordInput,
  normalizeWordInputToDocx,
  type OfficeToolContext,
  outputPathSchema,
  prepareOfficeOutputPath,
  resolveLibreOfficeCommand,
  rm,
  writeFile,
} from './officeShared'

export type OfficePreviewKind = 'docx' | 'pptx' | 'xlsx'

export type PreviewOfficeDocumentInput = {
  cwd?: string
  inputPath: string
  outputPath?: string
  overwrite?: boolean
  maxItems?: number
  autoRefresh?: boolean
}

export type OfficePreviewArtifact = {
  path: string
  bytes: number
  created: boolean
  changed: true
  kind: 'html' | 'png'
  width?: number
  height?: number
}

export type MammothMessage = {
  type: string
  message: string
}

export type MammothModule = {
  convertToHtml: (
    input: { path: string },
    options?: Record<string, unknown>
  ) => Promise<{ value: string; messages: MammothMessage[] }>
}

export type PreviewOutlineItem = {
  level?: number
  title: string
}

export type PreviewSlide = {
  index: number
  title: string
  bullets: string[]
}

export type PreviewSheet = {
  name: string
  rowCount: number
  columnCount: number
  rows: string[][]
}

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

export const previewOfficeDocumentSchema = z.object({
  cwd: z.string().optional(),
  inputPath: z
    .string()
    .min(1)
    .max(1200)
    .describe(
      parameterDescription({
        description: '输入 Office 文件路径。',
        usage: ['支持 .docx、.doc、.pptx、.xlsx，也支持相对当前工作区的路径。'],
      })
    ),
  outputPath: outputPathSchema
    .optional()
    .describe(
      parameterDescription({
        description: '可选预览输出路径，支持 .html 或 .png。',
        notes: ['无扩展名时自动补齐 .html；需要静态预览图时显式使用 .png。'],
      })
    ),
  overwrite: z.boolean().optional(),
  maxItems: z.number().int().min(1).max(200).optional(),
  autoRefresh: z
    .boolean()
    .optional()
    .describe(
      parameterDescription({
        description: '生成 HTML 预览时是否加入自动刷新脚本。',
        usage: ['便于在浏览器中查看最新预览。'],
      })
    ),
})

// 静态导入确保独立 Host bundle 收入该依赖；这里仅保留工具实际使用的窄接口，避免泄漏 Mammoth 全量 API。
export const mammoth = mammothPackage as MammothModule

export async function normalizePreviewInput(
  ctx: OfficeToolContext,
  inputPath: string
): Promise<
  | { success: true; path: string; kind: OfficePreviewKind; wordInput?: NormalizedWordInput }
  | { success: false; result: Record<string, unknown> }
> {
  const extension = extname(inputPath).toLowerCase()
  switch (extension) {
    case '.pptx':
      return { success: true, path: inputPath, kind: 'pptx' }
    case '.xlsx':
      return { success: true, path: inputPath, kind: 'xlsx' }
    case '.docx':
      return {
        success: true,
        path: inputPath,
        kind: 'docx',
        wordInput: {
          path: inputPath,
          originalPath: inputPath,
          sourceExtension: '.docx',
          convertedFromLegacyDoc: false,
          tempDir: null,
        },
      }
  }

  const libreOffice = await resolveLibreOfficeCommand(ctx)
  if (!libreOffice) return {
      success: false,
      result: buildMissingSystemToolResult({
        ctx,
        command: 'soffice',
        reason: '需要使用 LibreOffice headless 将旧版 .doc 转换为 .docx 后再解析预览。',
        message: '当前 shell 未找到 soffice/libreoffice，暂时无法预览旧版 .doc 文档。',
        alternatives: [
          createBrowserOnlineAlternative({
            zhDescription:
              '不安装本机 LibreOffice，改用 Browser Use 打开在线 DOC 转 DOCX/预览服务；上传本地文件前会先确认目标网站和隐私风险。',
            enDescription:
              'Skip local LibreOffice and use Browser Use with an online DOC-to-DOCX or preview service; confirm the target site and privacy risk before uploading files.',
            zhDraft:
              '我暂时不安装 LibreOffice。请改用 Browser Use 的线上流程继续刚才的 DOC 预览任务；如果需要上传本地 Word 文件到第三方网站，请先告诉我目标网站和隐私风险，等我确认后再操作。',
            enDraft:
              'I do not want to install LibreOffice right now. Please use the Browser Use online workflow for the previous DOC preview task. If you need to upload my local Word file to a third-party site, tell me the target site and privacy risk first and wait for confirmation.',
          }),
        ],
      }),
    }

  const normalized = await normalizeWordInputToDocx({
    ctx,
    inputPath,
    libreOffice,
    timeoutMs: 180_000,
  })
  if (!normalized.success) {
    if (normalized.tempDir) {
      await cleanupTempDir(normalized.tempDir)
    }
    return {
      success: false,
      result: createCommandFailureResult({
        outputPath: inputPath,
        kind: 'docx',
        operation: 'DOC 转 DOCX 预处理',
        commandResult: normalized.commandResult,
      }),
    }
  }

  return {
    success: true,
    path: normalized.input.path,
    kind: 'docx',
    wordInput: normalized.input,
  }
}

export async function parseOfficePreview(
  inputPath: string,
  kind: OfficePreviewKind,
  maxItems: number
): Promise<ParsedOfficePreview> {
  switch (kind) {
    case 'docx':
      return parseDocxPreview(inputPath, maxItems)
    case 'pptx':
      return parsePptxPreview(inputPath, maxItems)
    case 'xlsx':
      return parseXlsxPreview(inputPath, maxItems)
  }
}

export async function parseDocxPreview(inputPath: string, maxItems: number): Promise<ParsedOfficePreview> {
  const conversion = await mammoth.convertToHtml(
    { path: inputPath },
    {
      includeDefaultStyleMap: true,
      styleMap: [
        "p[style-name='Title'] => h1:fresh",
        "p[style-name='Subtitle'] => p.subtitle:fresh",
        "p[style-name='Abstract'] => section.abstract > p:fresh",
      ],
    }
  )
  const htmlBody = sanitizePreviewHtml(conversion.value)
  const outline = extractHeadingOutline(htmlBody).slice(0, maxItems)
  const paragraphs = extractHtmlTagText(htmlBody, 'p').filter(Boolean)
  const zip = await JSZip.loadAsync(await readFile(inputPath))
  const documentXml = await zip.file('word/document.xml')?.async('string')
  const tableCount = documentXml ? countMatches(documentXml, /<w:tbl[\s>]/g) : 0
  const imageCount = zip.file(/^word\/media\//).length

  return {
    kind: 'docx',
    title: outline[0]?.title ?? paragraphs[0]?.slice(0, 80) ?? 'Word Document',
    summary: {
      headings: outline.length,
      paragraphs: paragraphs.length,
      tables: tableCount,
      images: imageCount,
      messages: conversion.messages.length,
    },
    outline,
    htmlBody,
    messages: conversion.messages,
  }
}

export async function parsePptxPreview(inputPath: string, maxItems: number): Promise<ParsedOfficePreview> {
  const zip = await JSZip.loadAsync(await readFile(inputPath))
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(compareOfficeXmlPartNames)
    .slice(0, maxItems)

  const slides: PreviewSlide[] = []
  for (const [index, fileName] of slideFiles.entries()) {
    const xml = await zip.file(fileName)?.async('string')
    const texts = xml ? extractDrawingText(xml).filter(Boolean) : []
    slides.push({
      index: index + 1,
      title: texts[0] ?? `Slide ${index + 1}`,
      bullets: texts.slice(1, 8),
    })
  }

  const chartCount = zip.file(/^ppt\/charts\/chart\d+\.xml$/).length
  const imageCount = zip.file(/^ppt\/media\//).length
  const htmlBody = [
    '<div class="slide-grid">',
    ...slides.map((slide) => buildSlidePreviewHtml(slide)),
    '</div>',
  ].join('\n')

  return {
    kind: 'pptx',
    title: slides[0]?.title ?? 'Presentation',
    summary: {
      slides: slides.length,
      charts: chartCount,
      images: imageCount,
    },
    slides,
    htmlBody,
  }
}

export async function parseXlsxPreview(inputPath: string, maxItems: number): Promise<ParsedOfficePreview> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(inputPath)
  const sheets: PreviewSheet[] = []
  const maxSheets = Math.min(workbook.worksheets.length, maxItems)

  for (const worksheet of workbook.worksheets.slice(0, maxSheets)) {
    const rows: string[][] = []
    const rowLimit = Math.min(worksheet.rowCount, 18)
    const columnLimit = Math.min(worksheet.columnCount, 10)
    for (let rowIndex = 1; rowIndex <= rowLimit; rowIndex++) {
      const row = worksheet.getRow(rowIndex)
      const values: string[] = []
      for (let columnIndex = 1; columnIndex <= columnLimit; columnIndex++) {
        values.push(cellValueToText(row.getCell(columnIndex).value))
      }
      rows.push(values)
    }
    sheets.push({
      name: worksheet.name,
      rowCount: worksheet.rowCount,
      columnCount: worksheet.columnCount,
      rows,
    })
  }

  const htmlBody = sheets.map((sheet) => buildSheetPreviewHtml(sheet)).join('\n')
  return {
    kind: 'xlsx',
    title: workbook.title || sheets[0]?.name || 'Workbook',
    summary: {
      sheets: workbook.worksheets.length,
      previewedSheets: sheets.length,
    },
    sheets,
    htmlBody,
  }
}

export async function writeOfficePreview(
  ctx: OfficeToolContext,
  outputPath: string,
  html: string,
  parsed: ParsedOfficePreview,
  overwrite?: boolean
): Promise<OfficePreviewArtifact> {
  const requestedExtension = extname(outputPath).toLowerCase()
  const extension = requestedExtension || '.html'
  if (extension !== '.html' && extension !== '.png') {
    throw new AppError('VALIDATION', 'Office 预览输出文件扩展名必须是 .html 或 .png。')
  }
  const prepared = await prepareOfficeOutputPath(ctx, outputPath, extension, overwrite)
  const image = extension === '.png' ? await renderOfficePreviewPng(parsed) : null
  if (image) await writeFile(prepared.path, image.buffer)
  else await writeFile(prepared.path, html, 'utf8')
  const stats = await getFileStats(prepared.path)
  return {
    path: prepared.path,
    bytes: stats ? Number(stats.size) : (image?.buffer.byteLength ?? Buffer.byteLength(html)),
    created: prepared.created,
    changed: true,
    kind: extension === '.png' ? 'png' : 'html',
    ...(image ? { width: image.width, height: image.height } : {}),
  }
}

const PreviewImageWidth = 1200
const PreviewImagePadding = 56
const PreviewImageRowHeight = 54

export async function renderOfficePreviewPng(
  parsed: ParsedOfficePreview
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const { createCanvas } = await import('@napi-rs/canvas')
  const rows = previewImageRows(parsed)
  const height = Math.max(420, Math.min(1800, 238 + rows.length * PreviewImageRowHeight))
  const canvas = createCanvas(PreviewImageWidth, height)
  const context = canvas.getContext('2d')

  context.fillStyle = '#eef2f6'
  context.fillRect(0, 0, PreviewImageWidth, height)
  context.fillStyle = '#ffffff'
  context.fillRect(
    PreviewImagePadding,
    PreviewImagePadding,
    PreviewImageWidth - PreviewImagePadding * 2,
    height - PreviewImagePadding * 2
  )
  context.fillStyle = '#286f6c'
  context.font = '700 18px "PingFang SC", "Microsoft YaHei", sans-serif'
  context.fillText(`${parsed.kind.toUpperCase()} PREVIEW`, 88, 104)
  context.fillStyle = '#172033'
  context.font = '700 34px "PingFang SC", "Microsoft YaHei", sans-serif'
  context.fillText(truncateText(parsed.title, 48), 88, 154, PreviewImageWidth - 176)

  if (parsed.kind === 'xlsx') renderSpreadsheetPreviewRows(context, rows, 88, 194)
  else renderDocumentPreviewRows(context, rows, 88, 204)

  return {
    buffer: canvas.toBuffer('image/png'),
    width: PreviewImageWidth,
    height,
  }
}

function previewImageRows(parsed: ParsedOfficePreview): string[][] {
  if (parsed.kind === 'xlsx') {
    const sheet = parsed.sheets?.[0]
    return sheet?.rows.slice(0, 18) ?? []
  }
  if (parsed.kind === 'pptx') return (parsed.slides ?? []).slice(0, 16).map((slide) => [
      `Slide ${slide.index}`,
      slide.title,
      slide.bullets.join(' · '),
    ])
  const outline = (parsed.outline ?? []).slice(0, 18).map((item) => [
    `H${item.level ?? 1}`,
    item.title,
  ])
  return !isEmpty(outline) ? outline : [[truncateText(htmlToText(parsed.htmlBody).trim(), 240)]]
}

function renderSpreadsheetPreviewRows(
  context: SKRSContext2D,
  rows: readonly string[][],
  x: number,
  y: number
): void {
  const columnCount = Math.max(1, ...rows.map((row) => row.length))
  const width = PreviewImageWidth - x * 2
  const columnWidth = width / columnCount
  const visibleRows = rows.slice(0, 18)

  for (const [rowIndex, row] of visibleRows.entries()) {
    const rowY = y + rowIndex * PreviewImageRowHeight
    context.fillStyle = rowIndex === 0 ? '#e7f2f1' : rowIndex % 2 === 0 ? '#f8fafc' : '#ffffff'
    context.fillRect(x, rowY, width, PreviewImageRowHeight)
    context.strokeStyle = '#d8dee8'
    context.strokeRect(x, rowY, width, PreviewImageRowHeight)
    context.font = `${rowIndex === 0 ? '700' : '400'} 18px "PingFang SC", "Microsoft YaHei", sans-serif`
    context.fillStyle = '#172033'
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const cellX = x + columnIndex * columnWidth
      if (columnIndex > 0) {
        context.beginPath()
        context.moveTo(cellX, rowY)
        context.lineTo(cellX, rowY + PreviewImageRowHeight)
        context.stroke()
      }
      context.fillText(
        truncateText(row[columnIndex] ?? '', 42),
        cellX + 14,
        rowY + 34,
        columnWidth - 28
      )
    }
  }
}

function renderDocumentPreviewRows(
  context: SKRSContext2D,
  rows: readonly string[][],
  x: number,
  y: number
): void {
  context.font = '400 19px "PingFang SC", "Microsoft YaHei", sans-serif'
  for (const [index, row] of rows.slice(0, 18).entries()) {
    const rowY = y + index * PreviewImageRowHeight
    context.fillStyle = index % 2 === 0 ? '#f8fafc' : '#ffffff'
    context.fillRect(x, rowY, PreviewImageWidth - x * 2, PreviewImageRowHeight - 6)
    context.fillStyle = '#667085'
    context.fillText(truncateText(row[0] ?? '', 18), x + 14, rowY + 31, 160)
    context.fillStyle = '#172033'
    context.fillText(
      truncateText(row.slice(1).join(' — ') || row[0] || '', 100),
      x + 174,
      rowY + 31,
      PreviewImageWidth - x * 2 - 190
    )
  }
}

export function buildOfficePreviewHtml(input: {
  parsed: ParsedOfficePreview
  inputPath: string
  normalizedInput: Nullable<NormalizedWordInput>
  autoRefresh: boolean
}): string {
  const normalizedNotice = input.normalizedInput?.convertedFromLegacyDoc
    ? `<p class="notice">Legacy .doc was normalized to .docx for parsing with ${escapeHtml(
        input.normalizedInput.converter ?? 'LibreOffice'
      )}.</p>`
    : ''
  const autoRefreshScript = input.autoRefresh
    ? `<script>setInterval(function(){ if(!document.hidden) location.reload(); }, 5000);</script>`
    : ''

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(input.parsed.title)} · Office Preview</title>`,
    '<style>',
    buildPreviewCss(),
    '</style>',
    '</head>',
    '<body>',
    '<main class="page">',
    '<header class="preview-header">',
    `<p class="eyebrow">${escapeHtml(input.parsed.kind.toUpperCase())} preview</p>`,
    `<h1>${escapeHtml(input.parsed.title)}</h1>`,
    `<p class="path">${escapeHtml(input.inputPath)}</p>`,
    normalizedNotice,
    buildSummaryHtml(input.parsed.summary),
    '</header>',
    '<section class="document-surface">',
    input.parsed.htmlBody || '<p>No previewable content found.</p>',
    '</section>',
    '</main>',
    autoRefreshScript,
    '</body>',
    '</html>',
  ].join('\n')
}

export function buildPreviewCss(): string {
  return `
:root {
  color-scheme: light;
  --paper: #ffffff;
  --ink: #172033;
  --muted: #667085;
  --line: #d8dee8;
  --soft: #f4f7fb;
  --accent: #286f6c;
  --accent-2: #8c4a2f;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #eef2f6;
  color: var(--ink);
  font-family: Inter, "Aptos", "Segoe UI", system-ui, sans-serif;
  line-height: 1.55;
}
.page { max-width: 1120px; margin: 0 auto; padding: 32px 20px 56px; }
.preview-header {
  border-bottom: 1px solid var(--line);
  margin-bottom: 24px;
  padding-bottom: 18px;
}
.eyebrow {
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0;
  margin: 0 0 8px;
  text-transform: uppercase;
}
h1 { font-size: 34px; line-height: 1.16; margin: 0 0 8px; }
h2 { font-size: 24px; margin: 28px 0 10px; }
h3 { font-size: 19px; margin: 22px 0 8px; }
.path, .notice { color: var(--muted); font-size: 13px; margin: 4px 0; overflow-wrap: anywhere; }
.notice { color: var(--accent-2); }
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}
.summary span {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--soft);
  color: #344054;
  font-size: 12px;
  padding: 5px 8px;
}
.document-surface {
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 16px 36px rgba(23, 32, 51, 0.08);
  padding: 34px;
}
.document-surface p { margin: 0 0 12px; }
.document-surface table {
  width: 100%;
  border-collapse: collapse;
  margin: 14px 0 22px;
  font-size: 14px;
}
.document-surface th, .document-surface td {
  border: 1px solid var(--line);
  padding: 8px 10px;
  text-align: left;
  vertical-align: top;
}
.document-surface th { background: var(--soft); font-weight: 700; }
.slide-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}
.slide-preview {
  aspect-ratio: 16 / 9;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: linear-gradient(135deg, #ffffff 0%, #f7fafc 100%);
  padding: 18px;
  overflow: hidden;
}
.slide-preview .slide-number { color: var(--accent); font-size: 12px; font-weight: 700; }
.slide-preview h2 { font-size: 20px; margin: 8px 0 10px; }
.slide-preview ul { margin: 0; padding-left: 18px; color: #344054; }
.sheet-preview { margin-bottom: 30px; }
@media (max-width: 720px) {
  .page { padding: 20px 12px 36px; }
  .document-surface { padding: 20px 14px; }
  h1 { font-size: 27px; }
}
`
}

export function buildSummaryHtml(summary: Record<string, unknown>): string {
  const items = Object.entries(summary)
    .filter(([, value]) => isPresent(value))
    .map(
      ([key, value]) => `<span>${escapeHtml(humanizeKey(key))}: ${escapeHtml(String(value))}</span>`
    )
    .join('')
  return items ? `<div class="summary">${items}</div>` : ''
}

export function buildSlidePreviewHtml(slide: PreviewSlide): string {
  return [
    '<article class="slide-preview">',
    `<div class="slide-number">Slide ${slide.index}</div>`,
    `<h2>${escapeHtml(slide.title)}</h2>`,
    !isEmpty(slide.bullets)
      ? `<ul>${slide.bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '',
    '</article>',
  ].join('\n')
}

export function buildSheetPreviewHtml(sheet: PreviewSheet): string {
  return [
    '<section class="sheet-preview">',
    `<h2>${escapeHtml(sheet.name)}</h2>`,
    `<p class="path">${sheet.rowCount} rows · ${sheet.columnCount} columns</p>`,
    '<table>',
    '<tbody>',
    ...sheet.rows.map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(truncateText(cell, 120))}</td>`).join('')}</tr>`
    ),
    '</tbody>',
    '</table>',
    '</section>',
  ].join('\n')
}

export function extractHeadingOutline(html: string): PreviewOutlineItem[] {
  return [...html.matchAll(/<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/gi)].map((match) => ({
    level: Number(match[1]),
    title: htmlToText(match[2] ?? '').trim(),
  }))
}

export function extractHtmlTagText(html: string, tagName: string): string[] {
  const expression = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'gi')
  return [...html.matchAll(expression)].map((match) => htmlToText(match[1] ?? '').trim())
}

export function extractDrawingText(xml: string): string[] {
  return [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((match) =>
    decodeXmlText(match[1] ?? '').trim()
  )
}

export function cellValueToText(value: CellValue): string {
  if (!isPresent(value)) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (!isPlainObject(value)) return String(value)
  if (isString(value.text)) return value.text
  if (isPresent(value.result)) return cellValueToText(value.result as CellValue)
  if (isString(value.formula)) return `=${value.formula}`
  if (isArray(value.richText))
    return value.richText.map((part) => (isPlainObject(part) ? String(part.text ?? '') : '')).join('')
  return JSON.stringify(value)
}

export function compareOfficeXmlPartNames(a: string, b: string): number {
  return getOfficePartNumber(a) - getOfficePartNumber(b)
}

export function getOfficePartNumber(name: string): number {
  return Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0)
}

const PreviewAllowedTags = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's', 'section',
  'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'u', 'ul',
])
const PreviewDropWithContentTags = new Set([
  'applet', 'audio', 'base', 'embed', 'form', 'frame', 'frameset', 'iframe', 'input',
  'link', 'math', 'meta', 'noscript', 'object', 'script', 'style', 'svg', 'template',
  'video',
])
const PreviewAllowedClasses = new Set(['abstract', 'subtitle'])
const PreviewRasterDataMimeTypes = new Set(['gif', 'jpeg', 'png', 'webp'])
const MaxPreviewImageDataUrlChars = 8 * 1024 * 1024

function isSafePreviewRasterDataUrl(value: string): boolean {
  if (value.length > MaxPreviewImageDataUrlChars) return false
  const comma = value.indexOf(',')
  if (comma < 0) return false
  const metadata = value.slice(0, comma).toLowerCase()
  const mimePrefix = 'data:image/'
  const suffix = ';base64'
  if (!metadata.startsWith(mimePrefix) || !metadata.endsWith(suffix)) return false
  const mimeType = metadata.slice(mimePrefix.length, -suffix.length)
  if (!PreviewRasterDataMimeTypes.has(mimeType)) return false

  const payload = value.slice(comma + 1)
  if (!payload || payload.length % 4 !== 0) return false
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  for (let index = 0; index < payload.length - padding; index += 1) {
    const code = payload.charCodeAt(index)
    const isBase64Character = (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || code === 43
      || code === 47
    if (!isBase64Character) return false
  }
  for (let index = payload.length - padding; index < payload.length; index += 1) {
    if (payload[index] !== '=') return false
  }
  return true
}

function isSafePreviewDimension(value: string): boolean {
  if (!/^\d{1,4}$/u.test(value)) return false
  const dimension = Number(value)
  return dimension >= 1 && dimension <= 8192
}

function isSafePreviewClassList(value: string): boolean {
  const tokens = value.trim().split(/\s+/u)
  return !isEmpty(tokens) && tokens.every((token) => PreviewAllowedClasses.has(token))
}

function isSafePreviewHref(value: string): boolean {
  const normalized = value.trim()
  if (!normalized) return false
  if (normalized.startsWith('#')) return true
  if (!URL.canParse(normalized)) return false
  const parsed = new URL(normalized)
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:'
}

function sanitizePreviewChildren(parent: DefaultTreeAdapterTypes.ParentNode): void {
  for (let index = 0; index < parent.childNodes.length;) {
    const node = parent.childNodes[index]
    if (!node) break

    if (node.nodeName === '#comment' || node.nodeName === '#documentType') {
      parent.childNodes.splice(index, 1)
      continue
    }
    if (node.nodeName === '#text') {
      index += 1
      continue
    }

    const element = node as DefaultTreeAdapterTypes.Element
    const tagName = element.tagName.toLowerCase()
    if (PreviewDropWithContentTags.has(tagName)) {
      parent.childNodes.splice(index, 1)
      continue
    }
    if (tagName === 'img') {
      const source = element.attrs.find((attribute) => attribute.name.toLowerCase() === 'src')
      if (!source || !isSafePreviewRasterDataUrl(source.value)) {
        parent.childNodes.splice(index, 1)
        continue
      }
    }

    sanitizePreviewChildren(element)
    if (!PreviewAllowedTags.has(tagName)) {
      for (const child of element.childNodes) child.parentNode = parent
      parent.childNodes.splice(index, 1, ...element.childNodes)
      index += element.childNodes.length
      continue
    }

    element.attrs = element.attrs.filter((attribute) => {
      const name = attribute.name.toLowerCase()
      if (name === 'class') return isSafePreviewClassList(attribute.value)
      if (tagName === 'a' && name === 'href') return isSafePreviewHref(attribute.value)
      if (tagName === 'a' && name === 'title') return true
      if (tagName === 'img' && name === 'src') return isSafePreviewRasterDataUrl(attribute.value)
      if (tagName === 'img' && (name === 'alt' || name === 'title')) return true
      if (tagName === 'img' && (name === 'width' || name === 'height'))
        return isSafePreviewDimension(attribute.value)
      if ((tagName === 'td' || tagName === 'th') && (name === 'colspan' || name === 'rowspan'))
        return /^\d{1,3}$/u.test(attribute.value)
      return false
    })
    index += 1
  }
}

/** Parse and allowlist Mammoth HTML before writing a browser-openable preview. */
export function sanitizePreviewHtml(html: string): string {
  const fragment = parseFragment(html)
  sanitizePreviewChildren(fragment)
  return serialize(fragment)
}

export function htmlToText(html: string): string {
  const fragment = parseFragment(html)
  const parts: string[] = []
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if (node.nodeName === '#text') {
      parts.push((node as DefaultTreeAdapterTypes.TextNode).value)
      return
    }
    if ('childNodes' in node) {
      parts.push(' ')
      for (const child of node.childNodes) visit(child)
      parts.push(' ')
    }
  }
  visit(fragment)
  return parts.join(' ')
}

export function decodeHtmlText(text: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: '\u00a0', quot: '"',
  }
  let decoded = ''
  for (let index = 0; index < text.length;) {
    if (text[index] !== '&') {
      decoded += text[index]
      index += 1
      continue
    }

    const end = text.indexOf(';', index + 1)
    if (end < 0 || end - index > 12) {
      decoded += '&'
      index += 1
      continue
    }

    const entity = text.slice(index + 1, end)
    let replacement = namedEntities[entity]
    if (!replacement && entity.startsWith('#')) {
      const hexadecimal = entity[1]?.toLowerCase() === 'x'
      const digits = entity.slice(hexadecimal ? 2 : 1)
      const validDigits = hexadecimal ? /^[0-9a-f]+$/iu.test(digits) : /^\d+$/u.test(digits)
      if (validDigits) {
        const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10)
        replacement = codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
          ? String.fromCodePoint(codePoint)
          : '\ufffd'
      }
    }

    if (isUndefined(replacement)) {
      decoded += '&'
      index += 1
      continue
    }
    decoded += replacement
    index = end + 1
  }
  return decoded
}

export const decodeXmlText = decodeHtmlText

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

export function countMatches(text: string, expression: RegExp): number {
  return [...text.matchAll(expression)].length
}

export function humanizeKey(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (first) => first.toUpperCase())
}

export async function cleanupTempDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined /* arch-guard:silent-catch-ok 尽力清理临时目录，删除失败非致命 */)
}
