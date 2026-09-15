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
      const first = await systemFileOperations.read({ path, maxChars: 8 })
      expect(first.content).toBe('héllo 中文')
      expect(first.range).toEqual({ offset: 0, end: 8 })
      expect(first.hasMore).toBe(true)
      const second = await systemFileOperations.read({ path, offset: first.range.end, maxChars: 1 })
      expect(second.content).toBe('😀')
      expect(second.range).toEqual({ offset: 8, end: 10 })
      const rest = await systemFileOperations.read({ path, offset: second.range.end })
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
      const result = await systemFileOperations.read({ path })
      expect(result.content).toBe('a\r\nb')
      expect(result.encoding).toBe('utf16le')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('view hands images to the model whole and PDFs one page at a time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-view-'))
    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
      const imagePath = join(root, 'shot.png')
      await writeFile(imagePath, png)
      const image = await systemFileOperations.view({ path: imagePath })
      expect(image.kind).toBe('image')
      if (image.kind !== 'image') throw new Error('expected image')
      expect(image.mediaType).toBe('image/png')
      expect(image.bytes).toBe(png.byteLength)
      expect(image.modelContent).toEqual([{ type: 'image-data', data: png.toString('base64'), mediaType: 'image/png' }])
      await expect(systemFileOperations.read({ path: imagePath })).rejects.toThrow('system:view')

      const source = await PDFDocument.create()
      source.addPage([200, 100]).drawText('one')
      source.addPage([200, 100]).drawText('two')
      const pdfPath = join(root, 'report.pdf')
      await writeFile(pdfPath, Buffer.from(await source.save()))
      const second = await systemFileOperations.view({ path: pdfPath, page: 2 })
      expect(second.kind).toBe('document')
      if (second.kind !== 'document') throw new Error('expected document')
      expect(second).toMatchObject({ page: 2, pageCount: 2, mediaType: 'application/pdf' })
      expect(second.modelContent[0]).toMatchObject({ type: 'file-data', mediaType: 'application/pdf', filename: 'report.page2.pdf' })
      const extracted = await PDFDocument.load(Buffer.from((second.modelContent[0] as { data: string }).data, 'base64'))
      expect(extracted.getPageCount()).toBe(1)
      const first = await systemFileOperations.view({ path: pdfPath })
      if (first.kind !== 'document') throw new Error('expected document')
      expect(first.page).toBe(1)
      await expect(systemFileOperations.view({ path: pdfPath, page: 3 })).rejects.toThrow('out of range')

      const textPath = join(root, 'plain.txt')
      await writeFile(textPath, 'hello')
      await expect(systemFileOperations.view({ path: textPath })).rejects.toThrow('system:read')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects directories, other binaries and device files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-reject-'))
    try {
      await expect(systemFileOperations.read({ path: root })).rejects.toThrow('is a directory')
      const binaryPath = join(root, 'blob.bin')
      await writeFile(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0xff]))
      await expect(systemFileOperations.read({ path: binaryPath })).rejects.toThrow('binary')
      if (process.platform !== 'win32') {
        await expect(systemFileOperations.read({ path: '/dev/null' })).rejects.toThrow('not a regular file')
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

      const whole = await systemFileOperations.read({ path })
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

      const recalled = await systemFileOperations.read({ path, version: written.version })
      expect(recalled.content).toBe('name = "a"\nport = 80\nport = 80\n')
      expect(recalled.version).toBe(written.version)
      await expect(systemFileOperations.read({ path, version: 'nope' })).rejects.toThrow('not in history')

      const window = await systemFileOperations.read({ path, offset: 11, maxChars: 10 })
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
