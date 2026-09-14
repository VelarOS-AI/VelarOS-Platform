import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { compileProjectFile } from '../src/file-operations/planner'
import { atomicWriteProjectText } from '../src/files/atomic-writer'
import { detectBinaryByPrefix, hashFileAndDetectBinary, limitContent, readLimitedTextPrefix, readTextLineWindow } from '../src/files/file-reader'
import { readProjectTextFile } from '../src/files/text-stream'
import { createProjectKernel } from '../src/index'
import { detectProjectTextEncoding, encodeProjectTextBuffer, ProjectTextEncodingProbe } from '../src/utils/text'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-text-stream-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const encodings = ['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'utf16le-nobom', 'utf16be-nobom', 'gb18030'] as const

test.each(encodings)('complete and one-byte streaming probes agree for %s', (encoding) => {
  const original = 'long ascii source\r\n中文🙂e\u0301\\n\\uD800\r\n'
  const bytes = encodeProjectTextBuffer(original, encoding)
  const probe = new ProjectTextEncodingProbe()
  for (const byte of bytes) probe.push(Uint8Array.of(byte))
  expect(probe.finish()).toBe(encoding)
  expect(detectProjectTextEncoding(bytes)).toBe(encoding)
})

test.each(encodings)('bounded reads keep complete characters and literal escapes for %s', async (encoding) => {
  const content = 'long ascii source\r\n中文🙂\\n\\uD800\r\n'
  const path = join(root, 'source.txt')
  const bytes = encodeProjectTextBuffer(content, encoding)
  await writeFile(path, bytes)
  expect(await readProjectTextFile(path)).toBe(content)
  for (let maxBytes = 1; maxBytes <= 45; maxBytes += 1) {
    const prefix = await readLimitedTextPrefix(path, bytes.length, { maxBytes })
    expect(limitContent(prefix.content, maxBytes)).toEqual(limitContent(content, maxBytes))
  }
  expect(await readFile(path)).toEqual(bytes)
})

test('a budget inside a Chinese UTF-8 character cannot turn it into GB18030', async () => {
  const content = '中文🙂\n'
  const path = join(root, 'source.txt')
  await writeFile(path, content)
  for (const maxBytes of [1, 2, 4, 5, 7, 8, 9]) {
    const prefix = await readLimitedTextPrefix(path, Buffer.byteLength(content), { maxBytes })
    expect(prefix.content).toBe(content)
    if (maxBytes < 3) expect(() => limitContent(prefix.content, maxBytes)).toThrow()
    else expect(limitContent(prefix.content, maxBytes).content).toBe(content.slice(0, maxBytes < 6 ? 1 : 2))
  }
})

test.each(encodings)('64 KiB decoder boundaries and far line windows remain exact for %s', async (encoding) => {
  const content = `${'a'.repeat(65534)  }中文🙂\n${  'skip this line\n'.repeat(10000)  }last 中文🙂\\n\n`
  const path = join(root, 'source.txt')
  await writeFile(path, encodeProjectTextBuffer(content, encoding))
  expect(await readProjectTextFile(path)).toBe(content)
  const first = await readTextLineWindow(path, { startLine: 1 }, { maxChars: 65534 })
  expect(limitContent(first.content, undefined, 65534).content).toBe('a'.repeat(65534))
  const last = await readTextLineWindow(path, { startLine: 10002, endLine: 10002 })
  expect(last.content).toBe('last 中文🙂\\n')
})

test('binary metadata samples allow pending UTF-8 while complete hash probes validate EOF', async () => {
  const path = join(root, 'source.txt')
  const bytes = Buffer.from(`${'a'.repeat(7999)  }中\n`)
  await writeFile(path, bytes)
  expect(await detectBinaryByPrefix(path)).toBe(false)
  expect(await hashFileAndDetectBinary(path)).toMatchObject({ binary: false, textEncoding: 'utf8' })
  await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes, Buffer.from([0xf0, 0x9f])]))
  expect((await hashFileAndDetectBinary(path)).binary).toBe(true)
  await expect(readProjectTextFile(path)).rejects.toThrow()
})

test('long ASCII prefixes do not commit a legacy file to UTF-8 prematurely', async () => {
  const path = join(root, 'legacy.txt')
  const content = `${'a'.repeat(100000)  }中文\n`
  await writeFile(path, encodeProjectTextBuffer(content, 'gb18030'))
  expect(await readProjectTextFile(path)).toBe(content)
  const project = await createProjectKernel({ root, corePolicy: { maxFileSizeToReadBytes: 8 } })
  const read = await project.read({ path: 'legacy.txt', range: { startLine: 1, startColumn: 100001 }, maxChars: 2 })
  expect(read.content).toBe('中文')
})

test('an invalid existing encoding cannot be silently overwritten even with a fallback', async () => {
  const path = join(root, 'invalid.txt')
  const bytes = Buffer.from([0xff, 0xfe, 0x00, 0xd8])
  await writeFile(path, bytes)
  await expect(atomicWriteProjectText(path, 'replacement', 'utf8')).rejects.toThrow()
  expect(await readFile(path)).toEqual(bytes)
})

