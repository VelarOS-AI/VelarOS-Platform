import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import { PDFDocument } from 'pdf-lib'

import { systemFileOperations } from '../src/impl/SystemFileOperations.js'
import type { SystemToolContext } from '../src/interface/requires.js'
import { shouldReapForegroundProcessGroupAfterExit } from '../src/utils/command-policy.js'
import { buildSystemProcessConfinementSpawnSpec, buildSystemSeatbeltProfile } from '../src/utils/confinement.js'

/** 一律批准的工具上下文：写入测试只关心内容，不走真实的用户确认。 */
const approvingContext: SystemToolContext = {
  abortSignal: new AbortController().signal,
  approval: {
    requestApproval: async () => ({ approved: true }),
  },
  system: {} as never,
} as SystemToolContext

/** 结果里取一项，是失败条目就抛出来，让断言直接看到原因。 */
function entryOf<T extends { path: string }>(result: { files: Array<T | { path: string; error: { code: string; message: string } }> }, index = 0): T {
  const entry = result.files[index]
  if (!entry) throw new Error(`no entry ${index}`)
  if ('error' in entry) throw new Error(`entry ${index} failed: ${entry.error.code} ${entry.error.message}`)
  return entry
}

/** 读一个文件的快捷方式。 */
async function readOne(file: { path: string; offset?: number; maxChars?: number; version?: string }) {
  return entryOf(await systemFileOperations.read({ files: [file] }))
}

