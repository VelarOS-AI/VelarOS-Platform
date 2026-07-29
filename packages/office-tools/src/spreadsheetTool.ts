/**
 * spreadsheetTool.ts
 *
 * Excel (.xlsx) 工作簿生成工具。
 * 依赖：officeShared（共享类型 + 路径辅助）
 * 复用了 parseMarkdownTableRow / isMarkdownTableSeparator（从 wordTool 内联一份轻量版本）
 */
import type { CellValue, Workbook } from 'exceljs'
import { z } from 'zod'

import { isArray, isBoolean, isEmpty, isNonBlankString, isNumber, isObject, isPresent, isString, optionalWhenLazy, toNullable,trimmedStringOrEmpty } from '@velaros-ai/core'
import { logRuntime } from '@velaros-ai/core/logger'
import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/core/utils/ToolDescription'

import {
  outputPathSchema,
} from './officeShared'

export const log = logRuntime.tag('SpreadsheetTool')

// ─── Types ─────────────────────────────────────────────────────────────────────

// Excel 字体配置，最终会被 applyExcelFont 转成 ExcelJS 的 cell.font。
export type ExcelFont = {
  name?: string
  size?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean | 'none' | 'single' | 'double' | 'singleAccounting' | 'doubleAccounting'
  strike?: boolean
  color?: string
}

// Excel 填充配置，支持纯色 pattern 和渐变 gradient 两类。
export type ExcelFill =
  | { type: 'pattern'; pattern?: string; fgColor?: string; bgColor?: string }
  | {
      type: 'gradient'
      gradient?: 'angle' | 'path'
      degree?: number
      stops?: Array<{ position: number; color: string }>
    }

// 单条边框边的样式，ExcelJS 会按 top/left/bottom/right 分别接收。
export type ExcelBorderSide = {
  style?:
    | 'thin'
    | 'dotted'
    | 'hair'
    | 'medium'
    | 'double'
    | 'thick'
    | 'dashed'
    | 'dashDot'
    | 'dashDotDot'
    | 'slantDashDot'
    | 'mediumDashed'
    | 'mediumDashDotDot'
    | 'mediumDashDot'
  color?: string
}

// 一个单元格的四边边框定义。
export type ExcelBorders = {
  top?: ExcelBorderSide
  left?: ExcelBorderSide
  bottom?: ExcelBorderSide
  right?: ExcelBorderSide
}

// 对齐配置直接映射到 ExcelJS 的 alignment，控制水平/垂直对齐、换行和缩进。
export type ExcelAlignment = {
  horizontal?: 'left' | 'center' | 'right' | 'fill' | 'justify' | 'centerContinuous' | 'distributed'
  vertical?: 'top' | 'middle' | 'bottom' | 'distributed' | 'justify'
  wrapText?: boolean
  shrinkToFit?: boolean
  indent?: number
  textRotation?: number
}

// 单元格输入支持简单值，也支持对象格式来声明公式、富文本、样式、超链接和合并范围。
export type ExcelCellInput = LooseOptional<
  | string
  | number
  | boolean
  | {
      value?: string | number | boolean
      dateValue?: string
      formula?: string
      numFmt?: string
      font?: ExcelFont
      fill?: ExcelFill
      border?: ExcelBorders
      alignment?: ExcelAlignment
      rowHeight?: number
      link?: string
      tooltip?: string
      richText?: Array<{ text: string; font?: ExcelFont }>
      colSpan?: number
      rowSpan?: number
    }
>

// 列定义既可以只给表头，也可以给 key、列宽和默认列样式。
export type ExcelColumnDef =
  | string
  | {
      header: string
      key?: string
      width?: number
      style?: { numFmt?: string; font?: ExcelFont; fill?: ExcelFill; alignment?: ExcelAlignment }
    }

// 单个工作表输入；冻结行列和标签颜色在创建 worksheet 时使用。
export type SpreadsheetSheetInput = {
  name: string
  columns?: ExcelColumnDef[]
  rows: ExcelCellInput[][]
  freezeRows?: number
  freezeCols?: number
  tabColor?: string
  showGridLines?: boolean
}

