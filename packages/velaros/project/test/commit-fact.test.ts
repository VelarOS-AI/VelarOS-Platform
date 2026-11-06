import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import type { ProjectOperationContext } from '../contract/requires'
import { createProjectKernel } from '../impl/kernel/LocalProjectKernel'
import { projectFileOperations } from '../impl/operations/ProjectFileOperations'

test('real commit fact survives outer throw; undo keeps identity and protects later user edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-fact-'))
  try {
    const kernel = await createProjectKernel({ root })
    const facts: unknown[] = []
    const context: ProjectOperationContext = {
      project: { getRootPath: () => root, kernel: async () => kernel, queryCode: async () => ({}) },
      abortSignal: new AbortController().signal,
      sessionId: 'commit-fact',
      recordProjectCommit: (fact) => {
        facts.push(fact)
      },
    }
    let changeRef = ''
    try {
      const result = await projectFileOperations.edit(
        { steps: [{ action: 'write', path: 'a.ts', text: 'first\n', expectedText: null }] },
        context
      )
      changeRef = result.changeRef
      throw Error('outer script failed')
    } catch (error) {
      expect((error as Error).message).toBe('outer script failed')
    }
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('first\n')
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      root,
      lifecycle: 'applied',
      changedFiles: ['a.ts'],
      fileStats: { 'a.ts': { additions: 1, deletions: 0 } },
    })
    await projectFileOperations.undo({ changeRef }, context)
    expect(facts).toHaveLength(2)
    expect(facts[1]).toMatchObject({
      root,
      lifecycle: 'rolled_back',
      fileStats: { 'a.ts': { additions: 0, deletions: 1 } },
    })
    await projectFileOperations.undo({ changeRef }, context)
    expect(facts).toHaveLength(2)
    const next = await projectFileOperations.edit(
      { steps: [{ action: 'write', path: 'a.ts', text: 'second\n', expectedText: null }] },
      context
    )
    await writeFile(join(root, 'a.ts'), 'user change\n')
    await expect(
      projectFileOperations.undo({ changeRef: next.changeRef }, context)
    ).rejects.toThrow()
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('user change\n')
    expect(facts).toHaveLength(3)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
