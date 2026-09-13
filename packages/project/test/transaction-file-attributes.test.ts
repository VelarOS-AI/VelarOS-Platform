import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'

import { atomicWriteProjectText } from '../src/files/atomic-writer'
import { FileStore } from '../src/files/file-store'
import { createProjectKernel, type EditIntent } from '../src/index'
import { FileProjectTransactionStateStore } from '../src/persistence/transaction-state'
import { encodeProjectTextBuffer } from '../src/utils/text'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-attributes-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function rename(from: string, to: string): EditIntent {
  return { operation: { type: 'rename_file', from, to } }
}

async function seed(path = 'source.sh', mode = 0o751) {
  const bytes = encodeProjectTextBuffer('#!/bin/sh\n# 中文🙂\necho original\n', 'utf16le')
  await writeFile(join(root, path), bytes)
  await chmod(join(root, path), mode)
  return bytes
}

async function assertFile(path: string, bytes: Buffer, mode: number) {
  expect(await readFile(join(root, path))).toEqual(bytes)
  expect((await stat(join(root, path))).mode & 0o777).toBe(mode)
}

test.each([false, true])(
  'rename chains retain encoding and executable mode, amend=%s',
  async (amend) => {
    const original = await seed()
    const project = await createProjectKernel({ root })
    const first = rename('source.sh', 'middle.sh')
    const second = rename('middle.sh', 'final.sh')
    const tx = await project.prepareEdit({ operations: amend ? [first] : [first, second] })
    if (amend) await project.amendEdit({ transactionId: tx.transactionId, operations: [second] })
    await project.applyEdit({ transactionId: tx.transactionId })
    await assertFile('final.sh', original, 0o751)
    await project.rollback({ transactionId: tx.transactionId })
    await assertFile('source.sh', original, 0o751)
    expect(await Bun.file(join(root, 'final.sh')).exists()).toBe(false)
    expect(await Bun.file(join(root, 'middle.sh')).exists()).toBe(false)
  },
)

test('delete rollback after reopening retains private file permissions', async () => {
  const original = await seed('private.txt', 0o600)
  const transactionStatePath = join(root, '.state', 'transactions.json')
  const project = await createProjectKernel({ root, transactionStatePath })
  const tx = await project.prepareEdit({
    operations: [{ operation: { type: 'delete_file', path: 'private.txt' } }],
  })
  await project.applyEdit({ transactionId: tx.transactionId })
  const reopened = await createProjectKernel({ root, transactionStatePath })
  await reopened.rollback({ transactionId: tx.transactionId })
  await assertFile('private.txt', original, 0o600)
})

test.each([false, true])(
  'failed rename restores source permissions, durable=%s',
  async (durable) => {
    const original = await seed()
    const project = await createProjectKernel({
      root,
      ...(durable ? { transactionStatePath: join(root, '.state', 'transactions.json') } : {}),
    })
    const tx = await project.prepareEdit({ operations: [rename('source.sh', 'target.sh')] })
    const write = FileStore.prototype.write
    let failed = false
    const hook = spyOn(FileStore.prototype, 'write').mockImplementation(async function (
      this: FileStore,
      ...args: Parameters<typeof write>
    ) {
      const result = await write.apply(this, args)
      if (args[0] === 'target.sh' && !failed) {
        failed = true
        throw new Error('injected receipt failure')
      }
      return result
    })
    try {
      await expect(project.applyEdit({ transactionId: tx.transactionId })).rejects.toThrow(
        'injected receipt failure',
      )
      await assertFile('source.sh', original, 0o751)
      expect(await Bun.file(join(root, 'target.sh')).exists()).toBe(false)
      await project.applyEdit({ transactionId: tx.transactionId })
      await assertFile('target.sh', original, 0o751)
    } finally {
      hook.mockRestore()
    }
  },
)

test('rollback preserves a subsequent external chmod on an existing file', async () => {
  await seed('private.txt', 0o600)
  const project = await createProjectKernel({ root })
  const tx = await project.prepareEdit({
    operations: [
      {
        operation: {
          type: 'replace_text',
          path: 'private.txt',
          oldText: 'original',
          newText: 'changed',
        },
      },
    ],
  })
  await project.applyEdit({ transactionId: tx.transactionId })
  await chmod(join(root, 'private.txt'), 0o400)
  await project.rollback({ transactionId: tx.transactionId })
  expect((await stat(join(root, 'private.txt'))).mode & 0o777).toBe(0o400)
})