test('model file creation centralizes UTF-8 without BOM and LF while preserving source escapes', async () => {
  const project = await createProjectKernel({ root })
  const resolver = {
    resolveFileRef: async () => { throw new Error('unexpected ref') },
    readPath: async (path: string) => ({ ...(await project.read({ path })).snapshot, coverage: [] }),
    readText: async () => { throw new Error('recode is not part of this fixture') },
  }
  const prepared = await compileProjectFile({ actions: [{ op: 'create', path: 'new.txt', text: '\uFEFF中文🙂\r\n\\n\\u1234\r\n' }] }, resolver as never)
  const tx = await project.prepareEdit(prepared)
  await project.applyEdit({ transactionId: tx.transactionId })
  expect(await readFile(join(root, 'new.txt'))).toEqual(Buffer.from('中文🙂\n\\n\\u1234\n'))
})

test('real ripgrep and adapter searches expose the same decoded source across physical encodings', async () => {
  const content = 'long ascii source\r\n中文🙂 needle 中文\\n\r\n'
  for (const encoding of encodings) await writeFile(join(root, `${encoding}.txt`), encodeProjectTextBuffer(content, encoding))
  const project = await createProjectKernel({ root })
  for (const query of ['needle', '中文', '🙂']) {
    const fast = await project.search({ query, maxResults: 100, useRipgrep: true })
    const decoded = await project.search({ query, maxResults: 100, useRipgrep: false })
    expect(fast.backend).toBe('ripgrep')
    expect([...new Set(fast.hits.map((hit) => hit.path))].sort()).toEqual(encodings.map((encoding) => `${encoding}.txt`).sort())
    expect([...new Set(decoded.hits.map((hit) => hit.path))].sort()).toEqual(encodings.map((encoding) => `${encoding}.txt`).sort())
    for (const hit of fast.hits) {
      expect(hit.snippet).toContain('中文🙂 needle 中文\\n')
      expect('中文🙂 needle 中文\\n'.slice((hit.range?.startColumn ?? 1) - 1, (hit.range?.endColumn ?? 1) - 1)).toBe(query)
    }
  }
  // 相同长度的新编码仍必须使格式缓存失效。
  await writeFile(join(root, 'utf8.txt'), encodeProjectTextBuffer(content, 'gb18030'))
  expect((await project.search({ query: '中文', maxResults: 100 })).hits.some((hit) => hit.path === 'utf8.txt')).toBe(true)
})

test.each([4, 1000000])('explicit column ranges preserve Unicode and validate the real line under a %i byte snapshot limit', async (maxFileSizeToReadBytes) => {
  const project = await createProjectKernel({ root, corePolicy: { maxFileSizeToReadBytes } })
  await writeFile(join(root, 'long.txt'), `${'x'.repeat(100000)  }\n`)
  const result = await project.read({ path: 'long.txt', range: { startLine: 1, endLine: 1, endColumn: 90000 }, maxChars: 10 })
  expect(result.content).toBe('x'.repeat(10))
  expect(result.continuation?.range).toMatchObject({ startLine: 1, startColumn: 11, endLine: 1, endColumn: 90000 })
  await expect(project.read({ path: 'long.txt', range: { startLine: 1, endLine: 1, endColumn: 100002 }, maxChars: 10 })).rejects.toThrow()
  await writeFile(join(root, 'unicode.txt'), 'a🙂z\n')
  for (const [startColumn, endColumn] of [[3, 4], [1, 3]]) {
    await expect(project.read({ path: 'unicode.txt', range: { startLine: 1, endLine: 1, startColumn, endColumn } })).rejects.toMatchObject({ reason: 'INVALID_INPUT' })
  }
  expect((await project.read({ path: 'unicode.txt', range: { startLine: 1, endLine: 1, startColumn: 2, endColumn: 4 } })).content).toBe('🙂')
})

test.each(['utf16le-nobom', 'utf16be-nobom'] as const)('short ASCII %s uses explicit byte-order evidence', async (encoding) => {
  for (const text of ['a', 'a\n', '\r\n', 'x = 1\n']) {
    const path = join(root, 'short.txt')
    const bytes = encodeProjectTextBuffer(text, encoding)
    await writeFile(path, bytes)
    expect(detectProjectTextEncoding(bytes)).toBe(encoding)
    expect(await readProjectTextFile(path)).toBe(text)
  }
})

test('logical newline budgets keep CRLF atomic and continuation offsets physical', async () => {
  expect(limitContent('a\r\nb', 2)).toEqual({ content: 'a\r\n', consumedChars: 3, truncated: true, lineCount: 1 })
  expect(limitContent('\r\nb', undefined, 1)).toEqual({ content: '\r\n', consumedChars: 2, truncated: true, lineCount: 1 })
  await writeFile(join(root, 'lines.txt'), 'a\r\nb\r\nc')
  for (const maxFileSizeToReadBytes of [1, 100]) {
    const project = await createProjectKernel({ root, corePolicy: { maxFileSizeToReadBytes } })
    const first = await project.read({ path: 'lines.txt', maxBytes: 2 })
    expect(first.content).toBe('a\r\n')
    expect(first.continuation?.range).toMatchObject({ startLine: 2 })
    const second = await project.read(first.continuation!)
    expect(second.content).toBe('b\r\n')
    expect(second.continuation?.range).toMatchObject({ startLine: 3 })
  }
})
