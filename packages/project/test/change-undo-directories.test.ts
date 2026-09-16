import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { createProjectKernel } from '../src/exports/index'
import { ancestorDirectories, missingAncestorDirectories } from '../src/utils/transactions/created-directories'

let root = ''
let stateDirectory = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-undo-directories-'))
  stateDirectory = await mkdtemp(join(tmpdir(), 'project-undo-state-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(stateDirectory, { recursive: true, force: true })
})

/** 目录在不在。 */
async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

test('父目录按从浅到深列出，只挑出还不存在的那几级', async () => {
  expect(ancestorDirectories('lib/deep/new.txt')).toEqual(['lib', 'lib/deep'])
  expect(ancestorDirectories('top.txt')).toEqual([])
  const present = new Set(['lib'])
  expect(await missingAncestorDirectories(['lib/deep/new.txt', 'lib/other.txt'], async (directory) => present.has(directory))).toEqual(['lib/deep'])
})

test('撤销新建文件时，本事务顺带建出来的空目录从深到浅一并清掉', async () => {
  await writeFile(join(root, 'seed.txt'), 'seed\n')
  const kernel = await createProjectKernel({ root })
  const transaction = await kernel.prepareEdit({
    operations: [{ operation: { type: 'create_file', path: 'lib/deep/added.txt', content: 'added\n' } }],
  })
  await kernel.applyEdit({ transactionId: transaction.transactionId })
  expect(await exists(join(root, 'lib', 'deep', 'added.txt'))).toBe(true)

  await kernel.rollback({ transactionId: transaction.transactionId })
  expect(await exists(join(root, 'lib', 'deep', 'added.txt'))).toBe(false)
  expect(await exists(join(root, 'lib', 'deep'))).toBe(false)
  expect(await exists(join(root, 'lib'))).toBe(false)
  expect(await exists(join(root, 'seed.txt'))).toBe(true)
})

test('目录里还有别的东西就不动它，本来就存在的目录也不动', async () => {
  await mkdir(join(root, 'kept'), { recursive: true })
  await writeFile(join(root, 'kept', 'existing.txt'), 'keep\n')
  const kernel = await createProjectKernel({ root })
  const transaction = await kernel.prepareEdit({
    operations: [
      { operation: { type: 'create_file', path: 'kept/added.txt', content: 'added\n' } },
      { operation: { type: 'create_file', path: 'fresh/inner/added.txt', content: 'added\n' } },
    ],
  })
  await kernel.applyEdit({ transactionId: transaction.transactionId })
  await rm(join(root, 'fresh', 'inner', 'added.txt'))
  await writeFile(join(root, 'fresh', 'inner', 'user.txt'), 'user\n')
  await writeFile(join(root, 'fresh', 'inner', 'added.txt'), 'added\n')

  await kernel.rollback({ transactionId: transaction.transactionId })
  expect(await exists(join(root, 'kept', 'existing.txt'))).toBe(true)
  expect(await exists(join(root, 'kept'))).toBe(true)
  // 用户后来放进去的文件让目录非空：只删空目录，绝不连带删掉别人的东西。
  expect(await exists(join(root, 'fresh', 'inner', 'user.txt'))).toBe(true)
  expect(await exists(join(root, 'fresh'))).toBe(true)
})

test('新建目录跟着事务落盘，跨进程重启后的撤销照样清得掉', async () => {
  const statePath = join(stateDirectory, 'transactions.json')
  const kernel = await createProjectKernel({ root, transactionStatePath: statePath })
  const transaction = await kernel.prepareEdit({
    operations: [{ operation: { type: 'create_file', path: 'a/b/c.txt', content: 'x\n' } }],
  })
  await kernel.applyEdit({ transactionId: transaction.transactionId })
  expect(kernel.getTransaction(transaction.transactionId)?.metadata?.createdDirectories).toEqual(['a', 'a/b'])

  const restarted = await createProjectKernel({ root, transactionStatePath: statePath })
  await restarted.rollback({ transactionId: transaction.transactionId })
  expect(await exists(join(root, 'a'))).toBe(false)
})