// 工具入口参数；sheets/content 二选一，content 会被自动解析成单张表。
export type CreateSpreadsheetInput = {
  cwd?: string
  outputPath: string
  title?: string
  author?: string
  sheets?: SpreadsheetSheetInput[] | string
  content?: string
  overwrite?: boolean
}

// ─── Zod schema ────────────────────────────────────────────────────────────────

// 字体 schema 保持宽松，便于把 ExcelJS 支持但类型未完全枚举的值透传下去。
export const excelFontSchema = z
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

// 对象单元格 schema 承载样式、公式、日期、富文本和合并单元格信息。
export const excelCellObjectSchema = z.object({
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

// 简单单元格和对象单元格共用一个 union，方便用户按复杂度逐步输入。
export const excelCellSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  excelCellObjectSchema,
])

// 列定义允许简写字符串，也允许对象形式设置宽度和默认样式。
export const excelColumnDefSchema = z.union([
  z.string(),
  z.object({
    header: z.string(),
    key: z.string().optional(),
    width: z.number().optional(),
    style: z.record(z.string(), z.any()).optional(),
  }),
])

// 结构化 sheets 数组的校验：限制工作表数量、行数和列数，避免一次生成过大文件。
export const spreadsheetSheetArraySchema = z
  .array(
    z.object({
      name: z.string().min(1).max(31),
      columns: z.array(excelColumnDefSchema).optional(),
      rows: z.array(z.array(excelCellSchema).max(1000)).min(1).max(100_000),
      freezeRows: z.number().int().min(0).optional(),
      freezeCols: z.number().int().min(0).optional(),
      tabColor: z.string().optional(),
      showGridLines: z.boolean().optional(),
    })
  )
  .min(1)
  .max(100)

// sheets 既可以是结构化数组，也可以是待解析的 CSV/TSV/Markdown 表格文本。
export const spreadsheetSheetsInputSchema = z
  .union([
    spreadsheetSheetArraySchema,
    z
      .string()
      .min(1)
      .max(1_000_000)
      .describe(
        parameterDescription({
          description: 'CSV、TSV 或 Markdown 表格内容。',
          notes: ['工具会自动转为单个工作表。'],
        })
      ),
  ])
  .describe(
    parameterDescription({
      description: 'Excel 工作表输入。',
      values: [
        '结构化 sheets 数组：完整控制多工作表、列和单元格。',
        '字符串：按 CSV、TSV 或 Markdown 表格自动生成单表。',
      ],
    })
  )

// 创建工作簿的入口 schema，最后 refine 保证至少有一种内容来源。
export const createSpreadsheetSchema = z
  .object({
    cwd: z.string().optional(),
    outputPath: outputPathSchema,
    title: z.string().min(1).max(200).optional(),
    author: z.string().min(1).max(120).optional(),
    sheets: spreadsheetSheetsInputSchema.optional(),
    content: z
      .string()
      .min(1)
      .max(1_000_000)
      .optional()
      .describe(
        parameterDescription({
          description: 'CSV、TSV 或 Markdown 表格内容。',
          usage: ['不需要精细结构化 sheets 时使用。'],
        })
      ),
    overwrite: z.boolean().optional(),
  })
  .refine((input) => isPresent(input.sheets) || isNonBlankString(input.content), {
    path: ['sheets'],
    message: 'sheets 或 content 至少提供一个。',
  })

export const createSpreadsheetPresetSchema = z.object({
  outputPath: outputPathSchema,
  title: z.string().min(1).max(200).optional(),
  content: z
    .string()
    .min(1)
    .max(1_000_000)
    .describe(
      parameterDescription({
        description: 'CSV、TSV、Markdown 表格或 JSON rows。',
        notes: ['工具会自动转为单张工作表。'],
      })
    ),
  overwrite: z.boolean().optional(),
})

