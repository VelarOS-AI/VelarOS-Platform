/**
 * `velar:project` 的 edit 里的 recode：只重写字节、正文不变，已是目标格式的跳过，撤销逐字节恢复。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { textCodec } from '@velaros-ai/text-files'

import { failureOf, projectToolFixture } from './support/tools'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-file-recode-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const text = '第一行 🙂 C:\\src\\path 字面 \\n\r\nsecond line\r\n'
const bytes = (path: string) => readFile(join(root, path))

describe('edit 的 recode', () => {
  test('混着的编码统一成 UTF-8 LF：正文不变，回执说清各自从什么转成什么，撤销恢复原来的字节', async () => {
    await writeFile(join(root, 'gb.txt'), textCodec.encode(text, 'gb18030'))
    await writeFile(join(root, 'u16.txt'), textCodec.encode(text, 'utf16le'))
    await writeFile(join(root, 'bom.txt'), textCodec.encode(text, 'utf8-bom'))
    await writeFile(join(root, 'plain.txt'), 'already unicode\n')
    const { call } = await projectToolFixture({ root })
    const result = await call('project', 'edit', { steps: [{ action: 'recode', paths: ['gb.txt', 'u16.txt', 'bom.txt', 'plain.txt', 'gb.txt'], newline: 'lf' }] })
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
    // 转换后的文件照常读、照常改，正文与原文一致。
    const read = await call('project', 'read', { files: [{ path: 'gb.txt' }] })
    expect(read.files[0].lines).toEqual([[1, '第一行 🙂 C:\\src\\path 字面 \\n'], [2, 'second line']])
    // 撤销恢复原始字节，包括 BOM 与 CRLF。
    await call('project', 'undo', { changeRef: result.changeRef })
    expect((await bytes('gb.txt')).equals(textCodec.encode(text, 'gb18030'))).toBe(true)
    expect((await bytes('u16.txt')).equals(textCodec.encode(text, 'utf16le'))).toBe(true)
    expect((await bytes('bom.txt')).equals(textCodec.encode(text, 'utf8-bom'))).toBe(true)
  })

  test('转成带 BOM 的 UTF-16、CRLF；已是目标格式的跳过、不开事务；gb18030 不收 BOM', async () => {
    await writeFile(join(root, 'a.ts'), 'const a = "中文"\nconst b = 2\n')
    await writeFile(join(root, 'keep.txt'), 'plain\n')
    const { call, mutations } = await projectToolFixture({ root })
    const recode = { action: 'recode', paths: ['a.ts'], encoding: 'utf-16le', bom: true, newline: 'crlf' }
    const result = await call('project', 'edit', { steps: [recode] })
    expect(result.changed).toBe(true)
    expect(result.recode.converted).toEqual([{ path: 'a.ts', from: 'utf-8 lf', to: 'utf-16le+bom crlf' }])
    expect((await bytes('a.ts')).equals(textCodec.encode('const a = "中文"\r\nconst b = 2\r\n', 'utf16le'))).toBe(true)
    const again = await call('project', 'edit', { steps: [recode] })
    expect(again).toMatchObject({ changeRef: '', changed: false, changedFiles: [], recode: { converted: [], unchanged: ['a.ts'] } })
    const noop = await call('project', 'edit', { steps: [{ action: 'recode', paths: ['keep.txt'] }] })
    expect(noop).toMatchObject({ changed: false, recode: { converted: [], unchanged: ['keep.txt'] } })
    // 什么都不用写时不问修改授权。
    expect(mutations).toHaveLength(1)
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('plain\n')
    const bom = await failureOf(call('project', 'edit', { steps: [{ action: 'recode', paths: ['keep.txt'], encoding: 'gb18030', bom: true }] }))
    expect(bom.code).toBe('INVALID_INPUT')
    expect(bom.message).toStartWith('steps[0]')
    expect(bom.message).toContain('BOM')
  })

  test('目录、不存在的路径都拒绝，下一步是先 list 出准确的文件路径', async () => {
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs/a.txt'), textCodec.encode(text, 'gb18030'))
    const { call } = await projectToolFixture({ root })
    const directory = await failureOf(call('project', 'edit', { steps: [{ action: 'recode', paths: ['docs'] }] }))
    expect(directory.code).toBe('NOT_SUPPORTED')
    expect(directory.message).toContain('list')
    const missing = await failureOf(call('project', 'edit', { steps: [{ action: 'recode', paths: ['docs/missing.txt'] }] }))
    expect(missing.code).toBe('TARGET_NOT_FOUND')
    expect(missing.message).toContain('docs/missing.txt')
    expect(missing.message).toContain('list')
    expect((await bytes('docs/a.txt')).equals(textCodec.encode(text, 'gb18030'))).toBe(true)
  })

  test('recode 和别的步骤合成一个事务，撤销一起恢复', async () => {
    await writeFile(join(root, 'legacy.txt'), textCodec.encode('legacy 内容\r\n', 'gb18030'))
    const { call } = await projectToolFixture({ root })
    const result = await call('project', 'edit', { steps: [
      { action: 'create', path: 'new.txt', text: 'created\n' }, { action: 'recode', paths: ['legacy.txt'], newline: 'lf' },
    ] })
    expect(result.changed).toBe(true)
    expect(result.recode.converted).toEqual([{ path: 'legacy.txt', from: 'gb18030 crlf', to: 'utf-8 lf' }])
    expect(await readFile(join(root, 'legacy.txt'), 'utf8')).toBe('legacy 内容\n')
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('created\n')
    await call('project', 'undo', { changeRef: result.changeRef })
    expect((await bytes('legacy.txt')).equals(textCodec.encode('legacy 内容\r\n', 'gb18030'))).toBe(true)
    await expect(readFile(join(root, 'new.txt'))).rejects.toThrow()
  })
})
