import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import ExcelJS from 'exceljs'

import type { OfficeOperationContext } from '../index.js'
import { officeOperations } from '../index.js'
import { parseSpreadsheetContentRows } from '../utils/spreadsheet/content.js'

describe('spreadsheet formatting', () => {
  for (const { name, content, notes } of [
    {
      name: 'CSV',
      content: 'name,notes,count,active\nA,"line1, ""quoted""\n\nline2\tinside",12,true',
      notes: 'line1, "quoted"\n\nline2\tinside',
    },
    {
      name: 'TSV',
      content: 'name\tnotes\tcount\tactive\r\nA\t"line1\t""quoted""\r\n\r\nline2"\t12\ttrue',
      notes: 'line1\t"quoted"\r\n\r\nline2',
    },
  ]) {
    test(`preserves quoted multiline ${name} records in the written workbook`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'velaros-office-multiline-spreadsheet-'))
      try {
        const context: OfficeOperationContext = {
          abortSignal: new AbortController().signal,
          office: {
            getRootPath: () => root,
            inspectEnvironment: async () => ({ commands: [] }),
            runCommand: async () => {
              throw new Error('spreadsheet generation does not run commands')
            },
          },
        }
        // 进入 XLSX 写入前，CSV/TSV 解析必须精确保留字段里的原始 CRLF。
        expect(parseSpreadsheetContentRows(content)[1]?.[1]).toBe(notes)
        const written = await officeOperations.createSpreadsheet(
          { outputPath: 'multiline.xlsx', content },
          context
        )
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.readFile(written.path)
        const sheet = workbook.worksheets[0]!
        expect(sheet.rowCount).toBe(2)
        expect(sheet.columnCount).toBe(4)
        expect(sheet.getCell('A2').value).toBe('A')
        // ExcelJS 原样写入 sharedStrings XML，XML 读取会将 CRLF 行尾规范化成 LF。
        expect(sheet.getCell('B2').value).toBe(notes.replace(/\r\n/g, '\n'))
        expect(sheet.getCell('C2').value).toBe(12)
        expect(sheet.getCell('D2').value).toBe(true)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  test('rejects unterminated CSV and TSV quotes before workspace access or file writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-office-invalid-spreadsheet-'))
    const calls: string[] = []
    const context: OfficeOperationContext = {
      abortSignal: new AbortController().signal,
      office: {
        getRootPath: () => {
          calls.push('getRootPath')
          return root
        },
        resolvePath: (path) => {
          calls.push('resolvePath')
          return join(root, path)
        },
        inspectEnvironment: async () => {
          calls.push('inspectEnvironment')
          return { commands: [] }
        },
        runCommand: async () => {
          calls.push('runCommand')
          throw new Error('invalid spreadsheet input must not run commands')
        },
      },
    }
    try {
      for (const content of [
        'name,notes\nA,"unfinished\n\ntext',
        'name\tnotes\r\nA\t"unfinished',
      ]) {
        await expect(
          officeOperations.createSpreadsheet({ outputPath: 'invalid.xlsx', content }, context)
        ).rejects.toMatchObject({
          code: 'VALIDATION',
          context: { executionOutcome: 'not-applied' },
        })
      }
      expect(calls).toEqual([])
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('column styles use the same color translation as cells, and ISO dates accept the documented date-only form', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-office-column-style-'))
    try {
      const context: OfficeOperationContext = {
        abortSignal: new AbortController().signal,
        office: {
          getRootPath: () => root,
          inspectEnvironment: async () => ({ commands: [] }),
          runCommand: async () => {
            throw new Error('spreadsheet generation does not run commands')
          },
        },
      }
      await officeOperations.createSpreadsheet(
        {
          outputPath: 'dates.xlsx',
          sheets: [
            {
              name: 'Dates',
              columns: [
                {
                  header: 'Date',
                  style: { bold: true, color: '#FFFFFF', bgColor: '#1F4E78', numFmt: 'yyyy-mm-dd' },
                },
              ],
              rows: [[{ dateValue: '2026-09-18' }], [{ dateValue: '2026-09-19T01:00:00+01:00' }]],
            },
          ],
        },
        context
      )
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.readFile(join(root, 'dates.xlsx'))
      const sheet = workbook.getWorksheet('Dates')!
      expect(sheet.getCell('A2').value).toEqual(new Date('2026-09-18T00:00:00Z'))
      expect(sheet.getCell('A3').value).toEqual(new Date('2026-09-19T00:00:00Z'))
      expect(sheet.getCell('A2').font).toMatchObject({ bold: true, color: { argb: 'FFFFFFFF' } })
      expect(sheet.getCell('A2').fill).toMatchObject({
        type: 'pattern',
        fgColor: { argb: 'FF1F4E78' },
      })
      expect(sheet.getCell('A2').numFmt).toBe('yyyy-mm-dd')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('applies sheet header styles and A1 number format ranges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-office-spreadsheet-formatting-'))
    const context: OfficeOperationContext = {
      abortSignal: new AbortController().signal,
      office: {
        getRootPath: () => root,
        inspectEnvironment: async () => ({ commands: [] }),
        runCommand: async () => {
          throw new Error('生成 Excel 不跑外部命令')
        },
      },
    }

    try {
      await officeOperations.createSpreadsheet(
        {
          outputPath: 'formatted.xlsx',
          sheets: [
            {
              name: '总览',
              columns: ['项目', '金额'],
              rows: [
                ['研发', 12_000],
                ['市场', 8_000],
              ],
              headerStyle: {
                font: { bold: true, color: '#FFFFFF' },
                fill: { type: 'pattern', pattern: 'solid', fgColor: '#1F4E78' },
              },
              numberFormats: { 'B2:B3': '#,##0.00' },
            },
            {
              name: '明细',
              columns: ['类别', '金额'],
              rows: [['云服务', 28_500]],
              headerStyle: {
                bold: true,
                color: '#FFFFFF',
                bgColor: '#1F4E78',
              },
            },
          ],
        },
        context
      )

      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.readFile(join(root, 'formatted.xlsx'))
      const sheet = workbook.getWorksheet('总览')!
      expect(sheet.getCell('A1').font.bold).toBe(true)
      expect(sheet.getCell('A1').font.color?.argb).toBe('FFFFFFFF')
      expect(sheet.getCell('A1').fill).toMatchObject({
        type: 'pattern',
        fgColor: { argb: 'FF1F4E78' },
      })
      expect(sheet.getCell('B2').numFmt).toBe('#,##0.00')
      expect(sheet.getCell('B3').numFmt).toBe('#,##0.00')
      const detail = workbook.getWorksheet('明细')!
      expect(detail.getCell('A1').font.bold).toBe(true)
      expect(detail.getCell('A1').font.color?.argb).toBe('FFFFFFFF')
      expect(detail.getCell('A1').fill).toMatchObject({
        type: 'pattern',
        fgColor: { argb: 'FF1F4E78' },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
