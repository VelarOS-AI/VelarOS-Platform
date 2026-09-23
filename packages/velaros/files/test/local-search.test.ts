import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createIgnorePolicy } from '@velaros-ai/core/path-rules'

import { createLocalFileSearch } from '../impl/LocalFileSearch.js'
import { shouldSkipProtectedSearchDirectory, shouldSkipSearchEntry } from '../utils/search.js'

describe('Local file search visibility', () => {
  test('owns generic search filtering without Workspace imports', () => {
    expect(shouldSkipSearchEntry('.git', true, false)).toBe(true)
    expect(shouldSkipSearchEntry('node_modules', true, true)).toBe(true)
    expect(shouldSkipSearchEntry('src', true, false)).toBe(false)
    expect(shouldSkipSearchEntry('.git', true, false, true)).toBe(false)
  })

  test('protects direct macOS TCC roots but allows nested requested roots', () => {
    expect(
      shouldSkipProtectedSearchDirectory({
        platform: 'darwin',
        homeDir: '/Users/example',
        rootPath: '/Users/example',
        candidatePath: '/Users/example/Library',
      })
    ).toBe(true)
    expect(
      shouldSkipProtectedSearchDirectory({
        platform: 'darwin',
        homeDir: '/Users/example',
        rootPath: '/Users/example/Library',
        candidatePath: '/Users/example/Library',
      })
    ).toBe(false)
    expect(
      shouldSkipProtectedSearchDirectory({
        platform: 'win32',
        homeDir: 'C:\\Users\\example',
        rootPath: 'C:\\Users\\example',
        candidatePath: 'C:\\Users\\example\\Library',
      })
    ).toBe(false)
  })

  test('按公共件的忽略策略判定仓库内的条目', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'velaros-file-search-'))
    try {
      await mkdir(join(rootPath, '.git'))
      await mkdir(join(rootPath, 'ignored'))
      await writeFile(
        join(rootPath, '.gitignore'),
        ['ignored/', '*.log', '!important.log'].join('\n')
      )

      const policy = createIgnorePolicy(rootPath, { rulesFrom: 'repository' })
      expect(await policy.shouldSkip(join(rootPath, 'ignored'), true)).toBe(true)
      expect(await policy.shouldSkip(join(rootPath, 'debug.log'), false)).toBe(true)
      expect(await policy.shouldSkip(join(rootPath, 'important.log'), false)).toBe(false)

      const unrestrictedPolicy = createIgnorePolicy(rootPath, {
        rulesFrom: 'repository',
        unrestricted: true,
      })
      expect(await unrestrictedPolicy.shouldSkip(join(rootPath, 'ignored'), true)).toBe(false)
    } finally {
      await rm(rootPath, { recursive: true, force: true })
    }
  })

  test('global path search reports truncated only when more matches exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-file-search-'))
    try {
      for (const name of ['file1.txt', 'file2.txt', 'file3.txt'])
        await writeFile(join(root, name), name)
      const search = createLocalFileSearch({ homeDir: root })
      const capped = await search.search(root, { query: 'file', limit: 2 })
      expect(capped.count).toBe(2)
      expect(capped.truncated).toBe(true)
      const complete = await search.search(root, { query: 'file', limit: 3 })
      expect(complete.count).toBe(3)
      expect(complete.truncated).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')(
    'content search skips pipes instead of hanging on them',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'velaros-file-search-fifo-'))
      try {
        const pipe = join(root, 'pipe')
        expect(spawnSync('mkfifo', [pipe]).status).toBe(0)
        await writeFile(join(root, 'a.txt'), 'needle\n')
        // 原来读命名管道会一直挂着，abort 也收不回。
        const found = await createLocalFileSearch({ homeDir: root }).search(root, {
          query: 'needle',
          mode: 'content',
        })
        expect(found.matches?.map((match) => match.path)).toEqual(['a.txt'])
        expect((await lstat(pipe)).isFIFO()).toBe(true)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
