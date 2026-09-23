/** 解析 docx / pptx / xlsx：Word 交给 mammoth 转语义化 HTML，演示文稿与表格直接读底层结构。 */

import { readFile } from 'node:fs/promises'

import ExcelJS, { type CellValue } from 'exceljs'
import JSZip from 'jszip'
import mammothPackage from 'mammoth'

import { isArray, isPlainObject, isPresent, isString } from '@velaros-ai/core'

import type { PreviewOutlineItem, PreviewSheet, PreviewSlide } from '../../types/office.js'
import type { MammothModule, OfficePreviewKind, ParsedOfficePreview } from '../../types/preview.js'

import { buildSheetPreviewHtml, buildSlidePreviewHtml } from './html.js'
import { countMatches, decodeHtmlText, htmlToText, sanitizePreviewHtml } from './sanitize.js'

/** 静态导入确保独立 Host bundle 收入该依赖；这里只保留工具实际使用的窄接口，避免泄漏 Mammoth 全量 API。 */
export const mammoth = mammothPackage as MammothModule

/** 按文档类型分派到对应的解析器。 */
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

/** 解析 .docx：正文转 HTML 并净化，另外数一遍标题、段落、表格与图片。 */
export async function parseDocxPreview(
  inputPath: string,
  maxItems: number
): Promise<ParsedOfficePreview> {
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
    title: outline[0]?.title ?? paragraphs[0]?.slice(0, 80) ?? 'Word 文档',
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

/** 解析 .pptx：先数全量幻灯片，再按 maxItems 取前几页的标题与要点。 */
export async function parsePptxPreview(
  inputPath: string,
  maxItems: number
): Promise<ParsedOfficePreview> {
  const zip = await JSZip.loadAsync(await readFile(inputPath))
  // 先数全量再截取：summary 报的是文档事实（共几页），previewedSlides 才是本次预览了几页。
  // 两者合一的话，maxItems 一小，模型看到的「共 2 页」就是假的（xlsx 一直是分开报的）。
  const allSlideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(compareOfficeXmlPartNames)
  const slideFiles = allSlideFiles.slice(0, maxItems)

  const slides: PreviewSlide[] = []
  for (const [index, fileName] of slideFiles.entries()) {
    const xml = await zip.file(fileName)?.async('string')
    const texts = xml ? extractDrawingText(xml).filter(Boolean) : []
    slides.push({
      index: index + 1,
      title: texts[0] ?? `第 ${index + 1} 页`,
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
    title: slides[0]?.title ?? '演示文稿',
    summary: {
      slides: allSlideFiles.length,
      previewedSlides: slides.length,
      charts: chartCount,
      images: imageCount,
    },
    slides,
    htmlBody,
  }
}

/** 解析 .xlsx：按 maxItems 取前几张表，每张抽样前若干行列。 */
export async function parseXlsxPreview(
  inputPath: string,
  maxItems: number
): Promise<ParsedOfficePreview> {
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
    title: workbook.title || sheets[0]?.name || '工作簿',
    summary: {
      sheets: workbook.worksheets.length,
      previewedSheets: sheets.length,
    },
    sheets,
    htmlBody,
  }
}

/** 从 HTML 里抽出 h1–h6 的大纲。 */
export function extractHeadingOutline(html: string): PreviewOutlineItem[] {
  return [...html.matchAll(/<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/gi)].map((match) => ({
    level: Number(match[1]),
    title: htmlToText(match[2] ?? '').trim(),
  }))
}

/** 抽出 HTML 里某个标签的纯文本内容。 */
export function extractHtmlTagText(html: string, tagName: string): string[] {
  const expression = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'gi')
  return [...html.matchAll(expression)].map((match) => htmlToText(match[1] ?? '').trim())
}

/** 抽出 DrawingML（幻灯片正文）里的文本片段。 */
export function extractDrawingText(xml: string): string[] {
  return [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((match) =>
    decodeHtmlText(match[1] ?? '').trim()
  )
}

/** 把 ExcelJS 的单元格值压成可展示的文本：日期、公式、富文本各有各的形状。 */
export function cellValueToText(value: CellValue): string {
  if (!isPresent(value)) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (!isPlainObject(value)) return String(value)
  if (isString(value.text)) return value.text
  if (isPresent(value.result)) return cellValueToText(value.result as CellValue)
  if (isString(value.formula)) return `=${value.formula}`
  if (isArray(value.richText))
    return value.richText
      .map((part) => (isPlainObject(part) ? String(part.text ?? '') : ''))
      .join('')
  return JSON.stringify(value)
}

/** 按部件名里的序号排序，slide2.xml 排在 slide10.xml 前面。 */
export function compareOfficeXmlPartNames(a: string, b: string): number {
  return getOfficePartNumber(a) - getOfficePartNumber(b)
}

/** 取部件名末尾的序号。 */
export function getOfficePartNumber(name: string): number {
  return Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0)
}
