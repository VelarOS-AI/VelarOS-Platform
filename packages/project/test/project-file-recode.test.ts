import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { InMemoryContextPayloadStore } from '@velaros-ai/agent'
import { textCodec } from '@velaros-ai/text-files'

import type { ProjectToolContext } from '../src/contract/requires'
import { projectTools } from '../src/impl/ProjectTools'
import { createProjectKernel } from '../src/index'
import { registerProjectFileContext } from '../src/utils/agent/file-context'
import { finalizeProjectModelResult } from '../src/utils/agent/source-window'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-file-recode-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const kernel = await createProjectKernel({ root })
  const ctx: ProjectToolContext = {
    sessionId: 'project-recode',
    codingSession: {},
    contextPayloadStore: new InMemoryContextPayloadStore(),
    abortSignal: new AbortController().signal,
    project: {
      getRootPath: () => root,
      kernel: async () => kernel,
      prepareMutation: async () => ({ approved: true, message: '已授权' }),
      queryCode: async () => ({}),
      runCommand: async () => ({}) as never,
    },
    approval: { awaitConfirmationDecision: async () => ({ approved: true }) } as never,
  }
  registerProjectFileContext(ctx)
  let callId = 0
  const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const tool = projectTools[name]!
    const context = { ...ctx, toolCallId: `recode-${++callId}` }
    return finalizeProjectModelResult(context, await tool.execute(tool.schema.parse(args), context))
  }
  return { call, ctx, kernel }
}

const text = '第一行 🙂 C:\\src\\path 字面 \\n\r\nsecond line\r\n'
const bytes = (path: string) => readFile(join(root, path))

