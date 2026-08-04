import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { executeAtomicRead } from '../src/atomic/Read'
import { systemTools } from '../src/Collection'
import { SystemToolNames } from '../src/system-tool-names'
import { shouldReapForegroundProcessGroupAfterExit } from '../src/SystemCommandExecutionPolicy'

describe('System capability', () => {
  test('publishes only canonical system tool ids', () => {
    expect(Object.keys(systemTools).toSorted()).toEqual(Object.values(SystemToolNames).toSorted())
    expect(Object.keys(systemTools).every((name) => name.startsWith('system:'))).toBe(true)
  })

  test('does not publish project discovery or diagnostic shortcuts', () => {
    expect(Object.hasOwn(systemTools, 'discover_projects')).toBe(false)
    expect(Object.hasOwn(systemTools, 'diagnose_dev_runtime')).toBe(false)
    expect(Object.hasOwn(systemTools, 'get_system_overview')).toBe(false)
  })

  test('only reaps commands that launch a real shell background job', () => {
    expect(shouldReapForegroundProcessGroupAfterExit('printf one && printf two')).toBe(false)
    expect(shouldReapForegroundProcessGroupAfterExit('false || printf fallback')).toBe(false)
    expect(shouldReapForegroundProcessGroupAfterExit('printf value | wc -c')).toBe(false)
    expect(shouldReapForegroundProcessGroupAfterExit('server &')).toBe(true)
    expect(shouldReapForegroundProcessGroupAfterExit('server &; printf ready')).toBe(true)
    expect(shouldReapForegroundProcessGroupAfterExit('server &\nprintf ready')).toBe(true)
    expect(shouldReapForegroundProcessGroupAfterExit('nohup server &')).toBe(false)
  })

  test('does not count a final line ending as an extra addressable line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-'))
    const path = join(root, 'lines.txt')
    try {
      await writeFile(path, 'line-1\nline-2\n')

      const result = await executeAtomicRead({ path, startLine: 1, endLine: 99 })

      expect(result.content).toBe('line-1\nline-2\n')
      expect(result.totalLines).toBe(2)
      expect(result.endLine).toBe(2)
      await expect(
        executeAtomicRead({ path, startLine: 3, maxChars: 100 })
      ).rejects.toThrow('startLine (3) > endLine (2)')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('preserves intentional empty lines before the final line ending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-empty-lines-'))
    const path = join(root, 'lines.txt')
    try {
      await writeFile(path, 'line-1\n\n')

      const result = await executeAtomicRead({ path, startLine: 1, endLine: 99 })

      expect(result.content).toBe('line-1\n\n')
      expect(result.totalLines).toBe(2)
      expect(result.endLine).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('preserves original line endings while keeping line-address pagination exact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-line-endings-'))
    const path = join(root, 'lines.txt')
    try {
      await writeFile(path, 'line-1\r\nline-2\r\nline-3')

      const first = await executeAtomicRead({ path, startLine: 1, endLine: 2 })
      const second = await executeAtomicRead({ path, startLine: 3, endLine: 3 })

      expect(first.content).toBe('line-1\r\nline-2\r\n')
      expect(first.totalLines).toBe(3)
      expect(first.hasMore).toBe(true)
      expect(first.nextStartLine).toBe(3)
      expect(second.content).toBe('line-3')
      expect(`${first.content}${second.content}`).toBe('line-1\r\nline-2\r\nline-3')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
