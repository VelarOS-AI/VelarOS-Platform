import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { TransactionRepository } from '../impl/transactions/TransactionRepository'
import { createProjectKernel } from '../index'
import type { EditIntent } from '../types/edit'
import type { StoredTransaction } from '../types/transaction'
import { boundedChangeIntents } from '../utils/transactions/change-records'
import { changeProjectionBytes, storedTransactionBytes } from '../utils/transactions/history-budget'
import { ProjectTuning } from '../utils/tuning'

let directory = ''
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'project-history-budget-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** 造一个只有正文体量、其余字段最小的事务，用来试字节预算。 */
function transactionOf(transactionId: string, status: StoredTransaction['status'], contentBytes: number): StoredTransaction {
  const content = 'x'.repeat(contentBytes)
  const transaction: Record<string, unknown> = {
    transactionId,
    status,
    patches: [{ patchId: `${transactionId}-p`, strategyId: 's', path: 'a.txt', diff: '', changedLines: 1, risk: 'low', oldContent: content, newContent: content }],
    changedFiles: ['a.txt'],
    diff: '',
    changedLines: 1,
    risk: 'low',
    createdAt: 1,
    baseSnapshots: [],
  }
  if (status === 'applied' || status === 'rolled_back') transaction.appliedAt = 2
  return transaction as unknown as StoredTransaction
}

test('字节预算按最旧先出淘汰，pending 事务与点名保护的一个都不淘汰', () => {
  const repository = new TransactionRepository({ maxTransactions: 100, maxTerminalTransactions: 100 })
  for (const id of ['t1', 't2', 't3']) repository.add(transactionOf(id, 'applied', 1_000))
  repository.add(transactionOf('t4', 'prepared', 1_000))

  // 四个各占 2000 字节；预算 6_400 只能少留一个：最旧的 t1 先出，还没应用的 t4 与点名保护的 t3 一个都不动。
  const evicted = repository.capBytes(storedTransactionBytes, 6_400, new Set(['t3', 't4']))
  expect(evicted).toEqual(['t1'])
  expect([...repository.values()].map((transaction) => transaction.transactionId)).toEqual(['t2', 't3', 't4'])
})

test('单个事务自己就超预算时不进可撤销历史，被保护时照样留着', () => {
  const repository = new TransactionRepository({ maxTransactions: 100, maxTerminalTransactions: 100 })
  repository.add(transactionOf('huge', 'applied', 10_000))
  expect(repository.capBytes(storedTransactionBytes, 1_000, new Set())).toEqual(['huge'])
  expect(repository.size).toBe(0)

  repository.add(transactionOf('huge', 'applied', 10_000))
  expect(repository.capBytes(storedTransactionBytes, 1_000, new Set(['huge']))).toEqual([])
  expect(repository.size).toBe(1)
})

test('淘汰出历史的事务不再记进终态保留顺序', () => {
  const repository = new TransactionRepository({ maxTransactions: 100, maxTerminalTransactions: 100 })
  repository.add(transactionOf('gone', 'applied', 10))
  repository.capBytes(storedTransactionBytes, 0, new Set())
  expect(repository.retainTerminal('gone')).toEqual([])
  expect(repository.size).toBe(0)
})

test('变更记录里的意图正文按上限截断，投影的字节账跟着变小', () => {
  const content = 'y'.repeat(ProjectTuning.persistence.changeIntentContentChars * 3)
  const intents: EditIntent[] = [{ operation: { type: 'replace_content', path: 'a.txt', expectedContent: content, content, mode: 'edit' } }]
  const bounded = boundedChangeIntents(intents)
  const operation = bounded[0]!.operation as { content: string; expectedContent: string; path: string }
  expect(operation.path).toBe('a.txt')
  expect(operation.content.length).toBeLessThan(content.length)
  expect(operation.content).toContain('变更记录只留前')

  const projectionOf = (value: readonly EditIntent[]) => changeProjectionBytes({
    transactionId: 't', lifecycle: 'applied', intents: value, patches: [], changedFiles: ['a.txt'],
    diff: '', changedLines: 1, risk: 'low', revisions: [], createdAt: 1,
  })
  expect(projectionOf(bounded)).toBeLessThan(projectionOf(intents) / 2)
})

