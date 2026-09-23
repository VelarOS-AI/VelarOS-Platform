/**
 * Excel 内容归一化：CSV、TSV、Markdown 表格、JSON 行以及序列化过的 sheets 数组。
 *
 * 结构化 sheets 的 schema 也在这里：自动解析要用它判断「这段字符串其实是序列化的 sheets」，
 * 工具文件再引它做 wire 面校验，两处必须是同一份判定。
 */

import { z } from 'zod'

import {
  isArray,
  isBoolean,
  isEmpty,
  isNumber,
  isPlainObject,
  isPresent,
  isString,
  Log,
  trimmedStringOrEmpty,
} from '@velaros-ai/core'

import { OfficeInputLimits } from '../../contract/constants.js'
import type {
  ExcelCellInput,
  OfficeSpreadsheetInput,
  SpreadsheetSheetInput,
} from '../../types/office.js'
import { isMarkdownTableSeparator, parseMarkdownTableRow } from '../markdown.js'

const log = Log.tag('OfficeSpreadsheetContent')

/** 单元格样式 schema：字体、填充、边框、对齐与常用扁平简写。 */
const excelFontSchema = z
  .object({
    name: z.string().optional(),
    size: z.number().optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.union([z.boolean(), z.string()]).optional(),
    strike: z.boolean().optional(),
    color: z.string().optional(),
  })
  .optional()

/** 对象单元格 schema 承载样式、公式、日期、富文本和合并单元格信息。 */
const excelCellObjectSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  dateValue: z.string().datetime().optional(),
  formula: z.string().optional(),
  numFmt: z.string().optional(),
  font: excelFontSchema,
  fill: z.record(z.string(), z.any()).optional(),
  border: z.record(z.string(), z.any()).optional(),
  alignment: z.record(z.string(), z.any()).optional(),
  rowHeight: z.number().optional(),
  link: z.string().optional(),
  tooltip: z.string().optional(),
  richText: z.array(z.object({ text: z.string(), font: excelFontSchema })).optional(),
  colSpan: z.number().int().positive().optional(),
  rowSpan: z.number().int().positive().optional(),
})

/** 可复用的单元格样式 schema，表头样式与列默认样式都用它。 */
export const excelCellStyleSchema = z.object({
  numFmt: z.string().min(1).max(OfficeInputLimits.spreadsheet.numberFormatChars).optional(),
  font: excelFontSchema,
  fill: z.record(z.string(), z.any()).optional(),
  border: z.record(z.string(), z.any()).optional(),
  alignment: z.record(z.string(), z.any()).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  color: z.string().optional(),
  bgColor: z.string().optional(),
})

/** 简单单元格和对象单元格共用一个 union，方便用户按复杂度逐步输入。 */
const excelCellSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  excelCellObjectSchema,
])

/** 列定义允许简写字符串，也允许对象形式设置宽度和默认样式。 */
const excelColumnDefSchema = z.union([
  z.string(),
  z.object({
    header: z.string(),
    key: z.string().optional(),
    width: z.number().optional(),
    style: z.record(z.string(), z.any()).optional(),
  }),
])

