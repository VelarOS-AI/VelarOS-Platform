import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createProjectKernel } from '../src/core/project-kernel'

describe('ProjectKernel transaction repository integration', () => {
  test('restores transaction and projection order when durable discard commit fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-project-repository-'))
    const root = join(directory, 'project')
    const stateDirectory = join(directory, 'host-state')
    const statePath = join(stateDirectory, 'transactions.json')
    await mkdir(root)
    await writeFile(join(root, 'note.txt'), 'one two\n')

    try {
      const project = await createProjectKernel({ root, transactionStatePath: statePath })
      const first = await project.prepareEdit({
        operations: [{
          operation: {
            type: 'replace_text',
            path: 'note.txt',
            oldText: 'one',
            newText: 'ONE',
          },
        }],
      })
      const second = await project.prepareEdit({
        operations: [{
          operation: {
            type: 'replace_text',
            path: 'note.txt',
            oldText: 'two',
            newText: 'TWO',
          },
        }],
      })
      const before = await project.diff()

      await rm(stateDirectory, { recursive: true, force: true })
      await writeFile(stateDirectory, 'block state directory recreation')

      expect(() => project.discardTransaction(first.transactionId)).toThrow()

      expect(project.getTransaction(first.transactionId)?.transactionId).toBe(first.transactionId)
      expect(project.getTransaction(second.transactionId)?.transactionId).toBe(second.transactionId)
      expect(await project.diff()).toEqual(before)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
