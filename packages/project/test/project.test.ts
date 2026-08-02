import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createProjectKernel } from '../src/index'
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
})
