import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'

import { TransactionRecovery } from '../src/impl/transactions/TransactionRecovery'
import { createProjectKernel, type ProjectKernel } from '../src/index'
import type { ProjectTransactionStateSnapshot } from '../src/types/transaction'

let directory = ''
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'project-pending-concurrency-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** 把一组文件整体改写成同一段正文，返回准备好的事务号。 */
async function prepare(kernel: ProjectKernel, paths: readonly string[], text: string): Promise<string> {
  const operations = []
  const baseRevisions: Record<string, string> = {}
  for (const path of paths) {
    const current = await kernel.read({ path })
    baseRevisions[path] = current.snapshot.revision
    operations.push({ operation: { type: 'replace_content' as const, path, expectedContent: current.content!, content: text, mode: 'edit' as const } })
  }
  return (await kernel.prepareEdit({ operations, baseRevisions })).transactionId
}

/** 读回事务状态文件。 */
async function readState(statePath: string): Promise<ProjectTransactionStateSnapshot> {
  return JSON.parse(await readFile(statePath, 'utf8')) as ProjectTransactionStateSnapshot
}

test('并发的两个 apply 各留各的恢复计划，重启后逐个恢复', async () => {
  const root = join(directory, 'project')
  const statePath = join(directory, 'host-state', 'transactions.json')
  await mkdir(root, { recursive: true })
  for (const name of ['a1.txt', 'a2.txt', 'b.txt']) await writeFile(join(root, name), 'original\n')

  const kernel = await createProjectKernel({ root, transactionStatePath: statePath })
  const slow = await prepare(kernel, ['a1.txt', 'a2.txt'], 'SLOW\n')
  const fast = await prepare(kernel, ['b.txt'], 'FAST\n')

  // 让慢事务停在两次写盘之间：路径不相交，锁允许另一个事务同时 apply（runBatch 并发时就是这样）。
  const original = TransactionRecovery.prototype.writePatch
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const hook = spyOn(TransactionRecovery.prototype, 'writePatch').mockImplementation(async function (
    this: TransactionRecovery,
    ...args: Parameters<typeof original>
  ) {
    if (args[0].transactionId === slow && args[1].path === 'a2.txt') await gate
    return original.apply(this, args)
  })

  try {
    const slowApply = kernel.applyEdit({ transactionId: slow })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await readState(statePath)).pendings?.map((plan) => plan.transactionId)).toEqual([slow])

    // 另一个事务整段跑完（含它自己的恢复计划落盘与清除）之后，慢事务的恢复计划必须还在。
    await kernel.applyEdit({ transactionId: fast })
    const midway = await readState(statePath)
    expect(midway.pendings?.map((plan) => plan.transactionId)).toEqual([slow])
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('FAST\n')
    expect(await readFile(join(root, 'a1.txt'), 'utf8')).toBe('SLOW\n')
    expect(await readFile(join(root, 'a2.txt'), 'utf8')).toBe('original\n')

    // 就地「崩溃」：拿这一刻的状态文件另起一个内核，半写的慢事务要被还原回去。
    const crashed = join(directory, 'host-state', 'crash.json')
    await copyFile(statePath, crashed)
    const restarted = await createProjectKernel({ root, transactionStatePath: crashed })
    expect(await readFile(join(root, 'a1.txt'), 'utf8')).toBe('original\n')
    expect(await readFile(join(root, 'a2.txt'), 'utf8')).toBe('original\n')
    expect(restarted.getTransaction(slow)?.status).toBe('validated')
    expect(restarted.getTransaction(fast)?.status).toBe('applied')
    expect((await readState(crashed)).pendings).toBeUndefined()

    release()
    await slowApply.catch(() => undefined)
  } finally {
    release()
    hook.mockRestore()
  }
}, 60_000)

test('旧格式状态文件里的单槽位 pending 读回后照样恢复', async () => {
  const root = join(directory, 'legacy')
  const statePath = join(directory, 'legacy-state', 'transactions.json')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'note.txt'), 'before\n')

  const kernel = await createProjectKernel({ root, transactionStatePath: statePath })
  const transaction = await prepare(kernel, ['note.txt'], 'after\n')
  await kernel.applyEdit({ transactionId: transaction })

  // 把状态文件改回格式版本 2 的单槽位写法，模拟旧版本留下的恢复点。
  const state = await readState(statePath)
  const stored = state.transactions.find((item) => item.transactionId === transaction)!
  stored.status = 'validated'
  delete (stored as { appliedAt?: number }).appliedAt
  const legacy = {
    ...state,
    formatVersion: 2,
    transactions: [stored],
    projections: state.projections.filter((projection) => projection.transactionId === transaction),
    bytePlans: state.bytePlans,
    pendings: undefined,
    pending: {
      kind: 'apply',
      transactionId: transaction,
      previousStatus: 'validated',
      restore: [{ path: 'note.txt', exists: true, content: 'before\n', ownedStates: [{ exists: true, content: 'after\n' }] }],
    },
  }
  await writeFile(statePath, JSON.stringify(legacy))

  const restarted = await createProjectKernel({ root, transactionStatePath: statePath })
  expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('before\n')
  expect(restarted.getTransaction(transaction)?.status).toBe('validated')
  const upgraded = await readState(statePath)
  expect(upgraded.formatVersion).toBe(3)
  expect(upgraded.pending).toBeUndefined()
  expect(upgraded.pendings).toBeUndefined()
}, 60_000)
