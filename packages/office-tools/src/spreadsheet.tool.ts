/**
 * spreadsheetTool.ts
 *
 * Excel (.xlsx) 工作簿生成工具。
 * 依赖：officeShared（共享类型、路径辅助与 Markdown 表格原语）
 */
import ExcelJS from 'exceljs'
import { type z } from 'zod'

import { isEmpty, isPresent, isString, optionalWhenLazy } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  buildWorkspaceMutationSkippedResult,
  defineOfficeTool,
  OfficeDocumentWriteCapability,
  type OfficeToolContext,
  prepareOfficeOutputPath,
  runWithDirectory,
  toolRequiresWorkspace,
  writeOfficeBuffer,
} from './officeShared'
import type { CreateSpreadsheetInput } from './spreadsheetTool'
import { applyAutoWidths, buildExcelCellStyle, buildExcelCellValue, createSpreadsheetGuidedSchema, createSpreadsheetPresetSchema, createSpreadsheetSchema, normalizeCreateSpreadsheetGuided, normalizeCreateSpreadsheetPreset, normalizeSheetName, normalizeSpreadsheetSheets, toArgbColor } from './spreadsheetTool'

const ExcelAddressPattern = /^([A-Z]+)([1-9]\d*)(?::([A-Z]+)([1-9]\d*))?$/iu
const MaxNumberFormatCells = 100_000

function excelColumnNumber(name: string): number {
  let value = 0
  for (const char of name.toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64
  return value
}

function applyNumberFormats(
  sheet: ExcelJS.Worksheet,
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
    if ((right - left + 1) * (bottom - top + 1) > MaxNumberFormatCells)
      throw new AppError('VALIDATION', `create_spreadsheet: numberFormats 范围过大：${address}`)
    for (let row = top; row <= bottom; row++)
      for (let column = left; column <= right; column++)
        sheet.getRow(row).getCell(column).numFmt = numFmt
  }
}

// ─── Tool definition ────────────────────────────────────────────────────────────