export type CreateSpreadsheetPresetInput = z.infer<typeof createSpreadsheetPresetSchema>

export function normalizeCreateSpreadsheetPreset(
  input: CreateSpreadsheetPresetInput
): CreateSpreadsheetInput {
  return {
    outputPath: input.outputPath,
    title: input.title,
    content: input.content,
    overwrite: input.overwrite,
  }
}

export const createSpreadsheetGuidedSchema = z.object({
  cwd: z.string().optional(),
  outputPath: outputPathSchema,
  title: z.string().min(1).max(200).optional(),
  author: z.string().min(1).max(120).optional(),
  content: z
    .string()
    .min(1)
    .max(1_000_000)
    .describe(
      parameterDescription({
        description: 'CSV、TSV、Markdown 表格或 JSON rows。',
        notes: ['多工作表、样式和公式对象请切到 direct/expert。'],
      })
    ),
  overwrite: z.boolean().optional(),
})

export type CreateSpreadsheetGuidedInput = z.infer<typeof createSpreadsheetGuidedSchema>

export function normalizeCreateSpreadsheetGuided(
  input: CreateSpreadsheetGuidedInput
): CreateSpreadsheetInput {
  return {
    ...input,
    content: input.content,
  }
}

// ─── Content normalization ──────────────────────────────────────────────────────

// 模型高频把结构化 sheets 序列化成 JSON 字符串传入（union 收字符串,完全合法）;曾被文本
// 行解析分支当行数据处理,行内容与 showGridLines/freeze 等字段全部静默丢弃且报成功
// (真机取证)。铁律⑦:自动解析不得静默否决显式结构——能解析出「每项都带 rows 数组的对象
// 数组」就按结构化 sheets 校验使用,缺 name 自动补齐。
export function parseStringifiedSpreadsheetSheets(
  content: string
): Nullable<SpreadsheetSheetInput[]> {
  if (!content.trim().startsWith('[')) return null
  try {
    const parsed = JSON.parse(content)
    if (!isArray(parsed) || isEmpty(parsed)) return null
    const looksLikeSheets = parsed.every(
      (item) => isObject(item) && !isArray(item) && isArray((item as { rows?: unknown }).rows)
    )
    if (!looksLikeSheets) return null

    const withNames = parsed.map((item, index) => ({
      name: `Sheet ${index + 1}`,
      ...(item as Record<string, unknown>),
    }))
    const validated = spreadsheetSheetArraySchema.safeParse(withNames)
    return validated.success ? (validated.data as SpreadsheetSheetInput[]) : null
  } catch {
    return null
  }
}

// 将工具入口的 sheets/content 统一整理成 SpreadsheetSheetInput[]，执行阶段只处理这一种结构。
export function normalizeSpreadsheetSheets(input: CreateSpreadsheetInput): SpreadsheetSheetInput[] {
  // 结构化 sheets 已经包含完整工作表信息，直接返回。
  if (isArray(input.sheets)) return input.sheets
  // 字符串 sheets 优先于 content，二者都会走自动表格解析。
  const content = isString(input.sheets) ? input.sheets : input.content
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

// 解析文本表格的总入口：优先 JSON，其次 Markdown 表格，最后按 CSV/TSV 处理。
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
    .slice(0, 100_000)
    .map((line) =>
      parseDelimitedSpreadsheetLine(line, delimiter).slice(0, 1000).map(coerceSpreadsheetTextCell)
    )
}

