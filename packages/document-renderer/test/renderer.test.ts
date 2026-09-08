import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import ExcelJS from '../../office/node_modules/exceljs'
import { PDFDocument, rgb } from '../../office/node_modules/pdf-lib'
import { executeRendererRequest } from '../src/service'

const ProtocolVersion = 1 as const

describe('independent document renderer capability pack', () => {
  let temporaryRoot: string | undefined

  afterEach(async () => {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  })

  test('describes a standalone command protocol', async () => {
    const packageManifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    const response = await executeRendererRequest({
      protocolVersion: ProtocolVersion,
      requestId: 'describe-1',
      operation: 'describe',
    })
    expect(response).toMatchObject({
      status: 'success',
      result: {
        product: 'velar-document-renderer',
        version: packageManifest.version,
        transport: 'one-json-request-per-process',
      },
    })
  })

  test('renders a spreadsheet to HTML and PNG', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-renderer-office-'))
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Tasks')
    sheet.addRow(['Task', 'Status'])
    sheet.addRow(['Run a real command', 'Done'])
    await workbook.xlsx.writeFile(join(temporaryRoot, 'tasks.xlsx'))

    for (const extension of ['html', 'png']) {
      const response = await executeRendererRequest({
        protocolVersion: ProtocolVersion,
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

  test('renders one PDF page to PNG', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-renderer-pdf-'))
    const document = await PDFDocument.create()
    const page = document.addPage([320, 200])
    page.drawRectangle({ x: 32, y: 32, width: 256, height: 136, color: rgb(0.1, 0.5, 0.45) })
    await Bun.write(join(temporaryRoot, 'sample.pdf'), await document.save())

    const response = await executeRendererRequest({
      protocolVersion: ProtocolVersion,
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

  test('denies traversal and symlink escapes', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-renderer-policy-'))
    const externalRoot = await mkdtemp(join(tmpdir(), 'velar-renderer-external-'))
    try {
      await Bun.write(join(externalRoot, 'outside.pdf'), '%PDF-1.4\n%%EOF\n')
      await Bun.write(join(temporaryRoot, 'inside.pdf'), '%PDF-1.4\n%%EOF\n')
      await Bun.write(join(externalRoot, 'outside.png'), 'do not overwrite')
      await symlink(join(externalRoot, 'outside.pdf'), join(temporaryRoot, 'linked.pdf'))
      await symlink(join(externalRoot, 'outside.png'), join(temporaryRoot, 'linked-output.png'))

      const traversal = await executeRendererRequest({
        protocolVersion: ProtocolVersion,
        requestId: 'traversal',
        operation: 'render-pdf-page',
        projectRoot: temporaryRoot,
        inputPath: '../outside.pdf',
        outputPath: 'page.png',
      })
      expect(traversal).toMatchObject({ status: 'error', error: { code: 'PATH_DENIED' } })

      const symlinkEscape = await executeRendererRequest({
        protocolVersion: ProtocolVersion,
        requestId: 'symlink',
        operation: 'render-pdf-page',
        projectRoot: temporaryRoot,
        inputPath: 'linked.pdf',
        outputPath: 'page.png',
      })
      expect(symlinkEscape).toMatchObject({ status: 'error', error: { code: 'PATH_DENIED' } })

      const outputSymlinkEscape = await executeRendererRequest({
        protocolVersion: ProtocolVersion,
        requestId: 'output-symlink',
        operation: 'render-pdf-page',
        projectRoot: temporaryRoot,
        inputPath: 'inside.pdf',
        outputPath: 'linked-output.png',
      })
      expect(outputSymlinkEscape)
        .toMatchObject({ status: 'error', error: { code: 'PATH_DENIED' } })
      expect(await readFile(join(externalRoot, 'outside.png'), 'utf8')).toBe('do not overwrite')
    } finally {
      await rm(externalRoot, { recursive: true, force: true })
    }
  })
})