describe('System capability', () => {

  test('builds deterministic platform confinement profiles with an observable backend', () => {
    const policy = {
      mode: 'workspace-write' as const,
      workspaceRoot: process.cwd(),
      writeRoots: [tmpdir()],
      network: false,
    }
    const mac = buildSystemProcessConfinementSpawnSpec(
      { spec: { file: '/bin/sh', args: ['-lc', 'true'] }, policy },
      { platform: 'darwin', sandboxExecPath: '/sandbox-exec', sandboxExecAvailable: true }
    )
    const linux = buildSystemProcessConfinementSpawnSpec(
      { spec: { file: '/bin/sh', args: ['-lc', 'true'] }, policy },
      { platform: 'linux', bubblewrapPath: '/bwrap', bubblewrapAvailable: true }
    )

    expect(mac.evidence).toMatchObject({
      mode: 'workspace-write',
      enforcement: 'full',
      backend: 'seatbelt',
      reason: 'enforced',
    })
    expect(mac.evidence.writableRoots).toContain(process.cwd())
    expect(mac.evidence.writableRoots).toHaveLength(2)
    expect(mac.spec.file).toBe('/sandbox-exec')
    expect(mac.profile).toBe(buildSystemSeatbeltProfile(policy))
    expect(mac.profile).toContain('(deny network*)')
    expect(mac.profile).toContain(`(subpath ${JSON.stringify(process.cwd())})`)
    expect(linux.evidence.backend).toBe('bubblewrap')
    expect(linux.spec.args).toContain('--unshare-net')
    expect(linux.spec.args).toContain(process.cwd())
  })

  test.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))(
    'enforces real Seatbelt workspace writes and blocks writes outside the approved root',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'velaros-seatbelt-root-'))
      const outside = await mkdtemp(join(tmpdir(), 'velaros-seatbelt-outside-'))
      try {
        const allowedPath = join(root, 'allowed.txt')
        const deniedPath = join(outside, 'denied.txt')
        const policy = { mode: 'workspace-write' as const, workspaceRoot: root }
        const allowed = buildSystemProcessConfinementSpawnSpec(
          {
            spec: { file: '/bin/sh', args: ['-lc', `printf allowed > '${allowedPath}'`] },
            policy,
          },
          { platform: 'darwin' }
        )
        const denied = buildSystemProcessConfinementSpawnSpec(
          {
            spec: { file: '/bin/sh', args: ['-lc', `printf denied > '${deniedPath}'`] },
            policy,
          },
          { platform: 'darwin' }
        )

        expect(spawnSync(allowed.spec.file, allowed.spec.args).status).toBe(0)
        expect(await readFile(allowedPath, 'utf8')).toBe('allowed')
        expect(spawnSync(denied.spec.file, denied.spec.args).status).not.toBe(0)
        expect(existsSync(deniedPath)).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
        await rm(outside, { recursive: true, force: true })
      }
    }
  )

  test('only reaps commands that launch a real shell background job', () => {
    expect(shouldReapForegroundProcessGroupAfterExit('printf one && printf two')).toBe(false)
    expect(shouldReapForegroundProcessGroupAfterExit('false || printf fallback')).toBe(false)
    expect(shouldReapForegroundProcessGroupAfterExit('printf value | wc -c')).toBe(false)
    expect(shouldReapForegroundProcessGroupAfterExit('server &')).toBe(true)
    expect(shouldReapForegroundProcessGroupAfterExit('server &; printf ready')).toBe(true)
    expect(shouldReapForegroundProcessGroupAfterExit('server &\nprintf ready')).toBe(true)
    expect(shouldReapForegroundProcessGroupAfterExit('nohup server &')).toBe(false)
  })

  test('reads text by character ranges and continues from range.end without splitting a surrogate pair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-'))
    const path = join(root, 'notes.txt')
    try {
      const text = 'héllo 中文😀 tail'
      await writeFile(path, text)
      const first = await readOne({ path, maxChars: 8 })
      expect(first.content).toBe('héllo 中文')
      expect(first.range).toEqual({ offset: 0, end: 8 })
      expect(first.hasMore).toBe(true)
      const second = await readOne({ path, offset: first.range.end, maxChars: 1 })
      expect(second.content).toBe('😀')
      expect(second.range).toEqual({ offset: 8, end: 10 })
      const rest = await readOne({ path, offset: second.range.end })
      expect(rest.content).toBe(' tail')
      expect(rest.hasMore).toBe(false)
      expect(rest.totalChars).toBe(text.length)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('decodes UTF-16 text and keeps its line endings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-utf16-'))
    const path = join(root, 'utf16.txt')
    try {
      await writeFile(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\r\nb', 'utf16le')]))
      const result = await readOne({ path })
      expect(result.content).toBe('a\r\nb')
      expect(result.encoding).toBe('utf16le')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('view hands images to the model whole and PDFs a few pages at a time, files one or many', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-view-'))
    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
      const imagePath = join(root, 'shot.png')
      await writeFile(imagePath, png)
      const viewedImage = await systemFileOperations.view({ files: [{ path: imagePath }] })
      expect(entryOf(viewedImage)).toEqual({ path: imagePath, kind: 'image', mediaType: 'image/png', bytes: png.byteLength })
      expect(viewedImage.modelContent).toEqual([
        { type: 'text', text: `文件 1/1：${imagePath}` },
        { type: 'image-data', data: png.toString('base64'), mediaType: 'image/png' },
      ])
      await expect(systemFileOperations.read({ files: [{ path: imagePath }] })).rejects.toThrow('system:view')

      const source = await PDFDocument.create()
      source.addPage([200, 100]).drawText('one')
      source.addPage([200, 100]).drawText('two')
      source.addPage([200, 100]).drawText('three')
      const pdfPath = join(root, 'report.pdf')
      await writeFile(pdfPath, Buffer.from(await source.save()))
      const pageCountOf = async (part: unknown): Promise<number> => (await PDFDocument.load(Buffer.from((part as { data: string }).data, 'base64'))).getPageCount()

      const secondOnly = await systemFileOperations.view({ files: [{ path: pdfPath, pages: [2] }] })
      expect(entryOf(secondOnly)).toEqual({ path: pdfPath, kind: 'document', mediaType: 'application/pdf', pages: [2], pageCount: 3, bytes: expect.any(Number) })
      expect(secondOnly.modelContent[0]).toEqual({ type: 'text', text: `文件 1/1：${pdfPath}（第 2 页，共 3 页）` })
      expect(secondOnly.modelContent[1]).toMatchObject({ type: 'file-data', mediaType: 'application/pdf', filename: 'report.p2.pdf' })
      expect(await pageCountOf(secondOnly.modelContent[1])).toBe(1)

      const several = await systemFileOperations.view({ files: [{ path: pdfPath, pages: [3, 1, 3] }] })
      expect(entryOf(several)).toMatchObject({ pages: [1, 3], pageCount: 3 })
      expect(several.modelContent[1]).toMatchObject({ filename: 'report.p1+3.pdf' })
      expect(await pageCountOf(several.modelContent[1])).toBe(2)
      const contiguous = await systemFileOperations.view({ files: [{ path: pdfPath, pages: [1, 2, 3] }] })
      expect(contiguous.modelContent[1]).toMatchObject({ filename: 'report.p1-3.pdf' })
      expect(await pageCountOf(contiguous.modelContent[1])).toBe(3)

      const defaulted = await systemFileOperations.view({ files: [{ path: pdfPath }] })
      expect(entryOf(defaulted)).toMatchObject({ pages: [1], pageCount: 3 })
      await expect(systemFileOperations.view({ files: [{ path: pdfPath, pages: [4] }] })).rejects.toThrow('out of range')

      const textPath = join(root, 'plain.txt')
      await writeFile(textPath, 'hello')
      await expect(systemFileOperations.view({ files: [{ path: textPath }] })).rejects.toThrow('system:read')

      // 一批里混着图片、PDF 和一个不存在的文件：失败的只标记它那一项，内容块按顺序排，每份 PDF 各自的 pages。
      const batch = await systemFileOperations.view({ files: [{ path: imagePath }, { path: join(root, 'missing.png') }, { path: pdfPath, pages: [2, 3] }] })
      expect(batch.files.map((entry) => ('error' in entry ? entry.error.code : entry.kind))).toEqual(['image', 'NOT_FOUND', 'document'])
      expect(entryOf(batch, 2)).toMatchObject({ pages: [2, 3], pageCount: 3 })
      expect(batch.modelContent.map((part) => part.type)).toEqual(['text', 'image-data', 'text', 'file-data'])
      expect(batch.modelContent[0]).toEqual({ type: 'text', text: `文件 1/3：${imagePath}` })
      expect(batch.modelContent[2]).toEqual({ type: 'text', text: `文件 3/3：${pdfPath}（第 2、3 页，共 3 页）` })
      await expect(systemFileOperations.view({ files: [{ path: join(root, 'a.png') }, { path: join(root, 'b.png') }] })).rejects.toThrow('not found')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('read takes a batch: one budget for the whole call, per-file offsets, and a failing file only marks its own entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-batch-'))
    try {
      const bigPath = join(root, 'big.txt')
      const smallPath = join(root, 'small.txt')
      await writeFile(bigPath, 'a'.repeat(200_000))
      await writeFile(smallPath, 'small')
      const budget = await systemFileOperations.read({ files: [{ path: bigPath }, { path: smallPath }] })
      expect(entryOf(budget, 0)).toMatchObject({ totalChars: 200_000, hasMore: false, range: { offset: 0, end: 200_000 } })
      expect(entryOf(budget, 1)).toMatchObject({ content: '', range: { offset: 0, end: 0 }, totalChars: 5, hasMore: true })

      const continued = await systemFileOperations.read({ files: [{ path: bigPath, offset: 199_998 }, { path: smallPath, offset: entryOf(budget, 1).range.end, maxChars: 3 }] })
      expect(entryOf(continued, 0)).toMatchObject({ content: 'aa', hasMore: false })
      expect(entryOf(continued, 1)).toMatchObject({ content: 'sma', range: { offset: 0, end: 3 }, hasMore: true })

      const mixed = await systemFileOperations.read({ files: [{ path: smallPath }, { path: join(root, 'missing.txt') }] })
      expect(entryOf(mixed, 0).content).toBe('small')
      expect(mixed.files[1]).toEqual({ path: join(root, 'missing.txt'), error: { code: 'NOT_FOUND', message: expect.stringContaining('not found') } })
      await expect(systemFileOperations.read({ files: [{ path: join(root, 'x.txt') }, { path: join(root, 'y.txt') }] })).rejects.toThrow('not found')
      await expect(systemFileOperations.read({ files: [] })).rejects.toThrow('files is empty')
      await expect(systemFileOperations.read({ files: Array.from({ length: 21 }, () => ({ path: smallPath })) })).rejects.toThrow('At most 20 files')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects directories, other binaries and device files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-reject-'))
    try {
      await expect(systemFileOperations.read({ files: [{ path: root }] })).rejects.toThrow('is a directory')
      const binaryPath = join(root, 'blob.bin')
      await writeFile(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0xff]))
      await expect(systemFileOperations.read({ files: [{ path: binaryPath }] })).rejects.toThrow('binary')
      if (process.platform !== 'win32') {
        await expect(systemFileOperations.read({ files: [{ path: '/dev/null' }] })).rejects.toThrow('not a regular file')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('edit writes whole files, replaces within the read range, and hands back the new text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-edit-'))
    const path = join(root, 'nested', 'config.toml')
    try {
      const written = await systemFileOperations.edit({ path, newText: 'name = "a"\nport = 80\nport = 80\n' }, approvingContext)
      expect(written).toMatchObject({ action: 'written', created: true, previousVersion: null })
      if (written.action !== 'written') throw new Error('expected written')
      expect(written.version).toMatch(/^[0-9a-f]{12}$/)
      expect(await readFile(path, 'utf8')).toBe('name = "a"\nport = 80\nport = 80\n')

      await expect(
        systemFileOperations.edit({ path, oldText: 'port = 80', newText: 'port = 8080' }, approvingContext)
      ).rejects.toThrow('read the file first')

      const whole = await readOne({ path })
      const ambiguous = await systemFileOperations.edit({ path, range: whole.range, oldText: 'port = 80', newText: 'port = 8080' }, approvingContext)
      if (ambiguous.action !== 'ambiguous') throw new Error('expected anchors')
      expect(ambiguous.matchCount).toBe(2)
      expect(ambiguous.anchors.map((anchor) => anchor.range)).toEqual([{ offset: 11, end: 20 }, { offset: 21, end: 30 }])
      expect(ambiguous.anchors[1]!.context).toContain('port = 80\n')
      expect(await readFile(path, 'utf8')).toBe('name = "a"\nport = 80\nport = 80\n')

      const confirmed = await systemFileOperations.edit(
        { path, range: ambiguous.anchors[1]!.range, oldText: 'port = 80', newText: 'port = 8080' },
        approvingContext
      )
      expect(confirmed).toMatchObject({ action: 'replaced', content: 'port = 8080', range: { offset: 21, end: 32 }, previousVersion: written.version })
      expect(await readFile(path, 'utf8')).toBe('name = "a"\nport = 80\nport = 8080\n')

      const recalled = await readOne({ path, version: written.version })
      expect(recalled.content).toBe('name = "a"\nport = 80\nport = 80\n')
      expect(recalled.version).toBe(written.version)
      await expect(systemFileOperations.read({ files: [{ path, version: 'nope' }] })).rejects.toThrow('not in history')

      const window = await readOne({ path, offset: 11, maxChars: 10 })
      expect(window.content).toBe('port = 80\n')
      const replaced = await systemFileOperations.edit(
        { path, range: window.range, oldText: 'port = 80', newText: 'port = 8080' },
        approvingContext
      )
      expect(replaced).toMatchObject({ action: 'replaced', content: 'port = 8080\n', range: { offset: 11, end: 23 } })
      expect(await readFile(path, 'utf8')).toBe('name = "a"\nport = 8080\nport = 8080\n')

      const swapped = await systemFileOperations.edit({ path, range: { offset: 0, end: 11 }, newText: 'name = "b"\n' }, approvingContext)
      expect(swapped).toMatchObject({ action: 'replaced', content: 'name = "b"\n' })
      expect(await readFile(path, 'utf8')).toBe('name = "b"\nport = 8080\nport = 8080\n')

      const overwritten = await systemFileOperations.edit({ path, newText: 'fresh\n' }, approvingContext)
      expect(overwritten).toMatchObject({ action: 'written', created: false })
      if (overwritten.action !== 'written') throw new Error('expected written')
      expect(await readFile(path, 'utf8')).toBe('fresh\n')

      const restored = await systemFileOperations.edit({ path, restore: written.version }, approvingContext)
      expect(restored).toMatchObject({ action: 'restored', version: written.version, previousVersion: overwritten.version })
      expect(await readFile(path, 'utf8')).toBe('name = "a"\nport = 80\nport = 80\n')
      await expect(systemFileOperations.edit({ path, restore: 'nope' }, approvingContext)).rejects.toThrow('not in history')
      await expect(systemFileOperations.edit({ path, restore: written.version, newText: 'x' }, approvingContext)).rejects.toThrow('restore goes alone')
      await expect(systemFileOperations.edit({ path }, approvingContext)).rejects.toThrow('newText is required')

      await expect(
        systemFileOperations.edit({ path, range: { offset: 0, end: 6 }, oldText: 'missing', newText: 'x' }, approvingContext)
      ).rejects.toThrow('not found within range')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('adapts a replacement to CRLF files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-edit-crlf-'))
    const path = join(root, 'lines.txt')
    try {
      await writeFile(path, 'a\r\nb\r\nc\r\n')
      const result = await systemFileOperations.edit({ path, range: { offset: 0, end: 9 }, oldText: 'a\nb', newText: 'x\ny' }, approvingContext)
      expect(result.action).toBe('replaced')
      expect(await readFile(path, 'utf8')).toBe('x\r\ny\r\nc\r\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

})
