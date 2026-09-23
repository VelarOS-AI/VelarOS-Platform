/**
 * 路径包含门的实现细节：按解开符号链接后的真实路径判「在不在工作区根里」，符号链接逃不出去、顺着链接覆盖不了根外的文件；
 * 根内的普通相对路径照常读写。对外承诺在 spec/acceptance.test.ts 的 INV-1；这里钉的是符号链接这类写法。
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import type { OfficeOperationContext } from '../index.js'
import { OfficeErrorCodes, officeOperations } from '../index.js'
import { pdfWithPages } from '../spec/support.js'

interface Harness {
  root: string
  outside: string
  context: OfficeOperationContext
}

const createdRoots: string[] = []

afterEach(async () => {
  for (const root of createdRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** 工作区根与它旁边的一个根外目录；外部命令一概没有，这里用不上。 */
async function createHarness(): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), 'velaros-office-containment-'))
  createdRoots.push(base)
  const root = join(base, 'workspace')
  const outside = join(base, 'outside')
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
  const context: OfficeOperationContext = {
    abortSignal: new AbortController().signal,
    office: {
      getRootPath: () => root,
      inspectEnvironment: async () => ({ commands: [] }),
      runCommand: async () => {
        throw new Error('路径包含门的测试不跑外部命令')
      },
    },
  }
  return { root, outside, context }
}

describe('office 路径包含门', () => {
  test('工作区里指向根外的符号链接不能把产物写出去', async () => {
    const harness = await createHarness()
    await symlink(harness.outside, join(harness.root, 'link'), 'dir')

    await expect(
      officeOperations.createSpreadsheet(
        { outputPath: 'link/escaped.xlsx', content: 'name,value\nA,1' },
        harness.context
      )
    ).rejects.toMatchObject({ code: OfficeErrorCodes.pathOutsideProject })
    await expect(readFile(join(harness.outside, 'escaped.xlsx'))).rejects.toBeDefined()
  })

  test('已存在的符号链接文件不能被 overwrite 顺着链接覆盖', async () => {
    const harness = await createHarness()
    const victim = join(harness.outside, 'victim.xlsx')
    await writeFile(victim, 'ORIGINAL', 'utf8')
    await symlink(victim, join(harness.root, 'report.xlsx'))

    await expect(
      officeOperations.createSpreadsheet(
        { outputPath: 'report.xlsx', overwrite: true, content: 'name,value\nA,1' },
        harness.context
      )
    ).rejects.toMatchObject({ code: OfficeErrorCodes.pathOutsideProject })
    expect(await readFile(victim, 'utf8')).toBe('ORIGINAL')
  })

  test('根内的普通相对路径照常写入', async () => {
    const harness = await createHarness()
    const result = await officeOperations.createSpreadsheet(
      { outputPath: 'sheets/ok.xlsx', content: 'name,value\nA,1' },
      harness.context
    )
    expect(result).toMatchObject({ path: join(harness.root, 'sheets/ok.xlsx'), created: true })
  })

  test('读不到工作区外的文件', async () => {
    const harness = await createHarness()
    await writeFile(join(harness.outside, 'secret.pdf'), await pdfWithPages(['SECRET-OUTSIDE']))

    await expect(
      officeOperations.readPdf({ inputPath: '../outside/secret.pdf' }, harness.context)
    ).rejects.toMatchObject({
      code: OfficeErrorCodes.pathOutsideProject,
      message: expect.stringContaining('工作区根'),
    })
  })

  test('根内的相对路径照常读取', async () => {
    const harness = await createHarness()
    await mkdir(join(harness.root, 'docs'), { recursive: true })
    await writeFile(join(harness.root, 'docs/paper.pdf'), await pdfWithPages(['INSIDE']))

    const result = await officeOperations.readPdf({ inputPath: 'docs/paper.pdf' }, harness.context)
    expect(result.pageCount).toBe(1)
    expect(result.pages[0]?.text).toContain('INSIDE')
  })

  test('幻灯片的背景图也按工作区根解析，根外的图拒绝', async () => {
    const harness = await createHarness()
    await writeFile(join(harness.outside, 'bg.png'), 'not really a png')

    await expect(
      officeOperations.createPresentation(
        {
          outputPath: 'deck.pptx',
          slides: [{ background: { path: '../outside/bg.png' }, elements: [] }],
        },
        harness.context
      )
    ).rejects.toMatchObject({ code: OfficeErrorCodes.pathOutsideProject })
    await expect(readFile(join(harness.root, 'deck.pptx'))).rejects.toBeDefined()
  })
})