/** 造一份接近读取上限（策略的 maxFileSizeToReadBytes 是 5 MiB）的多行正文：单个事务的记账就占掉预算的一大半。 */
const BigFileBody = `${'a'.repeat(63)}\n`.repeat(Math.floor((4.5 * 1024 * 1024) / 64))

/** 在给定内核上把大文件整体改一遍并提交，返回事务号。 */
async function applyBigEdit(kernel: Awaited<ReturnType<typeof createProjectKernel>>, marker: string): Promise<string> {
  const current = await kernel.read({ path: 'big.txt', maxChars: BigFileBody.length * 2 })
  const transaction = await kernel.prepareEdit({
    operations: [{ operation: { type: 'replace_content', path: 'big.txt', expectedContent: current.content!, content: `${BigFileBody}// ${marker}\n`, mode: 'edit' } }],
    baseRevisions: { 'big.txt': current.snapshot.revision },
  })
  await kernel.applyEdit({ transactionId: transaction.transactionId })
  return transaction.transactionId
}

test('历史再大也不让 apply 失败：状态文件按预算收敛，撤销掉出历史的改动如实说没有撤销记录', async () => {
  const root = join(directory, 'project')
  const statePath = join(directory, 'host-state', 'transactions.json')
  await mkdir(root, { recursive: true })
  // 改动前：每次 apply 都把整份新旧正文往状态文件里累加，改一个 3 MB 文件第 11 次就撞 256 MiB 顶，此后整个工作区改不了。
  await writeFile(join(root, 'big.txt'), BigFileBody)

  const kernel = await createProjectKernel({ root, transactionStatePath: statePath })
  const applied: string[] = []
  for (let round = 0; round < 4; round += 1) applied.push(await applyBigEdit(kernel, String(round)))

  expect((await stat(statePath)).size).toBeLessThan(ProjectTuning.persistence.stateFileBytes)
  const retained = applied.filter((transactionId) => kernel.getTransaction(transactionId))
  expect(retained.length).toBeLessThan(applied.length)
  expect(retained.at(-1)).toBe(applied.at(-1))

  // 掉出历史的事务仍然记在变更记录里，只是撤销不了；错误要说清是没留撤销记录，不是事务号写错。
  const evicted = applied.find((transactionId) => !kernel.getTransaction(transactionId))!
  expect(kernel.changeFeed.get(evicted)?.lifecycle).toBe('applied')
  await expect(kernel.rollback({ transactionId: evicted })).rejects.toMatchObject({ reason: 'NOT_SUPPORTED' })
  await expect(kernel.rollback({ transactionId: evicted })).rejects.toThrow('没有留下撤销记录')
  await expect(kernel.rollback({ transactionId: 'tx_never_existed' })).rejects.toMatchObject({ reason: 'INVALID_INPUT' })

  // 最后一次 apply 仍然能撤销，磁盘回到它写之前的样子。
  await kernel.rollback({ transactionId: applied.at(-1)! })
  expect(await readFile(join(root, 'big.txt'), 'utf8')).toBe(`${BigFileBody}// 2\n`)
}, 180_000)

test('没有事务状态文件时，内存里的可撤销历史也按同一个字节预算收敛', async () => {
  const root = join(directory, 'memory-project')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'big.txt'), BigFileBody)

  const kernel = await createProjectKernel({ root })
  const applied: string[] = []
  for (let round = 0; round < 4; round += 1) applied.push(await applyBigEdit(kernel, String(round)))
  expect((await kernel.status()).transactions).toBeLessThan(applied.length)
}, 180_000)
