import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import { FileStore } from '../src/files/file-store'
import { createProjectKernel } from '../src/index'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-write-fault-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function fixture() {
  await writeFile(join(root, 'a.txt'), 'before-a')
  await writeFile(join(root, 'b.txt'), 'before-b')
  const project = await createProjectKernel({ root })
  const tx = await project.prepareEdit({
    operations: ['a', 'b'].map((name) => ({
      operation: {
        type: 'replace_text',
        path: `${name}.txt`,
        oldText: `before-${name}`,
        newText: `after-${name}`,
      },
    })),
  })
  return { project, tx }
}

describe('write failures at the filesystem commit boundary', () => {
  test('restores a path whose atomic replacement succeeded before the write receipt failed', async () => {
    const { project, tx } = await fixture()
    const write = FileStore.prototype.write
    let failed = false
    const hook = spyOn(FileStore.prototype, 'write').mockImplementation(async function (
      this: FileStore,
      ...args: Parameters<typeof write>
    ) {
      const result = await write.apply(this, args)
      if (args[0] === 'b.txt' && !failed) {
        failed = true
        throw new Error('injected failure after rename, before receipt')
      }
      return result
    })
    try {
      await expect(project.applyEdit({ transactionId: tx.transactionId })).rejects.toThrow(
        'injected failure',
      )
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('before-a')
      expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('before-b')
      expect((await project.status()).locks).toHaveLength(0)
    } finally {
      hook.mockRestore()
    }
  })

  test('preflights every recovery path before restoring and preserves external edits', async () => {
    const { project, tx } = await fixture()
    const write = FileStore.prototype.write
    let failed = false
    const hook = spyOn(FileStore.prototype, 'write').mockImplementation(async function (
      this: FileStore,
      ...args: Parameters<typeof write>
    ) {
      const result = await write.apply(this, args)
      if (args[0] === 'b.txt' && !failed) {
        failed = true
        await writeFile(join(root, 'a.txt'), 'external edit')
        throw new Error('injected concurrent writer and receipt failure')
      }
      return result
    })
    try {
      await expect(project.applyEdit({ transactionId: tx.transactionId })).rejects.toMatchObject({
        reason: 'TRANSACTION_RECOVERY_CONFLICT',
        details: { path: 'a.txt' },
      })
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('external edit')
      expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('after-b')
      expect((await project.status()).locks).toHaveLength(0)
    } finally {
      hook.mockRestore()
    }
  })

  test('a failed rollback restores the applied state, including the failing path', async () => {
    const { project, tx } = await fixture()
    await project.applyEdit({ transactionId: tx.transactionId })
    const write = FileStore.prototype.write
    let failed = false
    const hook = spyOn(FileStore.prototype, 'write').mockImplementation(async function (
      this: FileStore,
      ...args: Parameters<typeof write>
    ) {
      const result = await write.apply(this, args)
      if (args[0] === 'a.txt' && !failed) {
        failed = true
        throw new Error('injected failure after rollback rename')
      }
      return result
    })
    try {
      await expect(project.rollback({ transactionId: tx.transactionId })).rejects.toThrow(
        'injected failure',
      )
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('after-a')
      expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('after-b')
    } finally {
      hook.mockRestore()
    }
  })
})
