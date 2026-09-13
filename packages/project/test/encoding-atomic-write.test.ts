import { chmod, link, lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { atomicWriteProjectText } from '../src/files/atomic-writer'
import { createProjectKernel } from '../src/index'
import { decodeProjectTextBuffer, encodeProjectTextBuffer } from '../src/utils/text'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-atomic-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('lossless text and atomic replacement', () => {
  test.each([
    Buffer.from([0xEF, 0xBB, 0xBF, 0xF0, 0x9F]),
    Buffer.from([0xFF, 0xFE, 0x41]),
    Buffer.from([0xFE, 0xFF, 0xD8, 0x00]),
    Buffer.from([0xFF, 0xFE, 0x00, 0xDC]),
    Buffer.concat([Buffer.from('long ascii content', 'utf16le'), Buffer.from([0x41])]),
  ])('refuses malformed byte sequences rather than replacing characters: %j', (bytes) => {
    expect(decodeProjectTextBuffer(bytes)).toBeNull()
  })

  test.each(['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'utf16le-nobom', 'utf16be-nobom', 'gb18030'] as const)('preserves %s bytes, mode, symlink, and rollback', async (encoding) => {
    const path = join(root, 'source.txt')
    const original = encodeProjectTextBuffer('long ascii content\r\n中文🙂\\n\\uD800\r\n', encoding)
    await writeFile(path, original)
    await chmod(path, 0o751)
    await symlink('source.txt', join(root, 'alias.txt'))
    await atomicWriteProjectText(join(root, 'alias.txt'), 'changed ascii content\r\n中文🙂\\n\\uD800\r\n')
    expect((await lstat(join(root, 'alias.txt'))).isSymbolicLink()).toBe(true)
    expect((await stat(path)).mode & 0o777).toBe(0o751)
    expect(await readFile(path)).toEqual(encodeProjectTextBuffer('changed ascii content\r\n中文🙂\\n\\uD800\r\n', encoding))
    expect((await readdir(root)).sort()).toEqual(['alias.txt', 'source.txt'])
  })

  test.each(['\uD800', '\uDC00', 'valid🙂then\uD800bad'])('rejects malformed input before changing disk: %j', async (content) => {
    const path = join(root, 'source.txt')
    const original = Buffer.from('\uFEFForiginal\r\n', 'utf16le')
    await writeFile(path, original)
    await expect(atomicWriteProjectText(path, content)).rejects.toMatchObject({ reason: 'INVALID_INPUT' })
    expect(await readFile(path)).toEqual(original)
    expect(await readdir(root)).toEqual(['source.txt'])
  })

  test('rejects a malformed late operation before an earlier valid edit is applied', async () => {
    await writeFile(join(root, 'source.txt'), 'original')
    const project = await createProjectKernel({ root })
    await expect(project.prepareEdit({ operations: [
      { operation: { type: 'replace_text', path: 'source.txt', oldText: 'original', newText: 'changed' } },
      { operation: { type: 'create_file', path: 'broken.txt', content: '\uD800' } },
    ] })).rejects.toMatchObject({ reason: 'INVALID_INPUT', details: { operationIndex: 1, written: false } })
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('original')
    expect(await Bun.file(join(root, 'broken.txt')).exists()).toBe(false)
  })

  test('does not silently break hard-link semantics', async () => {
    await writeFile(join(root, 'source.txt'), 'original')
    await link(join(root, 'source.txt'), join(root, 'alias.txt'))
    await expect(atomicWriteProjectText(join(root, 'source.txt'), 'changed')).rejects.toMatchObject({ reason: 'NOT_SUPPORTED' })
    expect(await readFile(join(root, 'alias.txt'), 'utf8')).toBe('original')
  })
})
