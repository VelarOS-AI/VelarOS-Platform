/**
 * 实现测试：真的把文档渲染出来落盘。协议、路径准入、回执形状的承诺在 spec/acceptance.test.ts。
 * 夹具直接用 velaros 装好的 exceljs 与 pdf-lib（office 单元的依赖），本包不重复声明这两个依赖。
 */

import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import ExcelJS from '../../velaros/node_modules/exceljs'
import { PDFDocument, rgb } from '../../velaros/node_modules/pdf-lib'
import { documentRenderer, DocumentRendererProtocol } from '../src/index'

describe('独立渲染能力包', () => {
  let temporaryRoot: string | undefined

  afterEach(async () => {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = undefined
  })

  test('把表格渲染成 HTML 与 PNG', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-renderer-office-'))
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Tasks')
    sheet.addRow(['Task', 'Status'])
    sheet.addRow(['Run a real command', 'Done'])
    await workbook.xlsx.writeFile(join(temporaryRoot, 'tasks.xlsx'))

    for (const extension of ['html', 'png']) {
      const response = await documentRenderer.execute({
        protocolVersion: DocumentRendererProtocol.version,
        requestId: `office-${extension}`,
        operation: 'render-office',
        projectRoot: temporaryRoot,
        inputPath: 'tasks.xlsx',
        outputPath: `output/tasks.${extension}`,
      })
      expect(response.status).toBe('success')
      expect((await stat(join(temporaryRoot, 'output', `tasks.${extension}`))).size)
        .toBeGreaterThan(100)
    }
    expect(await readFile(join(temporaryRoot, 'output', 'tasks.html'), 'utf8'))
      .toContain('Run a real command')
  })

  test('把 PDF 的一页渲染成 PNG', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-renderer-pdf-'))
    const document = await PDFDocument.create()
    const page = document.addPage([320, 200])
    page.drawRectangle({ x: 32, y: 32, width: 256, height: 136, color: rgb(0.1, 0.5, 0.45) })
    await Bun.write(join(temporaryRoot, 'sample.pdf'), await document.save())

    const response = await documentRenderer.execute({
      protocolVersion: DocumentRendererProtocol.version,
      requestId: 'pdf-1',
      operation: 'render-pdf-page',
      projectRoot: temporaryRoot,
      inputPath: 'sample.pdf',
      outputPath: 'output/page-1.png',
      page: 1,
      scale: 1,
    })
    expect(response).toMatchObject({
      status: 'success',
      result: { kind: 'png', width: 320, height: 200, page: 1, pageCount: 1 },
    })
    expect((await readFile(join(temporaryRoot, 'output', 'page-1.png'))).subarray(1, 4).toString())
      .toBe('PNG')
  })

  test('项目里名叫 ..xxx 的目录照常渲染', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-renderer-dotdot-'))
    const document = await PDFDocument.create()
    document.addPage([160, 100])
    await mkdir(join(temporaryRoot, '..cache'), { recursive: true })
    await Bun.write(join(temporaryRoot, '..cache', 'sample.pdf'), await document.save())

    const response = await documentRenderer.execute({
      protocolVersion: DocumentRendererProtocol.version,
      requestId: 'dotdot',
      operation: 'render-pdf-page',
      projectRoot: temporaryRoot,
      inputPath: '..cache/sample.pdf',
      outputPath: '..cache/out/page-1.png',
      page: 1,
      scale: 1,
    })

    expect(response).toMatchObject({ status: 'success' })
    expect((await stat(join(temporaryRoot, '..cache', 'out', 'page-1.png'))).size)
      .toBeGreaterThan(100)
  })
})
