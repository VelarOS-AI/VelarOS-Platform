import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { EditOperation } from '../src/index'
import { createProjectKernel, FileProjectChangeFeed, ProjectEditOperationSchema } from '../src/index'
import { ProjectToolNames } from '../src/project-tool-names'

describe('Project capability', () => {
  test('publishes only canonical project tool ids', () => {
    expect(Object.values(ProjectToolNames)).toEqual([
      'project:read',
      'project:list',
      'project:search',
      'project:query-code',
      'project:write',
      'project:edit',
      'project:rollback',
      'project:run',
    ])
  })

  test('reads, edits, and rolls back inside the project root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-'))
    try {
      await writeFile(join(root, 'note.txt'), 'before\n')
      const project = await createProjectKernel({ root })
      expect((await project.read({ path: 'note.txt' })).content).toBe('before\n')

      const transaction = await project.prepareEdit({
        operations: [{
          operation: {
            type: 'replace_text',
            path: 'note.txt',
            oldText: 'before',
            newText: 'after',
          },
        }],
      })
      await project.applyEdit({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('after\n')

      await project.rollback({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('before\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('continues inside a truncated long line and honors 1-based column ranges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-read-continuation-'))
    try {
      await writeFile(join(root, 'long.txt'), 'abcdefghij')
      await writeFile(join(root, 'lines.txt'), 'abc\ndef\nghi')
      await writeFile(join(root, 'blank-lines.txt'), 'a\n\nb')
      await writeFile(join(root, 'huge-range.txt'), `${'a'.repeat(70_000)}\nXYZ`)
      await writeFile(join(root, 'tiny.txt'), 'abc')
      await writeFile(join(root, 'unicode.txt'), '😀x')
      const project = await createProjectKernel({
        root,
        corePolicy: { maxFileSizeToReadBytes: 4 },
      })

      const first = await project.read({ path: 'long.txt', maxChars: 3 })
      expect(first.content).toBe('abc')
      expect(first.truncated).toBe(true)
      expect(first.hasMore).toBe(true)
      expect(first.nextStartLine).toBeUndefined()
      expect(first.continuation).toMatchObject({
        path: 'long.txt',
        range: { startLine: 1, startColumn: 4 },
        maxChars: 3,
        baseRevision: first.snapshot.revision,
      })

      const second = await project.read(first.continuation!)
      expect(second.content).toBe('def')
      expect(second.continuation?.range).toEqual({ startLine: 1, startColumn: 7 })

      const unicodeFirst = await project.read({ path: 'unicode.txt', maxChars: 1 })
      expect(unicodeFirst.content).toBe('😀')
      expect(unicodeFirst.continuation?.range).toEqual({ startLine: 1, startColumn: 3 })
      const unicodeSecond = await project.read(unicodeFirst.continuation!)
      expect(unicodeSecond.content).toBe('x')
      for (const maxBytes of [1, 2, 3]) {
        await expect(project.read({ path: 'unicode.txt', maxBytes })).rejects.toMatchObject({
          reason: 'INVALID_INPUT',
        })
      }

      const pagedContents: string[] = []
      let page = await project.read({ path: 'lines.txt', maxChars: 3 })
      while (true) {
        pagedContents.push(page.content ?? '')
        expect(page.content?.length).toBeGreaterThan(0)
        if (!page.hasMore || !page.continuation) break
        page = await project.read(page.continuation)
      }
      expect(pagedContents.join('')).toBe('abc\ndef\nghi')

      const blankFirst = await project.read({ path: 'blank-lines.txt', maxChars: 3 })
      expect(blankFirst.content).toBe('a\n\n')
      const blankSecond = await project.read(blankFirst.continuation!)
      expect(`${blankFirst.content}${blankSecond.content}`).toBe('a\n\nb')

      const hugeRangeFirst = await project.read({
        path: 'huge-range.txt',
        range: { startLine: 1, endLine: 2, endColumn: 2 },
        maxChars: 50_000,
      })
      expect(hugeRangeFirst.content).toHaveLength(50_000)
      expect(hugeRangeFirst.continuation?.range).toEqual({
        startLine: 1,
        startColumn: 50_001,
        endLine: 2,
        endColumn: 2,
      })
      const hugeRangeSecond = await project.read(hugeRangeFirst.continuation!)
      expect(hugeRangeSecond.content).toBe(`${'a'.repeat(20_000)}\nX`)

      const selected = await project.read({
        path: 'long.txt',
        range: { startLine: 1, startColumn: 4, endLine: 1, endColumn: 7 },
      })
      expect(selected.content).toBe('def')
      expect(selected.range).toMatchObject({ startLine: 1, startColumn: 4, endLine: 1, endColumn: 7 })
      await expect(project.read({
        path: 'long.txt',
        range: { startLine: 1, startColumn: 7, endLine: 1, endColumn: 4 },
      })).rejects.toMatchObject({ reason: 'INVALID_INPUT' })
      expect(await project.read({
        path: 'long.txt',
        range: { startLine: 2 },
      })).toMatchObject({ content: '', totalLines: 1, hasMore: false, note: expect.stringContaining('起始行 2') })
      expect(await project.read({
        path: 'tiny.txt',
        range: { startLine: 2 },
      })).toMatchObject({ content: '', totalLines: 1, hasMore: false, note: expect.stringContaining('起始行 2') })
      expect(await project.read({
        path: 'tiny.txt',
        range: { startLine: 1, endLine: 2, endColumn: 1 },
      })).toMatchObject({ content: 'abc', totalLines: 1, note: expect.stringContaining('忽略 endColumn') })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('applies strict JSON patches and reports the exact failing patch without creating a transaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-json-patch-'))
    try {
      const file = join(root, 'data.json')
      const original = '{"items":["first","second"],"nested":{"keep":true}}\n'
      await writeFile(file, original)
      const project = await createProjectKernel({ root })

      const valid = await project.prepareEdit({
        operations: [{
          operation: {
            type: 'json_patch',
            path: 'data.json',
            patches: [
              { op: 'replace', path: '/items/1', value: 'updated' },
              { op: 'add', path: '/items/-', value: 'last' },
              { op: 'remove', path: '/nested/keep' },
            ],
          },
        }],
      })
      await project.applyEdit({ transactionId: valid.transactionId })
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
        items: ['first', 'updated', 'last'],
        nested: {},
      })

      const beforeFailure = await readFile(file, 'utf8')
      let failure: unknown
      try {
        await project.prepareEdit({
          operations: [{
            operation: {
              type: 'json_patch',
              path: 'data.json',
              patches: [
                { op: 'add', path: '/nested/temporary', value: true },
                { op: 'remove', path: '/items/nope' },
              ],
            },
          }],
        })
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({
        reason: 'INVALID_INPUT',
        details: { patchIndex: 1, path: '/items/nope', reason: 'invalid_array_index' },
      })
      expect(await readFile(file, 'utf8')).toBe(beforeFailure)
      expect((await project.status()).transactions).toBe(1)

      await expect(project.prepareEdit({
        operations: [{
          operation: {
            type: 'json_patch',
            path: 'data.json',
            patches: [{ op: 'replace', path: '/missing/child', value: 1 }],
          },
        }],
      })).rejects.toMatchObject({
        details: { patchIndex: 0, path: '/missing/child', reason: 'parent_missing' },
      })

      await expect(project.prepareEdit({
        operations: [{
          operation: {
            type: 'json_patch',
            path: 'data.json',
            patches: [{ op: 'replace', path: '/items/0' }],
          } as EditOperation,
        }],
      })).rejects.toMatchObject({
        details: { patchIndex: 0, path: '/items/0', reason: 'value_required' },
      })
      await expect(project.prepareEdit({
        operations: [{
          operation: {
            type: 'json_patch',
            path: 'data.json',
            patches: [{ op: 'replace', path: '/items/0', value: Number.POSITIVE_INFINITY }],
          } as EditOperation,
        }],
      })).rejects.toMatchObject({
        details: { patchIndex: 0, path: '/items/0', reason: 'value_not_json' },
      })

      const nonFiniteFile = join(root, 'non-finite.json')
      await writeFile(nonFiniteFile, '1e400\n')
      await expect(project.prepareEdit({
        operations: [{
          operation: {
            type: 'json_patch',
            path: 'non-finite.json',
            patches: [{ op: 'replace', path: '', value: 1 }],
          },
        }],
      })).rejects.toMatchObject({
        reason: 'VALIDATION_FAILED',
        details: { path: 'non-finite.json', reason: 'document_not_json_value' },
      })
      expect(await readFile(nonFiniteFile, 'utf8')).toBe('1e400\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('separates text match count assertions from occurrence and replace-all selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-match-selection-'))
    try {
      const file = join(root, 'matches.txt')
      await writeFile(file, 'same same same\n')
      const project = await createProjectKernel({ root })

      const resolved = await project.resolveTarget({
        path: 'matches.txt',
        target: { exactSnippet: 'same' },
        expectedMatches: 3,
      })
      expect(resolved.status).toBe('ambiguous')
      if (resolved.status === 'ambiguous') expect(resolved.candidates).toHaveLength(3)

      await expect(project.prepareEdit({
        operations: [{
          operation: {
            type: 'replace_text',
            path: 'matches.txt',
            oldText: 'same',
            newText: 'one',
            expectedMatches: 3,
          },
        }],
      })).rejects.toMatchObject({ reason: 'AMBIGUOUS_TARGET' })

      const selected = await project.prepareEdit({
        operations: [{
          operation: {
            type: 'replace_text',
            path: 'matches.txt',
            oldText: 'same',
            newText: 'chosen',
            expectedMatches: 3,
            occurrence: 2,
          },
        }],
      })
      await project.applyEdit({ transactionId: selected.transactionId })
      expect(await readFile(file, 'utf8')).toBe('same chosen same\n')

      const all = await project.prepareEdit({
        operations: [{
          operation: {
            type: 'replace_text',
            path: 'matches.txt',
            oldText: 'same',
            newText: 'all',
            expectedMatches: 2,
            replaceAll: true,
          },
        }],
      })
      await project.applyEdit({ transactionId: all.transactionId })
      expect(await readFile(file, 'utf8')).toBe('all chosen all\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects paths outside the project root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-boundary-'))
    try {
      const project = await createProjectKernel({ root })
      await expect(project.read({ path: '../outside.txt' })).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps structural TypeScript edit operations on the public schema', () => {
    const operations = [
      {
        type: 'replace_symbol',
        path: 'src/index.ts',
        symbol: { name: 'main' },
        replacement: 'return 1',
        mode: 'body',
      },
      {
        type: 'insert_around_symbol',
        path: 'src/index.ts',
        symbol: { name: 'main' },
        position: 'before',
        text: 'const ready = true\n',
      },
      { type: 'add_import', path: 'src/index.ts', module: 'node:path', named: ['join'] },
      { type: 'remove_import', path: 'src/index.ts', module: 'node:path', name: 'join' },
    ]

    for (const operation of operations) {
      expect(ProjectEditOperationSchema.safeParse(operation).success).toBe(true)
    }
  })

  test('executes every public structural operation without a pre-resolved target id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-structural-'))
    try {
      await writeFile(join(root, 'replace.ts'), 'export function main() {\n  return 0\n}\n')
      await writeFile(join(root, 'insert.ts'), 'export function main() {\n  return 0\n}\n')
      await writeFile(join(root, 'imports.ts'), 'export const value = 1\n')
      const project = await createProjectKernel({ root })

      const apply = async (operation: EditOperation) => {
        const transaction = await project.prepareEdit({ operations: [{ operation }] })
        await project.applyEdit({ transactionId: transaction.transactionId })
      }

      await apply({
        type: 'replace_symbol',
        path: 'replace.ts',
        symbol: { kind: 'function', name: 'main' },
        replacement: 'return 42',
        mode: 'body',
      })
      expect(await readFile(join(root, 'replace.ts'), 'utf8')).toContain('return 42')

      await apply({
        type: 'insert_around_symbol',
        path: 'insert.ts',
        symbol: { kind: 'function', name: 'main' },
        position: 'before',
        text: '// inserted\n',
      })
      expect(await readFile(join(root, 'insert.ts'), 'utf8')).toMatch(/^\/\/ inserted/)

      await apply({
        type: 'add_import',
        path: 'imports.ts',
        module: 'node:path',
        named: ['join'],
      })
      expect(await readFile(join(root, 'imports.ts'), 'utf8')).toMatch(/from ["']node:path["']/)

      await apply({
        type: 'remove_import',
        path: 'imports.ts',
        module: 'node:path',
        name: 'join',
      })
      expect(await readFile(join(root, 'imports.ts'), 'utf8')).not.toContain('node:path')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('validates a staged transaction before writing any file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-validation-'))
    try {
      const path = join(root, 'package.json')
      const original = '{"name":"demo"}\n'
      await writeFile(path, original)
      const project = await createProjectKernel({ root })
      const transaction = await project.prepareEdit({
        operations: [{
          operation: {
            type: 'replace_text',
            path: 'package.json',
            oldText: '"demo"',
            newText: '"demo",,,BROKEN',
          },
        }],
      })

      await expect(project.applyEdit({ transactionId: transaction.transactionId })).rejects.toMatchObject({
        reason: 'VALIDATION_FAILED',
      })
      expect(await readFile(path, 'utf8')).toBe(original)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('requires approval for destructive transactions and fails closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-approval-'))
    try {
      const path = join(root, 'keep.txt')
      await writeFile(path, 'keep\n')
      const project = await createProjectKernel({ root })
      const transaction = await project.prepareEdit({
        operations: [{ operation: { type: 'delete_file', path: 'keep.txt' } }],
      })

      expect(transaction.risk).toBe('high')
      await expect(project.applyEdit({ transactionId: transaction.transactionId })).rejects.toMatchObject({
        reason: 'PERMISSION_DENIED',
      })
      expect(await readFile(path, 'utf8')).toBe('keep\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reads and preserves BOM-less UTF-16LE during transactional edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-utf16-'))
    try {
      const path = join(root, 'notes.txt')
      await writeFile(path, Buffer.from('first line\nsecond line\n', 'utf16le'))
      const project = await createProjectKernel({ root })

      expect((await project.read({ path: 'notes.txt' })).content).toContain('second line')
      const transaction = await project.prepareEdit({
        operations: [{
          operation: {
            type: 'replace_text',
            path: 'notes.txt',
            oldText: 'second line',
            newText: 'updated second line',
          },
        }],
      })
      await project.applyEdit({ transactionId: transaction.transactionId })

      const raw = await readFile(path)
      expect(raw.includes(Buffer.from('updated second line', 'utf8'))).toBe(false)
      expect(raw.toString('utf16le')).toContain('updated second line')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reads and preserves GB18030 during transactional edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-gb18030-'))
    try {
      const path = join(root, 'notes.txt')
      await writeFile(path, Buffer.from('c4e3bac3cac0bde70ab5dab6fed0d00a', 'hex'))
      const project = await createProjectKernel({ root })

      expect((await project.read({ path: 'notes.txt' })).content).toBe('你好世界\n第二行\n')
      const transaction = await project.prepareEdit({
        operations: [{
          operation: {
            type: 'replace_text',
            path: 'notes.txt',
            oldText: '第二行',
            newText: '新的行',
          },
        }],
      })
      await project.applyEdit({ transactionId: transaction.transactionId })

      expect((await readFile(path)).toString('hex')).toBe('c4e3bac3cac0bde70ad0c2b5c4d0d00a')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('detects overlapping prepared transactions in a batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-batch-conflict-'))
    try {
      await writeFile(join(root, 'note.txt'), 'alpha beta gamma\n')
      const project = await createProjectKernel({ root })
      const result = await project.runBatch({
        mode: 'prepare-then-apply',
        conflictCheck: true,
        tasks: [
          {
            id: 'first',
            op: {
              kind: 'prepare',
              input: {
                operations: [{
                  operation: {
                    type: 'replace_text',
                    path: 'note.txt',
                    oldText: 'beta',
                    newText: 'BETA',
                  },
                }],
              },
            },
          },
          {
            id: 'second',
            op: {
              kind: 'prepare',
              input: {
                operations: [{
                  operation: {
                    type: 'replace_text',
                    path: 'note.txt',
                    oldText: 'beta',
                    newText: 'Beta',
                  },
                }],
              },
            },
          },
        ],
      })

      expect(result.ok).toBe(false)
      expect(result.conflicts?.length).toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('batch scheduler respects dependencies and concurrency limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-batch-pool-'))
    try {
      const project = await createProjectKernel({ root })
      let active = 0
      let peak = 0
      const task = (id: string) => ({
        id,
        op: {
          kind: 'custom' as const,
          run: async () => {
            active += 1
            peak = Math.max(peak, active)
            await Bun.sleep(5)
            active -= 1
          },
        },
      })
      const result = await project.runBatch({
        concurrency: 2,
        tasks: [task('one'), task('two'), { ...task('three'), dependsOn: ['one'] }],
      })

      expect(result.ok).toBe(true)
      expect(result.results).toHaveLength(3)
      expect(peak).toBe(2)
      expect(result.metrics?.concurrencyLimit).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('restores earlier writes when a later patch fails during apply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-atomic-'))
    try {
      const path = join(root, 'source.ts')
      await writeFile(path, 'OLD\n')
      const project = await createProjectKernel({ root })
      const transaction = await project.prepareEdit({
        operations: [
          {
            operation: {
              type: 'replace_text',
              path: 'source.ts',
              oldText: 'OLD',
              newText: 'NEW',
            },
          },
          {
            operation: {
              type: 'create_file',
              path: 'source.ts/child.ts',
              content: 'child\n',
            },
          },
        ],
      })

      await expect(project.applyEdit({ transactionId: transaction.transactionId })).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe('OLD\n')
      expect((await project.status()).locks).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('publishes durable typed transaction changes without exposing a write surface to consumers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-project-change-feed-'))
    const root = join(directory, 'project')
    const feedPath = join(directory, 'host-state', 'changes.jsonl')
    await mkdir(root)
    let feed = new FileProjectChangeFeed({ path: feedPath })
    try {
      await writeFile(join(root, 'note.txt'), 'before\n')
      const observed: string[] = []
      const unsubscribe = feed.subscribe((change) => observed.push(change.lifecycle))
      const project = await createProjectKernel({ root, changeFeed: feed })
      const transaction = await project.prepareEdit({
        operations: [{
          reason: 'Rename the visible state',
          operation: {
            type: 'replace_text',
            path: 'note.txt',
            oldText: 'before',
            newText: 'after',
          },
        }],
      })

      const prepared = project.changeFeed.get(transaction.transactionId)
      expect(prepared?.lifecycle).toBe('prepared')
      expect(prepared?.reason).toBe('Rename the visible state')
      expect(prepared?.intents[0]?.operation.type).toBe('replace_text')
      expect(prepared?.patches[0]?.path).toBe('note.txt')

      await project.applyEdit({ transactionId: transaction.transactionId })
      expect(project.changeFeed.get(transaction.transactionId)?.lifecycle).toBe('applied')
      expect(project.changeFeed.get(transaction.transactionId)?.revisions[0]?.after).toBeTruthy()
      await project.rollback({ transactionId: transaction.transactionId })
      expect(project.changeFeed.get(transaction.transactionId)?.lifecycle).toBe('rolled_back')
      expect(observed).toEqual(['prepared', 'validated', 'applied', 'rolled_back'])
      unsubscribe()

      feed.close()
      feed = new FileProjectChangeFeed({ path: feedPath })
      const restored = feed.get(transaction.transactionId)
      expect(restored?.lifecycle).toBe('rolled_back')
      expect(restored?.reason).toBe('Rename the visible state')
      expect(feed.list()).toHaveLength(1)
      expect((await readFile(feedPath, 'utf8')).trim().split('\n')).toHaveLength(4)
    } finally {
      feed.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
