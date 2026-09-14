import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import { createNodeCommandProvider } from '../src/providers'
import { createProjectKernel } from '../src/runtime/project-kernel'
import { encodeProjectTextBuffer } from '../src/utils/text'

test('real search reaches every encoding beyond the listing page and retains a bounded cache through repeated full scans', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-search-scale-'))
  try {
    const fileCount = 5300
    for (let start = 0; start < fileCount; start += 100) {
      await Promise.all(Array.from({ length: Math.min(100, fileCount - start) }, (_, offset) =>
        writeFile(join(root, `${String(start + offset).padStart(5, '0')}.txt`), 'constant ascii source\n'.repeat(100))))
    }
    const project = await createProjectKernel({ root })
    const listed = new Set((await project.listFiles({ recursive: true, excludeGitignored: false })).map((entry) => entry.path))
    const all = await project.listFiles({ recursive: true, excludeGitignored: false, maxFiles: fileCount + 1 })
    const omitted = all.filter((entry) => entry.type === 'file' && !listed.has(entry.path)).slice(0, 7)
    expect(omitted).toHaveLength(7)
    const encodings = ['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'utf16le-nobom', 'utf16be-nobom', 'gb18030'] as const
    for (const [index, entry] of omitted.entries()) {
      await writeFile(join(root, entry.path), encodeProjectTextBuffer('source 中文🙂 needle literal \\n\n', encodings[index]!))
    }

    // Observe actual cache misses on this isolated kernel; no global FS mocks or timing threshold.
    const cache = Reflect.get(Reflect.get(project, 'store'), 'searchTextKinds') as Map<string, unknown>
    const originalGet = cache.get.bind(cache)
    let misses = 0
    cache.get = (key) => {
      const entry = originalGet(key)
      if (!entry) misses += 1
      return entry
    }
    const expected = omitted.map((entry) => entry.path).sort()
    for (const [index, query] of ['needle', '中文', '🙂'].entries()) {
      misses = 0
      const result = await project.search({ query, maxResults: 100, excludeGitignored: false })
      expect(result.backend).toBe('ripgrep')
      expect([...new Set(result.hits.map((hit) => hit.path))].sort()).toEqual(expected)
      expect(result.truncated).toBe(false)
      expect(cache.size).toBeGreaterThan(0)
      expect(cache.size).toBeLessThan(fileCount)
      if (index > 0) expect(misses).toBeLessThan(fileCount / 2)
    }
    const fallback = await project.search({ query: 'needle', maxResults: 100, excludeGitignored: false, useRipgrep: false })
    expect([...new Set(fallback.hits.map((hit) => hit.path))].sort()).toEqual(expected)
    expect(fallback.truncated).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('search traversal reaches encoded files below twenty directory levels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-search-depth-'))
  try {
    const directory = Array.from({ length: 24 }, (_, index) => `level-${index}`).join('/')
    await mkdir(join(root, directory), { recursive: true })
    const path = `${directory}/legacy.txt`
    await writeFile(join(root, path), encodeProjectTextBuffer('source 中文 deep-needle\n', 'gb18030'))
    const project = await createProjectKernel({ root })
    for (const useRipgrep of [true, false]) {
      const result = await project.search({ query: '中文', useRipgrep, excludeGitignored: false })
      expect(result.hits.map((hit) => hit.path)).toEqual([path])
      expect(result.truncated).toBe(false)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('native and decoded search respect search-only filters before counting visible results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-search-filter-'))
  try {
    for (const [path, encoding] of [['a-hidden.txt', 'utf8'], ['b-hidden.txt', 'gb18030'], ['z-visible.txt', 'utf8'], ['zz-visible.txt', 'gb18030']] as const) {
      await writeFile(join(root, path), encodeProjectTextBuffer('source 中文 needle\n', encoding))
    }
    const command = createNodeCommandProvider()
    const project = await createProjectKernel({ root, providers: {
      fileFilter: { shouldInclude: ({ path, action }) => action !== 'search' || !path.includes('hidden') },
      command: { run: (input) => command.run(input.command === 'rg'
        ? { ...input, args: ['--sort', 'path', ...(input.args ?? [])] }
        : input) },
    } })
    expect((await project.read({ path: 'a-hidden.txt' })).content).toContain('needle')
    for (const useRipgrep of [true, false]) {
      const result = await project.search({ query: 'needle', useRipgrep, maxResults: 10, excludeGitignored: false })
      expect(result.hits.map((hit) => hit.path).sort()).toEqual(['z-visible.txt', 'zz-visible.txt'])
      expect(result.truncated).toBe(false)
    }
    const limited = await project.search({ query: 'needle', maxResults: 1, excludeGitignored: false })
    expect(limited.hits.map((hit) => hit.path)).toEqual(['z-visible.txt'])
    expect(limited.truncated).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('real command output overflow remains an incomplete search even when every retained hit is filtered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-search-output-limit-'))
  try {
    const command = createNodeCommandProvider()
    const row = `${JSON.stringify({ type: 'match', data: {
      path: { text: 'not-listed.txt' }, lines: { text: 'needle\n' }, line_number: 1,
      submatches: [{ start: 0, end: 6 }],
    } })}\n`
    const repeated = Math.ceil(9 * 1024 * 1024 / row.length)
    const overflow = await command.run({ command: process.execPath,
      args: ['-e', `process.stdout.write(${JSON.stringify(row)}.repeat(${repeated}))`], timeoutMs: 10000,
    })
    expect(overflow.truncated).toBe(true)
    expect(overflow.timedOut).toBe(false)
    expect(overflow.stdout.length).toBeGreaterThan(0)
    expect(overflow.stdout.length).toBeLessThanOrEqual(8 * 1024 * 1024)
    const project = await createProjectKernel({ root, providers: {
      command: { run: (input) => input.command === 'rg' ? overflow : command.run(input) },
    } })
    const result = await project.search({ query: 'needle', maxResults: 10, excludeGitignored: false })
    expect(result.backend).toBe('ripgrep')
    expect(result.hits).toEqual([])
    expect(result.truncated).toBe(true)
    expect(result.diagnostics?.join(' ')).toContain('缓冲上限')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