/** 结构化 sheets 数组的校验：限制工作表数量、行数和列数，避免一次生成过大文件。 */
export const spreadsheetSheetArraySchema = z
  .array(
    z.object({
      name: z.string().min(1).max(OfficeInputLimits.spreadsheet.sheetNameChars),
      columns: z.array(excelColumnDefSchema).optional(),
      rows: z
        .array(z.array(excelCellSchema).max(OfficeInputLimits.spreadsheet.columns))
        .min(1)
        .max(OfficeInputLimits.spreadsheet.rows),
      freezeRows: z.number().int().min(0).optional(),
      freezeCols: z.number().int().min(0).optional(),
      tabColor: z.string().optional(),
      showGridLines: z.boolean().optional(),
      headerStyle: excelCellStyleSchema.optional(),
      numberFormats: z
        .record(
          z.string().regex(/^[A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?$/iu),
          z.string().min(1).max(OfficeInputLimits.spreadsheet.numberFormatChars)
        )
        .optional(),
    })
  )
  .min(1)
  .max(OfficeInputLimits.spreadsheet.sheets)

/**
 * 认出「被序列化成 JSON 字符串的结构化 sheets」。
 *
 * 模型高频把结构化 sheets 序列化成 JSON 字符串传入（union 收字符串，完全合法）；曾被文本
 * 行解析分支当行数据处理，行内容与 showGridLines/freeze 等字段全部静默丢弃且报成功
 * （真机取证）。铁律⑦：自动解析不得静默否决显式结构——能解析出「每项都带 rows 数组的对象
 * 数组」就按结构化 sheets 校验使用，缺 name 自动补齐。
 */
export function parseStringifiedSpreadsheetSheets(
  content: string
): Nullable<SpreadsheetSheetInput[]> {
  if (!content.trim().startsWith('[')) return null
  try {
    const parsed = JSON.parse(content)
    if (!isArray(parsed) || isEmpty(parsed)) return null
    const looksLikeSheets = parsed.every((item) => isPlainObject(item) && isArray(item.rows))
    if (!looksLikeSheets) return null

    const withNames = parsed.map((item, index) => ({
      name: `Sheet ${index + 1}`,
      ...(item as Record<string, unknown>),
    }))
    const validated = spreadsheetSheetArraySchema.safeParse(withNames)
    return validated.success ? (validated.data as SpreadsheetSheetInput[]) : null
  } catch (error) {
    // JSON 不合法说明这段内容本来就不是序列化 sheets，回落到文本表格解析路径。
    log.debug('解析序列化 sheets JSON 失败，回落文本表格解析', { error })
    return null
  }
}

/** 将工具入口的 sheets/content 统一整理成工作表数组，执行阶段只处理这一种结构。 */
export function normalizeSpreadsheetSheets(input: OfficeSpreadsheetInput): SpreadsheetSheetInput[] {
  // 结构化 sheets 已经包含完整工作表信息，直接返回。
  if (isArray(input.sheets)) return input.sheets
  const content = input.content
  if (!isString(content)) return []
  const stringifiedSheets = parseStringifiedSpreadsheetSheets(content)
  if (stringifiedSheets) return stringifiedSheets
  const rows = parseSpreadsheetContentRows(content)
  if (isEmpty(rows)) return []
  // 文本输入默认生成单张工作表，并在有表头时冻结第一行。
  return [
    {
      name: input.title ?? 'Sheet 1',
      rows,
      freezeRows: rows.length > 1 ? 1 : 0,
      showGridLines: true,
    },
  ]
}

/** 解析文本表格的总入口：优先 JSON，其次 Markdown 表格，最后按 CSV/TSV 处理。 */
export function parseSpreadsheetContentRows(content: string): ExcelCellInput[][] {
  const trimmed = content.trim()
  if (!trimmed) return []
  const jsonRows = parseJsonSpreadsheetRows(trimmed)
  if (jsonRows) return jsonRows
  const markdownRows = parseMarkdownSpreadsheetRows(trimmed)
  if (markdownRows) return markdownRows
  const delimiter = trimmed.includes('\t') ? '\t' : ','
  return trimmed
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(0, OfficeInputLimits.spreadsheet.rows)
    .map((line) =>
      parseDelimitedSpreadsheetLine(line, delimiter)
        .slice(0, OfficeInputLimits.spreadsheet.columns)
        .map(coerceSpreadsheetTextCell)
    )
}

/** 支持 JSON 数组，或形如 { rows: [...] } 的对象，便于工具调用方直接传结构化行数据。 */
export function parseJsonSpreadsheetRows(content: string): Nullable<ExcelCellInput[][]> {
  if (!/^(?:\[|{)/.test(content)) return null
  try {
    const parsed = JSON.parse(content)
    const rows = isArray(parsed) ? parsed : isPlainObject(parsed) ? parsed.rows : null
    if (!isArray(rows)) return null
    return rows
      .slice(0, OfficeInputLimits.spreadsheet.rows)
      .map((row) => {
        const cells = isArray(row) ? row : [row]
        return cells
          .slice(0, OfficeInputLimits.spreadsheet.columns)
          .map(coerceSpreadsheetDynamicCell)
      })
      .filter((row) => row.length > 0)
  } catch (error) {
    log.debug('解析电子表格 JSON 行失败', { error })
    return null
  }
}

/** 从 Markdown 表格中取出表头和数据行；分隔线下面遇到非表格行就停止。 */
export function parseMarkdownSpreadsheetRows(content: string): Nullable<ExcelCellInput[][]> {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const separatorIndex = lines.findIndex((line) => isMarkdownTableSeparator(line))
  if (separatorIndex <= 0) return null
  const tableLines: string[] = []
  for (let index = separatorIndex - 1; index < lines.length; index += 1) {
    const line = trimmedStringOrEmpty(lines[index])
    if (isMarkdownTableSeparator(line)) continue
    if (!parseMarkdownTableRow(line)) break
    tableLines.push(line)
  }
  const rows = tableLines
    .slice(0, OfficeInputLimits.spreadsheet.rows)
    .map((line) =>
      (parseMarkdownTableRow(line) ?? [])
        .slice(0, OfficeInputLimits.spreadsheet.columns)
        .map(coerceSpreadsheetTextCell)
    )
    .filter((row) => row.length > 0)
  return !isEmpty(rows) ? rows : null
}

/** 轻量 CSV/TSV 行解析器，处理双引号包裹字段和 "" 转义。 */
export function parseDelimitedSpreadsheetLine(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let current = ''
  let inQuotes = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (char === delimiter && !inQuotes) {
      cells.push(current)
      current = ''
      continue
    }
    current += char
  }
  cells.push(current)
  return cells
}

/** JSON 输入里的动态值会被尽量转换成 Excel 可接受的简单值或对象单元格。 */
export function coerceSpreadsheetDynamicCell(value: unknown): ExcelCellInput {
  if (!isPresent(value)) return null
  if (isString(value) || isNumber(value) || isBoolean(value)) return value
  if (value instanceof Date) return { dateValue: value.toISOString() }
  if (isPlainObject(value)) return value
  return String(value)
}

/** 文本表格里的单元格会自动识别布尔值和数字，减少生成后再手动改格式的成本。 */
export function coerceSpreadsheetTextCell(value: string): ExcelCellInput {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true'
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
  return trimmed
}
