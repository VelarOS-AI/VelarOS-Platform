import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import ExcelJS from 'exceljs'

import type {
  CapabilityToken,
  KernelModuleActivateContext,
} from '@velaros-ai/core/kernel/abi'

import {
  createOfficeKernelModule,
  type OfficeCapabilityService,
  type OfficeToolContext,
} from '../src'

function captureOfficeService(
  capture: (service: OfficeCapabilityService) => void,
): KernelModuleActivateContext {
  return {
    registerService<TService extends object>(
      _token: CapabilityToken<TService>,
      service: TService,
    ) {
      capture(service as unknown as OfficeCapabilityService)
      return { dispose() {} }
    },
  } as unknown as KernelModuleActivateContext
}

describe('spreadsheet formatting', () => {
  test('applies sheet header styles and A1 number format ranges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-office-spreadsheet-formatting-'))
    let service: OfficeCapabilityService | undefined
    const module = createOfficeKernelModule({
      resolveContext: async (_scope, signal) => ({
        abortSignal: signal,
        office: {
          hasProjectRoot: () => true,
          project: {
            getRootPath: () => root,
            runInDirectory: async <T>(_cwd: string, action: () => Promise<T>) => action(),
            prepareMutation: async () => ({
              approved: true,
              rootPath: root,
              switched: false,
              alreadyAuthorized: true,
              rejectionMessage: null,
              message: 'approved',
            }),
          },
          system: {} as OfficeToolContext['office']['system'],
        },
      }),
    })

    try {
      await module.activate(
        captureOfficeService((registered) => {
          service = registered
        }),
      )
      await service?.invoke(
        'office:create_spreadsheet',
        undefined,
        {
          outputPath: 'formatted.xlsx',
          sheets: [{
            name: '总览',
            columns: ['项目', '金额'],
            rows: [['研发', 12_000], ['市场', 8_000]],
            headerStyle: {
              font: { bold: true, color: '#FFFFFF' },
              fill: { type: 'pattern', pattern: 'solid', fgColor: '#1F4E78' },
            },
            numberFormats: { 'B2:B3': '#,##0.00' },
          }, {
            name: '明细',
            columns: ['类别', '金额'],
            rows: [['云服务', 28_500]],
            headerStyle: {
              bold: true,
              color: '#FFFFFF',
              bgColor: '#1F4E78',
            },
          }],
        },
        new AbortController().signal,
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
