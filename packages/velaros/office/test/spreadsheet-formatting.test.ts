import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import ExcelJS from 'exceljs'

import type { OfficeOperationContext } from '../index.js'
import { officeOperations } from '../index.js'

describe('spreadsheet formatting', () => {
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
