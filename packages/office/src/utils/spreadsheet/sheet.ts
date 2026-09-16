/** 写工作表用的原语：表名归一、单元格取值、数字格式区域、自动列宽。 */

import type { Workbook, Worksheet } from 'exceljs'

import { isEmpty, isPlainObject, isPresent, isString, optionalWhenLazy, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { OfficeInputLimits, OfficeToolNames } from '../../contract/constants.js'
import type { ExcelCellBuildResult, ExcelCellInput } from '../../types/spreadsheet.js'

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
  numberFormats?: Readonly<Record<string, string>>,
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
      throw new AppError('VALIDATION', `${OfficeToolNames.createSpreadsheet}: numberFormats 范围过大：${address}`)
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
