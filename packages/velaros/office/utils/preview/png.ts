/** 预览图渲染：把解析结果画成一张 PNG，给不方便开 HTML 的地方看。 */

import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas'

import { isEmpty } from '@velaros-ai/core'

import type { ParsedOfficePreview, RenderedOfficePreviewPng } from '../../types/preview.js'
import { OfficeTuning } from '../tuning.js'

import { htmlToText, truncateText } from './sanitize.js'

/** 把解析结果画成一张预览 PNG：顶部类型与标题，下面按文档类型排表格行或大纲行。 */
export async function renderOfficePreviewPng(
  parsed: ParsedOfficePreview
): Promise<RenderedOfficePreviewPng> {
  const width = OfficeTuning.preview.imageWidth
  const padding = OfficeTuning.preview.imagePadding
  const rows = previewImageRows(parsed)
  const height = Math.max(
    OfficeTuning.preview.imageMinHeight,
    Math.min(
      OfficeTuning.preview.imageMaxHeight,
      OfficeTuning.preview.imageHeaderHeight + rows.length * OfficeTuning.preview.imageRowHeight
    )
  )
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')

  context.fillStyle = '#eef2f6'
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#ffffff'
  context.fillRect(padding, padding, width - padding * 2, height - padding * 2)
  context.fillStyle = '#286f6c'
  context.font = '700 18px "PingFang SC", "Microsoft YaHei", sans-serif'
  context.fillText(`${parsed.kind.toUpperCase()} 预览`, 88, 104)
  context.fillStyle = '#172033'
  context.font = '700 34px "PingFang SC", "Microsoft YaHei", sans-serif'
  context.fillText(truncateText(parsed.title, 48), 88, 154, width - 176)

  if (parsed.kind === 'xlsx') renderSpreadsheetPreviewRows(context, rows, 88, 194)
  else renderDocumentPreviewRows(context, rows, 88, 204)

  return {
    buffer: canvas.toBuffer('image/png'),
    width,
    height,
  }
}

/** 按文档类型挑出要画进预览图的那几行。 */
function previewImageRows(parsed: ParsedOfficePreview): string[][] {
  const maxRows = OfficeTuning.preview.imageRows
  if (parsed.kind === 'xlsx') {
    const sheet = parsed.sheets?.[0]
    return sheet?.rows.slice(0, maxRows) ?? []
  }
  if (parsed.kind === 'pptx')
    return (parsed.slides ?? [])
      .slice(0, 16)
      .map((slide) => [`第 ${slide.index} 页`, slide.title, slide.bullets.join(' · ')])
  const outline = (parsed.outline ?? [])
    .slice(0, maxRows)
    .map((item) => [`H${item.level ?? 1}`, item.title])
  return !isEmpty(outline) ? outline : [[truncateText(htmlToText(parsed.htmlBody).trim(), 240)]]
}

/** 把表格数据画成带网格线的行，首行当表头。 */
function renderSpreadsheetPreviewRows(
  context: SKRSContext2D,
  rows: readonly string[][],
  x: number,
  y: number
): void {
  const canvasWidth = OfficeTuning.preview.imageWidth
  const rowHeight = OfficeTuning.preview.imageRowHeight
  const columnCount = Math.max(1, ...rows.map((row) => row.length))
  const width = canvasWidth - x * 2
  const columnWidth = width / columnCount
  const visibleRows = rows.slice(0, OfficeTuning.preview.imageRows)

  for (const [rowIndex, row] of visibleRows.entries()) {
    const rowY = y + rowIndex * rowHeight
    context.fillStyle = rowIndex === 0 ? '#e7f2f1' : rowIndex % 2 === 0 ? '#f8fafc' : '#ffffff'
    context.fillRect(x, rowY, width, rowHeight)
    context.strokeStyle = '#d8dee8'
    context.strokeRect(x, rowY, width, rowHeight)
    context.font = `${rowIndex === 0 ? '700' : '400'} 18px "PingFang SC", "Microsoft YaHei", sans-serif`
    context.fillStyle = '#172033'
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const cellX = x + columnIndex * columnWidth
      if (columnIndex > 0) {
        context.beginPath()
        context.moveTo(cellX, rowY)
        context.lineTo(cellX, rowY + rowHeight)
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

/** 把大纲或幻灯片标题画成左右两列的斑马行。 */
function renderDocumentPreviewRows(
  context: SKRSContext2D,
  rows: readonly string[][],
  x: number,
  y: number
): void {
  const canvasWidth = OfficeTuning.preview.imageWidth
  const rowHeight = OfficeTuning.preview.imageRowHeight
  context.font = '400 19px "PingFang SC", "Microsoft YaHei", sans-serif'
  for (const [index, row] of rows.slice(0, OfficeTuning.preview.imageRows).entries()) {
    const rowY = y + index * rowHeight
    context.fillStyle = index % 2 === 0 ? '#f8fafc' : '#ffffff'
    context.fillRect(x, rowY, canvasWidth - x * 2, rowHeight - 6)
    context.fillStyle = '#667085'
    context.fillText(truncateText(row[0] ?? '', 18), x + 14, rowY + 31, 160)
    context.fillStyle = '#172033'
    context.fillText(
      truncateText(row.slice(1).join(' — ') || row[0] || '', 100),
      x + 174,
      rowY + 31,
      canvasWidth - x * 2 - 190
    )
  }
}