test('rename captures permissions changed after preparation', async () => {
  const original = await seed()
  const project = await createProjectKernel({ root })
  const tx = await project.prepareEdit({ operations: [rename('source.sh', 'target.sh')] })
  await chmod(join(root, 'source.sh'), 0o700)
  await project.applyEdit({ transactionId: tx.transactionId })
  await assertFile('target.sh', original, 0o700)
  await project.rollback({ transactionId: tx.transactionId })
  await assertFile('source.sh', original, 0o700)
})

test('restart recovers an interrupted rename from its durable restore plan', async () => {
  const original = await seed('source.sh', 0o700)
  const transactionStatePath = join(root, '.state', 'transactions.json')
  const project = await createProjectKernel({ root, transactionStatePath })
  const tx = await project.prepareEdit({ operations: [rename('source.sh', 'target.sh')] })
  const write = FileStore.prototype.write
  const hook = spyOn(FileStore.prototype, 'write').mockImplementation(async function (
    this: FileStore,
    ...args: Parameters<typeof write>
  ) {
    if (args[0] === 'source.sh') throw new Error('recovery temporarily unavailable')
    const result = await write.apply(this, args)
    if (args[0] === 'target.sh') throw new Error('write receipt unavailable')
    return result
  })
  try {
    await expect(project.applyEdit({ transactionId: tx.transactionId })).rejects.toThrow()
    expect(await Bun.file(join(root, 'source.sh')).exists()).toBe(false)
  } finally {
    hook.mockRestore()
  }
  const reopened = await createProjectKernel({ root, transactionStatePath })
  await assertFile('source.sh', original, 0o700)
  expect(await Bun.file(join(root, 'target.sh')).exists()).toBe(false)
  await reopened.applyEdit({ transactionId: tx.transactionId })
  await assertFile('target.sh', original, 0o700)
})

test('50-file rename batch and rollback restore exact bytes and varied permissions', async () => {
  const modes = [0o600, 0o640, 0o700, 0o751, 0o755]
  const originals = await Promise.all(
    Array.from({ length: 50 }, (_, i) => seed(`source-${i}.txt`, modes[i % modes.length])),
  )
  const project = await createProjectKernel({ root })
  const tx = await project.prepareEdit({
    operations: originals.map((_, i) => rename(`source-${i}.txt`, `target-${i}.txt`)),
  })
  await project.applyEdit({ transactionId: tx.transactionId })
  for (const [i, original] of originals.entries())
    await assertFile(`target-${i}.txt`, original, modes[i % modes.length])
  await project.rollback({ transactionId: tx.transactionId })
  for (const [i, original] of originals.entries())
    await assertFile(`source-${i}.txt`, original, modes[i % modes.length])
})

test.each([-1, 0o1000, 0o4755, 1.5, '0755', null])(
  'rejects corrupt persisted permissions: %j',
  async (mode) => {
    await seed()
    const transactionStatePath = join(root, '.state', 'transactions.json')
    const project = await createProjectKernel({ root, transactionStatePath })
    await project.prepareEdit({
      operations: [{ operation: { type: 'delete_file', path: 'source.sh' } }],
    })
    const state = JSON.parse(await readFile(transactionStatePath, 'utf8'))
    state.transactions[0].patches[0].metadata.fileMode = mode
    await writeFile(transactionStatePath, JSON.stringify(state))
    expect(
      () => new FileProjectTransactionStateStore({ path: transactionStatePath, root }),
    ).toThrow('file mode')
  },
)

test('captured mode bypasses restrictive umask while default creation respects it', async () => {
  const mask = process.umask(0o077)
  try {
    await atomicWriteProjectText(join(root, 'restored.sh'), 'original', undefined, 0o751)
    await atomicWriteProjectText(join(root, 'new.txt'), 'new')
    expect((await stat(join(root, 'restored.sh'))).mode & 0o777).toBe(0o751)
    expect((await stat(join(root, 'new.txt'))).mode & 0o777).toBe(0o600)
    await expect(
      atomicWriteProjectText(join(root, 'invalid.txt'), 'bad', undefined, 0o4755),
    ).rejects.toMatchObject({ reason: 'INVALID_INPUT' })
    expect(await Bun.file(join(root, 'invalid.txt')).exists()).toBe(false)
  } finally {
    process.umask(mask)
  }
})
