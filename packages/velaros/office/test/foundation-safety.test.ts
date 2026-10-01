import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import type { OfficeOperationContext } from '../contract/requires'
import type { OfficeConvertersApi } from '../impl/operations/OfficeConverters'
import { OfficePdfOperations } from '../impl/operations/OfficePdfOperations'
import { officeWorkspace } from '../impl/operations/OfficeWorkspace'
import type { PdfjsRuntimeApi } from '../impl/runtime/PdfjsRuntime'
import { copyOfficeOutput, prepareOfficeOutputPath, writeOfficeFile } from '../utils/paths'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'office-foundation-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
test.each(['write', 'copy'])(
  'exclusive %s preserves a concurrently created output',
  async (kind) => {
    const output = await prepareOfficeOutputPath(root, 'report.docx', '.docx', false)
    await writeFile(output.path, 'other writer')
    const source = join(root, 'input')
    await writeFile(source, 'replacement')
    await expect(
      kind === 'write' ? writeOfficeFile(output, 'replacement') : copyOfficeOutput(output, source)
    ).rejects.toBeDefined()
    expect(await readFile(output.path, 'utf8')).toBe('other writer')
    expect((await readdir(root)).filter((name) => name.startsWith('.velaros-office-'))).toEqual([])
  }
)
test('competing exclusive outputs have exactly one winner', async () => {
  const a = await prepareOfficeOutputPath(root, 'report.docx', '.docx', false)
  const b = await prepareOfficeOutputPath(root, 'report.docx', '.docx', false)
  const result = await Promise.allSettled([writeOfficeFile(a, 'a'), writeOfficeFile(b, 'b')])
  expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
})

test('explicit overwrite publishes complete output while keeping the output identity', async () => {
  const path = join(root, 'report.docx')
  await writeFile(path, 'before')
  const output = await prepareOfficeOutputPath(root, path, '.docx', true)
  const result = await writeOfficeFile(output, 'complete')
  expect(result).toEqual({ path, bytes: 8, created: false })
  expect(await readFile(path, 'utf8')).toBe('complete')
})
test('cancellation during asynchronous preparation leaves no final output', async () => {
  const output = await prepareOfficeOutputPath(root, 'report.docx', '.docx')
  const abort = new AbortController()
  const writing = writeOfficeFile(output, 'unwanted', abort.signal)
  abort.abort()
  await expect(writing).rejects.toBeDefined()
  expect(await readdir(root)).toEqual([])
})
test('retargeting an output link after preparation cannot redirect an authorized overwrite', async () => {
  const a = join(root, 'a.docx')
  const b = join(root, 'b.docx')
  const link = join(root, 'link.docx')
  await writeFile(a, 'a')
  await writeFile(b, 'b')
  await symlink(a, link)
  const output = await prepareOfficeOutputPath(root, link, '.docx', true)
  await rm(link)
  await symlink(b, link)
  await expect(writeOfficeFile(output, 'replacement')).rejects.toBeDefined()
  expect(await readFile(a, 'utf8')).toBe('a')
  expect(await readFile(b, 'utf8')).toBe('b')
})

test.each(['cancel', 'output-race'])(
  'LaTeX %s after source publication preserves the applied source fact',
  async (failure) => {
    const abort = new AbortController()
    const converters = {
      findLatexCompiler: async () => ({ name: 'tectonic', available: true }),
      runLatexCompile: async ({ commands }: { commands: Array<{ args: string[] }> }) => {
        const args = commands[0].args
        const directory = args[args.indexOf('--outdir') + 1]
        await writeFile(join(directory, 'report.pdf'), '%PDF fixture')
        if (failure === 'cancel') abort.abort()
        else await writeFile(join(root, 'report.pdf'), 'other writer')
        return [{ success: true }]
      },
    } as unknown as OfficeConvertersApi
    const operations = new OfficePdfOperations(officeWorkspace, converters, {} as PdfjsRuntimeApi)
    let error: unknown
    try {
      await operations.latexToPdf(
        { outputPath: 'report.pdf', latexSource: 'source' },
        {
          abortSignal: abort.signal,
          office: { getRootPath: () => root } as OfficeOperationContext['office'],
        }
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({
      context: { executionOutcome: 'applied', applied: [join(root, 'report.tex')] },
    })
    expect((error as Error).message).toContain('report.tex')
    expect(await readFile(join(root, 'report.tex'), 'utf8')).toBe('source')
    if (failure === 'output-race')
      expect(await readFile(join(root, 'report.pdf'), 'utf8')).toBe('other writer')
  }
)
