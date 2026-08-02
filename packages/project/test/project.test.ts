import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { EditOperation } from '../src/index'
import { createProjectKernel, ProjectEditOperationSchema } from '../src/index'
import { ProjectToolNames } from '../src/project-tool-names'

describe('Project capability', () => {
  test('publishes only canonical project tool ids', () => {
    expect(Object.values(ProjectToolNames)).toEqual([
      'project:read',
      'project:list',
      'project:search',
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
})
