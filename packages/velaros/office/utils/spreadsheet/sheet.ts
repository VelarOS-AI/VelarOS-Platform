/** 写工作表用的原语：表名归一、单元格取值、数字格式区域、自动列宽。 */

import type { Workbook, Worksheet } from 'exceljs'

import {
  isEmpty,
  isPlainObject,
  isPresent,
  isString,
  optionalWhenLazy,
  toNullable,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { OfficeInputLimits } from '../../contract/constants.js'
import type { ExcelCellInput, SpreadsheetSheetInput } from '../../types/office.js'
import type { ExcelCellBuildResult } from '../../types/spreadsheet.js'

import { buildExcelCellStyle, toArgbColor } from './style.js'

/** 单元格地址或区域，例如 B2 或 B2:D10。 */
const ExcelAddressPattern = /^([A-Z]+)([1-9]\d*)(?::([A-Z]+)([1-9]\d*))?$/iu

/** Excel 工作表名不能包含部分特殊字符，且长度有格式上限。 */
export function normalizeSheetName(name: string, index: number): string {
  return (name.replaceAll(/[*?:/\\[\]]/g, '-').trim() || `Sheet ${index + 1}`).slice(
    0,
    OfficeInputLimits.spreadsheet.sheetNameChars
  )
}

/** 把列名（A、AB）换算成 1 起的列号。 */
export function excelColumnNumber(name: string): number {
  let value = 0
  for (const char of name.toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64
  return value
}

/** 将一个工具层单元格转换为 ExcelJS 能写入的值和样式。 */
export function buildExcelCellValue(cell: ExcelCellInput): ExcelCellBuildResult {
  if (!isPresent(cell) || !isPlainObject(cell)) {
    // 简单字符串以 = 开头时按公式写入，保持用户常见的 Excel 输入习惯。
    if (isString(cell) && cell.startsWith('=') && cell.length > 1)
      return { excelValue: { formula: cell.slice(1) }, cellStyle: {} }
    return { excelValue: cell, cellStyle: {} }
  }
  const obj = cell
  // 对象单元格先累积样式，再根据值类型决定实际写入内容。
  const cellStyle = buildExcelCellStyle(obj)

  let excelValue: ExcelCellBuildResult['excelValue']
  if (!!obj.richText && !isEmpty(obj.richText)) {
    // 富文本会把每段文字及其字体单独传给 ExcelJS。
    excelValue = {
      richText: obj.richText.map((rt) => ({
        text: rt.text,
        font: optionalWhenLazy(rt.font, () => ({
          name: rt.font!.name,
          size: rt.font!.size,
          bold: rt.font!.bold,
          italic: rt.font!.italic,
          color: optionalWhenLazy(rt.font!.color, () => ({ argb: toArgbColor(rt.font!.color!) })),
        })),
      })),
    }
  } else if (obj.formula) {
    excelValue = { formula: obj.formula }
  } else if (obj.dateValue) {
    excelValue = new Date(obj.dateValue)
  } else {
    excelValue = toNullable(obj.value)
  }
  const link = optionalWhenLazy(obj.link, () => ({ hyperlink: obj.link!, tooltip: obj.tooltip }))
  return {
    excelValue,
    cellStyle,
    rowHeight: obj.rowHeight,
    link,
    colSpan: obj.colSpan,
    rowSpan: obj.rowSpan,
  }
}

/** 按 A1 / A1:C9 这样的地址给区域刷数字格式；区域太大直接拒绝，不静默刷半张表。 */
export function applyNumberFormats(
  sheet: Worksheet,
  numberFormats?: Readonly<Record<string, string>>
): void {
  for (const [address, numFmt] of Object.entries(numberFormats ?? {})) {
    const match = ExcelAddressPattern.exec(address)
    if (!match) continue
    const startColumn = excelColumnNumber(match[1]!)
    const startRow = Number(match[2])
    const endColumn = excelColumnNumber(match[3] ?? match[1]!)
    const endRow = Number(match[4] ?? match[2])
    const left = Math.min(startColumn, endColumn)
    const right = Math.max(startColumn, endColumn)
    const top = Math.min(startRow, endRow)
    const bottom = Math.max(startRow, endRow)
    if ((right - left + 1) * (bottom - top + 1) > OfficeInputLimits.spreadsheet.numberFormatCells)
      throw new AppError(
        'VALIDATION',
        `numberFormats 的区域 ${address} 太大：一个区域最多 ${OfficeInputLimits.spreadsheet.numberFormatCells} 格`
      )
    for (let row = top; row <= bottom; row++)
      for (let column = left; column <= right; column++)
        sheet.getRow(row).getCell(column).numFmt = numFmt
  }
}

/** 根据已有内容估算列宽，避免生成的 Excel 打开后大量内容被截断。 */
export function applyAutoWidths(sheet: ReturnType<Workbook['addWorksheet']>): void {
  sheet.columns.forEach((column) => {
    let maxLength = 10
    column.eachCell?.({ includeEmpty: true }, (cell) => {
      const cellValue = cell.value
      const cellRecord = isPlainObject(cellValue) ? cellValue : null
      const text =
        cellRecord && isPresent(cellRecord.formula)
          ? `=${String(cellRecord.formula)}`
          : String(cellValue ?? '')
      maxLength = Math.max(maxLength, Math.min(60, text.length + 2))
    })
    if (!column.width || column.width < maxLength) column.width = maxLength
  })
}

/** 建一张工作表并应用冻结窗格、网格线开关与标签颜色。 */
export function addSpreadsheetWorksheet(
  workbook: Workbook,
  sheetInput: SpreadsheetSheetInput,
  sheetIndex: number
): Worksheet {
  const freezeRows = sheetInput.freezeRows ?? 0
  const freezeCols = sheetInput.freezeCols ?? 0
  const hasFreezeRows = freezeRows > 0
  const hasFreezeCols = freezeCols > 0
  // showGridLines 曾是 schema 收但从不使用的死参数（静默否决显式意图）；统一接进 view。
  const showGridLines = sheetInput.showGridLines ?? true
  const hasFrozenPanes = hasFreezeRows || hasFreezeCols
  return workbook.addWorksheet(normalizeSheetName(sheetInput.name, sheetIndex), {
    views: optionalWhenLazy(hasFrozenPanes || !showGridLines, () => [
      {
        ...(hasFrozenPanes
          ? {
              state: 'frozen' as const,
              xSplit: hasFreezeCols ? freezeCols : 0,
              ySplit: hasFreezeRows ? freezeRows : 0,
            }
          : {}),
        showGridLines,
      },
    ]),
    properties: optionalWhenLazy(sheetInput.tabColor, () => ({
      tabColor: { argb: toArgbColor(sheetInput.tabColor!) },
    })),
  })
}

/** 写一行单元格：值、样式、超链接、行高与合并范围。 */
export function writeSpreadsheetRow(sheet: Worksheet, rowData: ExcelCellInput[]): void {
  const excelRow = sheet.addRow([])
  let firstRowHeight: number | undefined
  // 合并单元格要等当前行所有 cell 写完后再执行，避免覆盖未初始化的格子。
  const mergeOps: Array<{ startCol: number; colSpan: number; rowSpan: number; rowNum: number }> = []

  for (let colIdx = 0; colIdx < rowData.length; colIdx++) {
    const cellInput = rowData[colIdx]!
    const cell = excelRow.getCell(colIdx + 1)
    const { excelValue, cellStyle, rowHeight, link, colSpan, rowSpan } =
      buildExcelCellValue(cellInput)
    cell.value = excelValue
    // 超链接在 ExcelJS 中是一种特殊 value，需要在基础值之后覆盖。
    if (link)
      cell.value = {
        text: String(excelValue ?? ''),
        hyperlink: link.hyperlink,
        tooltip: link.tooltip,
      }
    Object.assign(cell, cellStyle)
    if (isPresent(rowHeight) && !isPresent(firstRowHeight)) firstRowHeight = rowHeight
    if ((colSpan && colSpan > 1) || (rowSpan && rowSpan > 1))
      mergeOps.push({
        startCol: colIdx + 1,
        colSpan: colSpan ?? 1,
        rowSpan: rowSpan ?? 1,
        rowNum: excelRow.number,
      })
  }

  if (firstRowHeight) excelRow.height = firstRowHeight
  // 统一执行本行声明的合并范围。
  for (const m of mergeOps)
    sheet.mergeCells(m.rowNum, m.startCol, m.rowNum + m.rowSpan - 1, m.startCol + m.colSpan - 1)
}
