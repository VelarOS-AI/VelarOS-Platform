import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  describe,
  expect,
  test,
} from 'bun:test'

import { createSystemSearchIgnorePolicy } from '../src/atomic/SystemSearchIgnorePolicy'
import {
  shouldSkipSystemSearchEntry,
  shouldSkipSystemSearchProtectedDirectory,
} from '../src/atomic/SystemSearchVisibility'

describe('System search visibility', () => {
  test('owns generic search filtering without Workspace imports', () => {
    expect(shouldSkipSystemSearchEntry('.git', true, false)).toBe(true)
    expect(shouldSkipSystemSearchEntry('node_modules', true, true)).toBe(true)
    expect(shouldSkipSystemSearchEntry('src', true, false)).toBe(false)
    expect(shouldSkipSystemSearchEntry('.git', true, false, true)).toBe(false)
  })

  test('protects direct macOS TCC roots but allows nested requested roots', () => {
    expect(shouldSkipSystemSearchProtectedDirectory({
      platform: 'darwin',
      homeDir: '/Users/example',
      rootPath: '/Users/example',
      candidatePath: '/Users/example/Library',
    })).toBe(true)
    expect(shouldSkipSystemSearchProtectedDirectory({
      platform: 'darwin',
      homeDir: '/Users/example',
      rootPath: '/Users/example/Library',
      candidatePath: '/Users/example/Library',
    })).toBe(false)
    expect(shouldSkipSystemSearchProtectedDirectory({
      platform: 'win32',
      homeDir: 'C:\\Users\\example',
      rootPath: 'C:\\Users\\example',
      candidatePath: 'C:\\Users\\example\\Library',
    })).toBe(false)
  })

  test('owns repository ignore policy without Core utilities', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'velaros-system-search-'))
    try {
      await mkdir(join(rootPath, '.git'))
      await mkdir(join(rootPath, 'ignored'))
      await writeFile(
        join(rootPath, '.gitignore'),
        ['ignored/', '*.log', '!important.log'].join('\n'),
      )

      const policy = await createSystemSearchIgnorePolicy(rootPath)
      expect(await policy.shouldSkip(join(rootPath, 'ignored'), true)).toBe(true)
      expect(await policy.shouldSkip(join(rootPath, 'debug.log'), false)).toBe(true)
      expect(await policy.shouldSkip(join(rootPath, 'important.log'), false)).toBe(false)

      const unrestrictedPolicy = await createSystemSearchIgnorePolicy(rootPath, {
        unrestricted: true,
      })
      expect(await unrestrictedPolicy.shouldSkip(join(rootPath, 'ignored'), true)).toBe(false)
    } finally {
      await rm(rootPath, { recursive: true, force: true })
    }
  })
})
