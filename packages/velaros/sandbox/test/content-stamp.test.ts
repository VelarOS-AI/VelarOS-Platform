import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import type { SandboxManifest } from '../types/mirror'
import { applyMirrorChanges, diffMirror, mirrorTree, scanTree } from '../utils/mirror'

test.skipIf(process.platform === 'win32')('符号链接也受同一文件数量上限约束', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sandbox-link-limit-'))
  const source = join(directory, 'source')
  const root = join(directory, 'mirror')
  try {
    await mkdir(source)
    await mkdir(root)
    const target = join(directory, 'target')
    await writeFile(target, 'untouched')
    await symlink(target, join(source, 'first'))
    await symlink(target, join(source, 'second'))
    const failure = await mirrorTree(source, root, {
      ignored: 'copy',
      shouldSkip: async () => false,
      limits: { files: 1, bytes: 1000 },
    }).then(
      () => null,
      (error: unknown) => error
    )
    expect(failure).toMatchObject({ code: 'VALIDATION' })
    expect(await readFile(target, 'utf8')).toBe('untouched')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

for (const changed of ['mirror', 'source'] as const) {
  test(`same-size same-time ${changed} changes are not hidden by metadata`, async () => {
    const base = await mkdtemp(join(tmpdir(), 'sandbox-content-stamp-'))
    const source = join(base, 'source')
    const root = join(base, 'mirror')
    const time = new Date('2020-01-01T00:00:00Z')
    try {
      await mkdir(source)
      await mkdir(root)
      for (const dir of [source, root]) {
        await writeFile(join(dir, 'note.txt'), 'alpha')
        await utimes(join(dir, 'note.txt'), time, time)
      }
      const manifest = {
        version: 2,
        record: { id: 'fixture', source, root },
        files: await scanTree(source),
        mirror: await scanTree(root),
      } as SandboxManifest
      await writeFile(join(root, 'note.txt'), 'ALPHA')
      await utimes(join(root, 'note.txt'), time, time)
      if (changed === 'source') {
        await writeFile(join(source, 'note.txt'), 'other')
        await utimes(join(source, 'note.txt'), time, time)
      }
      const current = await scanTree(root)
      expect(current['note.txt']!.mtimeMs).toBe(manifest.mirror['note.txt']!.mtimeMs)
      expect(current['note.txt']!.size).toBe(manifest.mirror['note.txt']!.size)
      const diff = await diffMirror(manifest, current, {})
      expect(diff.modified).toEqual(['note.txt'])
      if (changed === 'mirror') {
        expect(diff.textDiffs?.[0]?.diff).toContain('+ALPHA')
        await applyMirrorChanges(manifest, diff, new AbortController().signal)
        expect(await readFile(join(source, 'note.txt'), 'utf8')).toBe('ALPHA')
      } else {
        await expect(
          applyMirrorChanges(manifest, diff, new AbortController().signal)
        ).rejects.toThrow()
        expect(await readFile(join(source, 'note.txt'), 'utf8')).toBe('other')
      }
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
}
