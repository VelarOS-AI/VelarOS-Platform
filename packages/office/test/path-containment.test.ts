import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { z } from 'zod'

import type { OfficeToolContext } from '../src/index'
import { officeTools } from '../src/index'

interface Harness {
  root: string
  outside: string
  context: OfficeToolContext
}

const createdRoots: string[] = []

afterEach(async () => {
  for (const root of createdRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function createHarness(): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), 'velaros-office-containment-'))
  createdRoots.push(base)
  const root = join(base, 'workspace')
  const outside = join(base, 'outside')
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
  const context: OfficeToolContext = {
    abortSignal: new AbortController().signal,
    office: {
      getRootPath: () => root,
      prepareMutation: async () => ({
        approved: true,
        rootPath: root,
        switched: false,
        alreadyAuthorized: true,
        rejectionMessage: null,
        message: 'approved',
      }),
    },
  }
  return { root, outside, context }
}

async function writePdf(path: string, text: string): Promise<void> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  document.addPage([300, 200]).drawText(text, { x: 20, y: 150, size: 14, font })
  await writeFile(path, await document.save())
}

describe('office 路径包含门', () => {
  test('工作区里指向根外的符号链接不能把产物写出去', async () => {
    const harness = await createHarness()
    await symlink(harness.outside, join(harness.root, 'link'), 'dir')

    await expect(
      officeTools['office:create_spreadsheet'].execute(
        { outputPath: 'link/escaped.xlsx', content: 'name,value\nA,1' },
        harness.context
      )
    ).rejects.toMatchObject({ code: 'PERMISSION' })
    await expect(readFile(join(harness.outside, 'escaped.xlsx'))).rejects.toBeDefined()
  })

  test('已存在的符号链接文件不能被 overwrite 顺着链接覆盖', async () => {
    const harness = await createHarness()
    const victim = join(harness.outside, 'victim.xlsx')
    await writeFile(victim, 'ORIGINAL', 'utf8')
    await symlink(victim, join(harness.root, 'report.xlsx'))

    await expect(
      officeTools['office:create_spreadsheet'].execute(
        { outputPath: 'report.xlsx', overwrite: true, content: 'name,value\nA,1' },
        harness.context
      )
    ).rejects.toMatchObject({ code: 'PERMISSION' })
    expect(await readFile(victim, 'utf8')).toBe('ORIGINAL')
  })

  test('根内的普通相对路径照常写入', async () => {
    const harness = await createHarness()

    const result = await officeTools['office:create_spreadsheet'].execute(
      { outputPath: 'sheets/ok.xlsx', content: 'name,value\nA,1' },
      harness.context
    )

    expect(result).toMatchObject({ created: true, kind: 'xlsx' })
  })

  test('只读工具读不到工作区外的文件', async () => {
    const harness = await createHarness()
    await writePdf(join(harness.outside, 'secret.pdf'), 'SECRET-OUTSIDE')

    await expect(
      officeTools['office:extract_pdf_text'].execute(
        { inputPath: '../outside/secret.pdf' },
        harness.context
      )
    ).rejects.toMatchObject({ code: 'PERMISSION', message: expect.stringContaining('超出工作区') })
  })

  test('根内的相对路径照常读取', async () => {
    const harness = await createHarness()
    const inside = join(harness.root, 'docs')
    await mkdir(inside, { recursive: true })
    await writePdf(join(inside, 'paper.pdf'), 'INSIDE')

    const result = (await officeTools['office:extract_pdf_text'].execute(
      { inputPath: 'docs/paper.pdf' },
      harness.context
    )) as { pageCount: number; pages: Array<{ text: string }> }

    expect(result.pageCount).toBe(1)
    expect(result.pages[0]?.text).toContain('INSIDE')
  })

  test('十个工具的入参里都没有 cwd', () => {
    for (const [name, tool] of Object.entries(officeTools)) {
      const schema = z.toJSONSchema(tool.schema as z.ZodType, { io: 'input' }) as {
        properties?: Record<string, unknown>
      }
      expect(`${name}:${Object.hasOwn(schema.properties ?? {}, 'cwd')}`).toBe(`${name}:false`)
    }
  })
})