const createSpreadsheet = defineOfficeTool<CreateSpreadsheetInput>({
  name: 'create_spreadsheet',
  role: 'render',
  summary: '生成 .xlsx Excel 工作簿。',
  suitable: ['需要生成表格、公式、多工作表或带格式的 Excel 文件。'],
  forbidden: ['不要用它生成 Word、PowerPoint 或 PDF 文档。'],
  usage: ['传 outputPath，并提供 sheets 或 content；复杂样式用结构化 sheets。'],
  examples: [
    // 简单：CSV/TSV/Markdown 表格自动生成单表
    { outputPath: 'data.xlsx', content: 'name,value\nA,1' },
    // 结构化：多工作表 + 单元格样式，rows 里可混用原始值与样式对象
    {
      outputPath: 'report.xlsx',
      sheets: [
        {
          name: 'Sales',
          columns: ['Region', 'Q1'],
          rows: [
            [
              { value: 'Region', font: { bold: true } },
              { value: 'Q1', font: { bold: true } },
            ],
            ['North', 1200],
            ['South', 980],
          ],
          freezeRows: 1,
        },
      ],
    },
  ],
  notes: ['结构化单元格支持字体、填充、边框、数字格式、富文本、链接和合并。'],
  schema: createSpreadsheetSchema as z.ZodType<CreateSpreadsheetInput>,
  surfaces: {
    preset: {
      role: 'render',
      summary: '用文本内容快速生成 Excel 工作簿。',
      suitable: ['只需要 outputPath、content 和少量元数据。'],
      forbidden: ['不要用于多工作表或精细单元格样式。'],
      usage: ['传 outputPath 和 content；可传 title、overwrite。'],
      examples: [{ outputPath: "table.xlsx", content: "a,b\n1,2" }],
      notes: ['content 支持 CSV、TSV、Markdown 表格或 JSON rows。'],
      schema: createSpreadsheetPresetSchema,
      normalize: normalizeCreateSpreadsheetPreset,
    },
    guided: {
      role: 'render',
      summary: '用文本内容和常见元数据生成 Excel 工作簿。',
      suitable: ['需要设置 cwd、title、author 或覆盖策略。'],
      forbidden: ['不要用于多工作表、公式对象或精细样式。'],
      usage: ['传 outputPath 和 content；按需传 title、author、overwrite。'],
      examples: [{ outputPath: "metrics.xlsx", content: "| k | v |\n|---|---|\n| a | 1 |" }],
      notes: ['复杂工作簿保留给 direct/expert。'],
      schema: createSpreadsheetGuidedSchema,
      normalize: normalizeCreateSpreadsheetGuided,
    },
  },
  permissions: ['fs:read', 'fs:write'],
  capabilities: OfficeDocumentWriteCapability,
  isAvailable: toolRequiresWorkspace,
  isConcurrencySafe: () => false,
  execute: async (input: CreateSpreadsheetInput, ctx: OfficeToolContext) => {
    // 先把所有输入规整为工作表数组，后续生成逻辑只关心 sheets。
    const sheets = normalizeSpreadsheetSheets(input)
    if (isEmpty(sheets))
      throw new AppError(
        'VALIDATION',
        'create_spreadsheet: sheets/content 为空或缺失。请传入结构化 sheets 数组，或传入 CSV/TSV/Markdown 表格字符串。'
      )
    ctx.abortSignal.throwIfAborted()
    // 写文件前统一走工作区授权，确保用户知道会修改哪个路径。
    const authorization = await ctx.workspace.prepareMutationWorkspace({
      cwd: input.cwd,
      operation: '生成 Excel 工作簿',
      targetPath: input.outputPath,
    })
    if (!authorization.approved) return buildWorkspaceMutationSkippedResult(authorization)

    return runWithDirectory(ctx, input.cwd, async () => {
      const output = await prepareOfficeOutputPath(ctx, input.outputPath, '.xlsx', input.overwrite)
      const workbook = new ExcelJS.Workbook()
      // 工作簿级元数据写在文件属性里，不影响表格内容。
      workbook.creator = input.author ?? 'VelarOS'
      workbook.lastModifiedBy = input.author ?? 'VelarOS'
      workbook.created = new Date()
      workbook.modified = new Date()
      workbook.title = input.title ?? ''

      for (const [sheetIndex, sheetInput] of sheets.entries()) {
        // 每张表单独创建 worksheet，同时应用冻结窗格和标签颜色。
        const freezeRows = sheetInput.freezeRows ?? 0
        const freezeCols = sheetInput.freezeCols ?? 0
        const hasFreezeRows = freezeRows > 0
        const hasFreezeCols = freezeCols > 0
        // showGridLines 曾是 schema 收但从不使用的死参数（静默否决显式意图）;统一接进 view。
        const showGridLines = sheetInput.showGridLines ?? true
        const hasFrozenPanes = hasFreezeRows || hasFreezeCols
        const sheet = workbook.addWorksheet(normalizeSheetName(sheetInput.name, sheetIndex), {
          views:
            optionalWhenLazy(hasFrozenPanes || !showGridLines, () => [
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

        if (!!sheetInput.columns && !isEmpty(sheetInput.columns)) {
          // 列定义主要负责表头、key、宽度和默认列样式。
          sheet.columns = sheetInput.columns.map((col) =>
            isString(col)
              ? { header: col }
              : { header: col.header, key: col.key, width: col.width, style: col.style as object }
          )
        }

        for (const rowData of sheetInput.rows) {
          const excelRow = sheet.addRow([])
          let firstRowHeight: number | undefined
          // 合并单元格要等当前行所有 cell 写完后再执行，避免覆盖未初始化的格子。
          const mergeOps: Array<{
            startCol: number
            colSpan: number
            rowSpan: number
            rowNum: number
          }> = []

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
            sheet.mergeCells(
              m.rowNum,
              m.startCol,
              m.rowNum + m.rowSpan - 1,
              m.startCol + m.colSpan - 1
            )
        }

        if (sheetInput.headerStyle && sheetInput.columns?.length) {
          const headerStyle = buildExcelCellStyle(sheetInput.headerStyle)
          for (let column = 1; column <= sheetInput.columns.length; column++)
            Object.assign(sheet.getRow(1).getCell(column), headerStyle)
        }
        applyNumberFormats(sheet, sheetInput.numberFormats)

        // 内容全部写入后再自动列宽，避免漏掉后续行的最长文本。
        applyAutoWidths(sheet)
      }

      // ExcelJS 输出 ArrayBuffer，最终转成 Buffer 交给共享写入逻辑。
      const buffer = await workbook.xlsx.writeBuffer()
      return writeOfficeBuffer(output, Buffer.from(buffer), 'xlsx')
    })
  },
})
const spreadsheetTools = {
  create_spreadsheet: createSpreadsheet,
}

export { spreadsheetTools }