// 支持 JSON 数组，或形如 { rows: [...] } 的对象，便于工具调用方直接传结构化行数据。
export function parseJsonSpreadsheetRows(content: string): Nullable<ExcelCellInput[][]> {
  if (!/^(?:\[|{)/.test(content)) return null
  try {
    const parsed = JSON.parse(content)
    const rows = isArray(parsed)
      ? parsed
      : isObject(parsed)
        ? (parsed as { rows?: unknown }).rows
        : null
    if (!isArray(rows)) return null
    return rows
      .slice(0, 100_000)
      .map((row) => {
        const cells = isArray(row) ? row : [row]
        return cells.slice(0, 1000).map(coerceSpreadsheetDynamicCell)
      })
      .filter((row) => row.length > 0)
  } catch (error) {
    log.debug('解析电子表格 JSON 行失败', { error })
    return null
  }
}

// 从 Markdown 表格中取出表头和数据行；分隔线下面遇到非表格行就停止。
export function parseMarkdownSpreadsheetRows(content: string): Nullable<ExcelCellInput[][]> {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const separatorIndex = lines.findIndex((line) => isMarkdownTableSeparatorLine(line))
  if (separatorIndex <= 0) return null
  const tableLines: string[] = []
  for (let index = separatorIndex - 1; index < lines.length; index += 1) {
    const line = trimmedStringOrEmpty(lines[index])
    if (isMarkdownTableSeparatorLine(line)) continue
    if (!parseMarkdownTableRowLine(line)) break
    tableLines.push(line)
  }
  const rows = tableLines
    .slice(0, 100_000)
    .map((line) =>
      (parseMarkdownTableRowLine(line) ?? []).slice(0, 1000).map(coerceSpreadsheetTextCell)
    )
    .filter((row) => row.length > 0)
  return !isEmpty(rows) ? rows : null
}

// 解析单行 Markdown 表格，保留中间空单元格并去掉首尾管道。
export function parseMarkdownTableRowLine(line: string): Nullable<string[]> {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return null
  let cells = trimmed.split('|')
  if (trimmed.startsWith('|')) cells = cells.slice(1)
  if (trimmed.endsWith('|')) cells = cells.slice(0, -1)
  const normalized = cells.map((c) => c.trim())
  return normalized.length >= 2 ? normalized : null
}

// Markdown 表头分隔线形如 | --- | :---: |，用于识别表格块。
export function isMarkdownTableSeparatorLine(line: string): boolean {
  const row = parseMarkdownTableRowLine(line)
  return !!row?.length && row.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

// 轻量 CSV/TSV 行解析器，处理双引号包裹字段和 "" 转义。
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

// JSON 输入里的动态值会被尽量转换成 Excel 可接受的简单值或对象单元格。
export function coerceSpreadsheetDynamicCell(value: unknown): ExcelCellInput {
  if (isString(value) || isNumber(value) || isBoolean(value) || !isPresent(value)) return value
  if (value instanceof Date) return { dateValue: value.toISOString() }
  if (isObject(value)) return value
  return String(value ?? '')
}

// 文本表格里的单元格会自动识别布尔值和数字，减少生成后再手动改格式的成本。
export function coerceSpreadsheetTextCell(value: string): ExcelCellInput {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true'
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
  return trimmed
}

// ─── Formatting helpers ─────────────────────────────────────────────────────────

// Excel 工作表名不能包含部分特殊字符，且最长 31 个字符。
export function normalizeSheetName(name: string, index: number): string {
  return (name.replaceAll(/[*?:/\\[\]]/g, '-').trim() || `Sheet ${index + 1}`).slice(0, 31)
}

// ExcelJS 使用 ARGB；用户常传 6 位 RGB，这里自动补上不透明 Alpha。
export function toArgbColor(hex: string): string {
  return hex.length === 6 ? `FF${hex.toUpperCase()}` : hex.toUpperCase()
}

// 把工具层字体配置翻译成 ExcelJS 单元格字体对象。
export function applyExcelFont(target: { font?: object }, font?: ExcelFont): void {
  if (!font) return
  target.font = {
    name: font.name,
    size: font.size,
    bold: font.bold,
    italic: font.italic,
    underline: font.underline,
    strike: font.strike,
    color: optionalWhenLazy(font.color, () => ({ argb: toArgbColor(font.color!) })),
  }
}

// 把 pattern/gradient 填充翻译成 ExcelJS 的 fill 对象。
export function applyExcelFill(target: { fill?: object }, fill?: ExcelFill): void {
  if (!fill) return
  if (fill.type === 'gradient') {
    target.fill = {
      type: 'gradient',
      gradient: fill.gradient ?? 'angle',
      degree: fill.degree ?? 0,
      stops:
        fill.stops?.map((s) => ({ position: s.position, color: { argb: toArgbColor(s.color) } })) ??
        [],
    }
  } else {
    target.fill = {
      type: 'pattern',
      pattern: (fill as { type: 'pattern'; pattern?: string }).pattern ?? 'solid',
      fgColor: optionalWhenLazy((fill as { fgColor?: string }).fgColor, () => ({
        argb: toArgbColor((fill as { fgColor?: string }).fgColor!),
      })),
      bgColor: optionalWhenLazy((fill as { bgColor?: string }).bgColor, () => ({
        argb: toArgbColor((fill as { bgColor?: string }).bgColor!),
      })),
    }
  }
}

// 将四边边框分别转换成 ExcelJS 的 top/left/bottom/right 配置。
export function applyExcelBorder(target: { border?: object }, border?: ExcelBorders): void {
  if (!border) return
  const side = (b?: ExcelBorderSide): object | undefined =>
    optionalWhenLazy(b, () => ({
      style: b!.style ?? 'thin',
      color: optionalWhenLazy(b!.color, () => ({ argb: toArgbColor(b!.color!) })),
    }))
  target.border = {
    top: side(border.top),
    left: side(border.left),
    bottom: side(border.bottom),
    right: side(border.right),
  }
}

// 对齐配置无需额外转换，直接挂到 ExcelJS cell.alignment。
export function applyExcelAlignment(target: { alignment?: object }, alignment?: ExcelAlignment): void {
  if (!alignment) return
  target.alignment = alignment
}

// buildExcelCellValue 的中间结果：值、样式和布局信息拆开，便于执行阶段统一应用。
export type ExcelCellBuildResult = {
  excelValue: CellValue
  cellStyle: object
  rowHeight?: number
  link?: { hyperlink: string; tooltip?: string }
  colSpan?: number
  rowSpan?: number
}

// 将一个工具层单元格转换为 ExcelJS 能写入的值和样式。
export function buildExcelCellValue(cell: ExcelCellInput): ExcelCellBuildResult {
  if (!isPresent(cell) || !isObject(cell)) {
    // 简单字符串以 = 开头时按公式写入，保持用户常见的 Excel 输入习惯。
    if (isString(cell) && cell.startsWith('=') && cell.length > 1)
      return { excelValue: { formula: cell.slice(1) }, cellStyle: {} }
    return { excelValue: cell, cellStyle: {} }
  }
  const obj = cell
  const cellStyle: Record<string, unknown> = {}
  // 对象单元格先累积样式，再根据值类型决定实际写入内容。
  applyExcelFont(cellStyle, obj.font)
  applyExcelFill(cellStyle, obj.fill)
  applyExcelBorder(cellStyle, obj.border)
  applyExcelAlignment(cellStyle, obj.alignment)
  if (obj.numFmt) cellStyle.numFmt = obj.numFmt

  let excelValue: CellValue
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

// 根据已有内容估算列宽，避免生成的 Excel 打开后大量内容被截断。
export function applyAutoWidths(sheet: ReturnType<Workbook['addWorksheet']>): void {
  sheet.columns.forEach((column) => {
    let maxLength = 10
    column.eachCell?.({ includeEmpty: true }, (cell) => {
      const cellValue = cell.value
      const cellRecord = isObject(cellValue)
        ? (cellValue as { formula?: unknown })
        : null
      const text =
        cellRecord && isPresent(cellRecord.formula)
          ? `=${String(cellRecord.formula)}`
          : String(cellValue ?? '')
      maxLength = Math.max(maxLength, Math.min(60, text.length + 2))
    })
    if (!column.width || column.width < maxLength) column.width = maxLength
  })
}