describe('project:edit recode', () => {
  test('paths 收 glob：按项目的列举规则展开；没匹配上、是目录、不存在都带下一步', async () => {
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs/a.txt'), textCodec.encode(text, 'gb18030'))
    await writeFile(join(root, 'docs/b.txt'), textCodec.encode(text, 'utf16le'))
    await writeFile(join(root, 'docs/keep.md'), 'untouched\n')
    const { call } = await fixture()
    const result = await call('project:edit', { action: 'apply', steps: [{ action: 'recode', paths: ['docs/*.txt'], newline: 'lf' }] })
    expect(result.recode.converted.map((entry: { path: string }) => entry.path).sort()).toEqual(['docs/a.txt', 'docs/b.txt'])
    expect(result.changedFiles.sort()).toEqual(['docs/a.txt', 'docs/b.txt'])
    expect(await readFile(join(root, 'docs/keep.md'), 'utf8')).toBe('untouched\n')

    await expect(call('project:edit', { action: 'apply', steps: [{ action: 'recode', paths: ['docs/*.rs'] }] }))
      .rejects.toMatchObject({ reason: 'TARGET_NOT_FOUND', suggestedNextAction: expect.stringContaining('project:list') })
    await expect(call('project:edit', { action: 'apply', steps: [{ action: 'recode', paths: ['docs'] }] }))
      .rejects.toMatchObject({ reason: 'NOT_SUPPORTED', suggestedNextAction: expect.stringContaining('project:list') })
    await expect(call('project:edit', { action: 'apply', steps: [{ action: 'recode', paths: ['docs/missing.txt'] }] }))
      .rejects.toMatchObject({ reason: 'TARGET_NOT_FOUND', suggestedNextAction: expect.stringContaining('project:list') })
  })

  test('converts mixed encodings to UTF-8 LF, keeps the text, reports formats, and undo restores the original bytes', async () => {
    await writeFile(join(root, 'gb.txt'), textCodec.encode(text, 'gb18030'))
    await writeFile(join(root, 'u16.txt'), textCodec.encode(text, 'utf16le'))
    await writeFile(join(root, 'bom.txt'), textCodec.encode(text, 'utf8-bom'))
    await writeFile(join(root, 'plain.txt'), 'already unicode\n')
    const { call } = await fixture()
    const result = await call('project:edit', { action: 'apply', steps: [{ action: 'recode', paths: ['gb.txt', 'u16.txt', 'bom.txt', 'plain.txt', 'gb.txt'], newline: 'lf' }] })
    expect(result.changed).toBe(true)
    expect(result.changedFiles.sort()).toEqual(['bom.txt', 'gb.txt', 'u16.txt'])
    expect(result.recode.unchanged).toEqual(['plain.txt'])
    expect(result.recode.converted).toEqual([
      { path: 'gb.txt', from: 'gb18030 crlf', to: 'utf-8 lf' },
      { path: 'u16.txt', from: 'utf-16le+bom crlf', to: 'utf-8 lf' },
      { path: 'bom.txt', from: 'utf-8+bom crlf', to: 'utf-8 lf' },
    ])
    const expected = Buffer.from(text.replaceAll('\r\n', '\n'), 'utf8')
    for (const path of ['gb.txt', 'u16.txt', 'bom.txt']) expect((await bytes(path)).equals(expected), path).toBe(true)
    expect(await readFile(join(root, 'plain.txt'), 'utf8')).toBe('already unicode\n')
    // 转换后的文件仍能正常读取和编辑，正文与原文一致。
    const read = await call('project:read', { files: [{ path: 'gb.txt' }] })
    expect(read.files[0].lines).toEqual([[1, '第一行 🙂 C:\\src\\path 字面 \\n'], [2, 'second line'], [3, '']])
    // 撤销恢复原始字节，包括 BOM 与 CRLF。
    const undone = await call('project:edit', { action: 'undo', changeRef: result.changeRef })
    expect(undone.error).toBeUndefined()
    expect((await bytes('gb.txt')).equals(textCodec.encode(text, 'gb18030'))).toBe(true)
    expect((await bytes('u16.txt')).equals(textCodec.encode(text, 'utf16le'))).toBe(true)
    expect((await bytes('bom.txt')).equals(textCodec.encode(text, 'utf8-bom'))).toBe(true)
  })

  test('targets UTF-16 with BOM and CRLF, skips files already in the target format, and rejects a BOM for gb18030', async () => {
    await writeFile(join(root, 'a.ts'), 'const a = "中文"\nconst b = 2\n')
    await writeFile(join(root, 'keep.txt'), 'plain\n')
    const { call } = await fixture()
    const result = await call('project:edit', { action: 'apply', steps: [{ action: 'recode', paths: ['a.ts'], encoding: 'utf-16le', bom: true, newline: 'crlf' }] })
    expect(result.changed).toBe(true)
    expect(result.recode.converted).toEqual([{ path: 'a.ts', from: 'utf-8 lf', to: 'utf-16le+bom crlf' }])
    expect((await bytes('a.ts')).equals(textCodec.encode('const a = "中文"\r\nconst b = 2\r\n', 'utf16le'))).toBe(true)
    const again = await call('project:edit', { action: 'apply', steps: [{ action: 'recode', paths: ['a.ts'], encoding: 'utf-16le', bom: true, newline: 'crlf' }] })
    expect(again).toMatchObject({ changed: false, changedFiles: [], recode: { converted: [], unchanged: ['a.ts'] } })
    const noop = await call('project:edit', { action: 'apply', steps: [{ action: 'recode', paths: ['keep.txt'] }] })
    expect(noop).toMatchObject({ changed: false, recode: { converted: [], unchanged: ['keep.txt'] } })
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('plain\n')
    await expect(call('project:edit', { action: 'apply', steps: [{ action: 'recode', paths: ['keep.txt'], encoding: 'gb18030', bom: true }] }))
      .rejects.toMatchObject({ reason: 'INVALID_INPUT', details: { executionOutcome: 'not-applied', stepIndex: 0 } })
    await expect(call('project:edit', { action: 'apply', steps: [{ action: 'recode', paths: ['missing.txt'] }] }))
      .rejects.toMatchObject({ reason: 'TARGET_NOT_FOUND', details: { pathIndex: 0, executionOutcome: 'not-applied' } })
  })

  test('recode inside an apply plan converts a disk file next to other steps and undo restores everything', async () => {
    await writeFile(join(root, 'legacy.txt'), textCodec.encode('legacy 内容\r\n', 'gb18030'))
    const { call } = await fixture()
    const result = await call('project:edit', { action: 'apply', steps: [
      { action: 'create', path: 'new.txt', text: 'created\n' }, { action: 'recode', paths: ['legacy.txt'], newline: 'lf' },
    ] })
    expect(result.changed).toBe(true)
    expect(result.recode.converted).toEqual([{ path: 'legacy.txt', from: 'gb18030 crlf', to: 'utf-8 lf' }])
    expect(await readFile(join(root, 'legacy.txt'), 'utf8')).toBe('legacy 内容\n')
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('created\n')
    await call('project:edit', { action: 'undo', changeRef: result.changeRef })
    expect((await bytes('legacy.txt')).equals(textCodec.encode('legacy 内容\r\n', 'gb18030'))).toBe(true)
  })
})
