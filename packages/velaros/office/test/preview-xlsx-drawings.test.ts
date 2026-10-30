import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'

import { parseXlsxPreview } from '../utils/preview/parse'

test('原生绘图与批注不影响单元格摘录，未缓存公式保留公式文本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'velaros-xlsx-image-'))
  try {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Summary')
    sheet.addRow([100, { formula: 'A1*2' }])
    sheet.getCell('A1').note = '源数据'
    const imageId = workbook.addImage({
      base64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      extension: 'png',
    })
    sheet.addImage(imageId, 'D1:E3')
    const inputPath = join(root, 'image.xlsx')
    await workbook.xlsx.writeFile(inputPath)
    const bytes = await readFile(inputPath)
    const preview = await parseXlsxPreview(inputPath, 1)
    expect(preview.sheets?.[0]?.rows[0]?.slice(0, 2)).toEqual(['100', '=A1*2'])
    expect(preview.summary.drawings).toBe(1)
    expect(await readFile(inputPath)).toEqual(bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('预览默认命名空间的工作表绘图时保留单元格与原始文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'velaros-xlsx-drawing-'))
  try {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('经营汇总')
    sheet.addRow(['收入', '情景'])
    sheet.addRow([100, { formula: 'A2*1.1', result: 110 }])
    workbook.addWorksheet('明细').addRow(['另一张表'])
    const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer())
    const sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    zip.file(
      'xl/worksheets/sheet1.xml',
      sheetXml.replace('</worksheet>', '<drawing r:id="rId1"/></worksheet>')
    )
    zip.file(
      'xl/worksheets/_rels/sheet1.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="/xl/drawings/drawing1.xml"/></Relationships>'
    )
    // openpyxl 使用默认命名空间；ExcelJS 只认 xdr:wsDr，旧读取路径会在 anchors 处崩溃。
    zip.file(
      'xl/drawings/drawing1.xml',
      '<wsDr xmlns="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>'
    )
    zip.file(
      'xl/drawings/_rels/drawing1.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'
    )
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    const inputPath = join(root, 'report.xlsx')
    await writeFile(inputPath, bytes)

    const preview = await parseXlsxPreview(inputPath, 1)

    expect(preview.summary).toMatchObject({ sheets: 2, previewedSheets: 1, drawings: 1 })
    expect(preview.sheets?.[0]?.rows).toEqual([
      ['收入', '情景'],
      ['100', '110'],
    ])
    expect(preview.htmlBody).toContain('图表与图片未渲染')
    expect(await readFile(inputPath)).toEqual(bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
