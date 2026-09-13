import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { ProjectModelEditSchema } from '../src/edits/schema'
import { createProjectKernel } from '../src/index'
import type { EditIntent } from '../src/types/edit'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-scale-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('large transaction workload', () => {
  test('applies and rolls back 50 files and 10000 changed lines under the default policy', async () => {
    const project = await createProjectKernel({ root })
    const originals = Array.from({ length: 50 }, (_, i) => ({
      path: `file-${i}.txt`,
      content: `file ${i} 中文🙂\\n\n`.repeat(100),
    }))
    await Promise.all(originals.map(({ path, content }) => writeFile(join(root, path), content)))
    const edits = originals.map(({ path, content }) => ({
      type: 'replace_text' as const,
      path,
      oldText: content,
      newText: content.replaceAll('file', 'changed'),
    }))
    expect(ProjectModelEditSchema.safeParse({ edits }).success).toBe(true)
    const tx = await project.prepareEdit({ operations: edits.map((operation) => ({ operation })) })
    expect(tx.changedFiles).toHaveLength(50)
    expect(tx.changedLines).toBe(10000)
    await project.applyEdit({ transactionId: tx.transactionId })
    for (const edit of edits)
      expect(await readFile(join(root, edit.path), 'utf8')).toBe(edit.newText)
    await project.rollback({ transactionId: tx.transactionId })
    for (const original of originals)
      expect(await readFile(join(root, original.path), 'utf8')).toBe(original.content)
  }, 30000)

  test('applies 500 disjoint ranges to a 20000-line file without manual offset calculations', async () => {
    const path = 'large.txt'
    const lines = Array.from({ length: 20000 }, (_, i) => `line ${i + 1} 中文🙂 \\n`)
    const original = lines.join('\n')
    await writeFile(join(root, path), original)
    const project = await createProjectKernel({ root })
    const read = await project.read({ path, range: { startLine: 1, endLine: 3 } })
    const operations: EditIntent[] = Array.from({ length: 500 }, (_, i) => ({
      operation: {
        type: 'replace_lines',
        path,
        baseRevision: read.snapshot.revision,
        startLine: i * 39 + 1,
        endLine: i * 39 + 1,
        newLines: [`changed ${i}`, 'added'],
      },
    }))
    const tx = await project.prepareEdit({ operations })
    expect(tx.patches).toHaveLength(1)
    await project.applyEdit({ transactionId: tx.transactionId })
    const expected = lines
      .flatMap((line, i) =>
        i % 39 === 0 && i / 39 < 500 ? [`changed ${i / 39}`, 'added'] : [line],
      )
      .join('\n')
    expect(await readFile(join(root, path), 'utf8')).toBe(expected)
    await project.rollback({ transactionId: tx.transactionId })
    expect(await readFile(join(root, path), 'utf8')).toBe(original)
  }, 30000)

  test('rejects a late conflict without changing any earlier file', async () => {
    const project = await createProjectKernel({ root })
    const paths = Array.from({ length: 30 }, (_, i) => `file-${i}.txt`)
    await Promise.all(paths.map((path) => writeFile(join(root, path), 'original')))
    const tx = await project.prepareEdit({
      operations: paths.map((path) => ({
        operation: { type: 'replace_text', path, oldText: 'original', newText: 'changed' },
      })),
    })
    await writeFile(join(root, paths.at(-1)!), 'external')
    await expect(project.applyEdit({ transactionId: tx.transactionId })).rejects.toMatchObject({
      reason: 'BASE_REVISION_MISMATCH',
    })
    for (const path of paths.slice(0, -1))
      expect(await readFile(join(root, path), 'utf8')).toBe('original')
    expect(await readFile(join(root, paths.at(-1)!), 'utf8')).toBe('external')
  })

  test('enforces host-configured per-file bounds using net changes', async () => {
    await writeFile(join(root, 'small.txt'), 'old\n')
    const project = await createProjectKernel({ root, corePolicy: { maxChangedLinesPerFile: 2 } })
    await expect(
      project.prepareEdit({
        operations: [
          {
            operation: {
              type: 'replace_text',
              path: 'small.txt',
              oldText: 'old',
              newText: 'new\nmore',
            },
          },
        ],
      }),
    ).rejects.toMatchObject({
      reason: 'SCOPE_VIOLATION',
      details: { path: 'small.txt', actual: 3, maximum: 2 },
    })
    expect(await readFile(join(root, 'small.txt'), 'utf8')).toBe('old\n')
  })
})
