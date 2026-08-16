import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  FileProjectChangeFeed,
  MemoryProjectChangeFeed,
  type ProjectChangeFeedWriter,
} from '../src/change-feed'
import { createProjectKernel } from '../src/core/project-kernel'
import {
  createProjectTransactionController,
  type ProjectTransactionController,
} from '../src/transaction-controller'
import { FileProjectTransactionStateStore } from '../src/transaction-state'

interface DurableHarness {
  readonly controller: ProjectTransactionController
  readonly feed: FileProjectChangeFeed
}

async function openDurableHarness(
  root: string,
  statePath: string,
  feedPath: string,
): Promise<DurableHarness> {
  const feed = new FileProjectChangeFeed({ path: feedPath })
  const project = await createProjectKernel({
    root,
    changeFeed: feed,
    transactionStatePath: statePath,
  })
  return {
    controller: createProjectTransactionController(project),
    feed,
  }
}

async function prepareReplace(
  root: string,
  statePath: string,
  feed: ProjectChangeFeedWriter,
): Promise<{ transactionId: string; after: string }> {
  const project = await createProjectKernel({
    root,
    changeFeed: feed,
    transactionStatePath: statePath,
  })
  const transaction = await project.prepareEdit({
    operations: [{
      reason: 'exercise durable transaction ownership',
      operation: {
        type: 'replace_text',
        path: 'note.txt',
        oldText: 'before',
        newText: 'after',
      },
    }],
  })
  const validation = await project.validate({ transactionId: transaction.transactionId })
  expect(validation.ok).toBe(true)
  return {
    transactionId: transaction.transactionId,
    after: transaction.patches[0]?.newContent ?? 'after\n',
  }
}

describe('durable project transaction controller', () => {
  test('keeps the Desktop surface finite and applies or rolls back after owner restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-project-controller-'))
    const root = join(directory, 'project')
    const statePath = join(directory, 'host-state', 'transactions.json')
    const feedPath = join(directory, 'host-state', 'changes.jsonl')
    await mkdir(root)
    await writeFile(join(root, 'note.txt'), 'before\n')

    let feed = new FileProjectChangeFeed({ path: feedPath })
    try {
      const project = await createProjectKernel({
        root,
        changeFeed: feed,
        transactionStatePath: statePath,
      })
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
      feed.close()

      let reopened = await openDurableHarness(root, statePath, feedPath)
      feed = reopened.feed
      expect(Object.keys(reopened.controller).sort()).toEqual([
        'apply',
        'get',
        'list',
        'rollback',
        'subscribe',
      ])
      expect(reopened.controller.get(transaction.transactionId)?.lifecycle).toBe('prepared')
      await reopened.controller.apply({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('after\n')
      feed.close()

      reopened = await openDurableHarness(root, statePath, feedPath)
      feed = reopened.feed
      expect(reopened.controller.get(transaction.transactionId)?.lifecycle).toBe('applied')
      await reopened.controller.rollback({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('before\n')
      expect(reopened.controller.list()).toHaveLength(1)
      await expect(reopened.controller.rollback({ transactionId: transaction.transactionId })).rejects.toThrow(
        '只能回滚已应用的事务',
      )
      await reopened.controller.apply({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('after\n')
    } finally {
      feed.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('restores an interrupted apply before serving the restarted owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-project-recover-apply-'))
    const root = join(directory, 'project')
    const statePath = join(directory, 'host-state', 'transactions.json')
    const feedPath = join(directory, 'host-state', 'changes.jsonl')
    await mkdir(root)
    await writeFile(join(root, 'note.txt'), 'before\n')

    let feed = new FileProjectChangeFeed({ path: feedPath })
    try {
      const prepared = await prepareReplace(root, statePath, feed)
      feed.close()
      const store = new FileProjectTransactionStateStore({ path: statePath, root })
      const snapshot = store.snapshot()
      store.commit({
        transactions: snapshot.transactions,
        projections: snapshot.projections,
        pending: {
          kind: 'apply',
          transactionId: prepared.transactionId,
          previousStatus: 'validated',
          restore: [{
            path: 'note.txt',
            exists: true,
            content: 'before\n',
            ownedStates: [{ exists: true, content: prepared.after }],
          }],
        },
      })
      await writeFile(join(root, 'note.txt'), prepared.after)

      const reopened = await openDurableHarness(root, statePath, feedPath)
      feed = reopened.feed
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('before\n')
      expect(new FileProjectTransactionStateStore({ path: statePath, root }).snapshot().pending).toBeUndefined()
      expect(reopened.controller.get(prepared.transactionId)?.lifecycle).toBe('validated')
      await reopened.controller.apply({ transactionId: prepared.transactionId })
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('after\n')
    } finally {
      feed.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('restores an interrupted rollback to its previously committed applied state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-project-recover-rollback-'))
    const root = join(directory, 'project')
    const statePath = join(directory, 'host-state', 'transactions.json')
    const feedPath = join(directory, 'host-state', 'changes.jsonl')
    await mkdir(root)
    await writeFile(join(root, 'note.txt'), 'before\n')

    let feed = new FileProjectChangeFeed({ path: feedPath })
    try {
      const prepared = await prepareReplace(root, statePath, feed)
      const firstController = createProjectTransactionController(
        await createProjectKernel({ root, changeFeed: feed, transactionStatePath: statePath }),
      )
      await firstController.apply({ transactionId: prepared.transactionId })
      feed.close()

      const store = new FileProjectTransactionStateStore({ path: statePath, root })
      const snapshot = store.snapshot()
      store.commit({
        transactions: snapshot.transactions,
        projections: snapshot.projections,
        pending: {
          kind: 'rollback',
          transactionId: prepared.transactionId,
          previousStatus: 'applied',
          restore: [{
            path: 'note.txt',
            exists: true,
            content: prepared.after,
            ownedStates: [{ exists: true, content: 'before\n' }],
          }],
        },
      })
      await writeFile(join(root, 'note.txt'), 'before\n')

      const reopened = await openDurableHarness(root, statePath, feedPath)
      feed = reopened.feed
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('after\n')
      expect(reopened.controller.get(prepared.transactionId)?.lifecycle).toBe('applied')
      await reopened.controller.rollback({ transactionId: prepared.transactionId })
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('before\n')
    } finally {
      feed.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('fails closed instead of overwriting an external edit during recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-project-recover-conflict-'))
    const root = join(directory, 'project')
    const statePath = join(directory, 'host-state', 'transactions.json')
    const feedPath = join(directory, 'host-state', 'changes.jsonl')
    await mkdir(root)
    await writeFile(join(root, 'note.txt'), 'before\n')

    let feed = new FileProjectChangeFeed({ path: feedPath })
    try {
      const prepared = await prepareReplace(root, statePath, feed)
      feed.close()
      const store = new FileProjectTransactionStateStore({ path: statePath, root })
      const snapshot = store.snapshot()
      store.commit({
        transactions: snapshot.transactions,
        projections: snapshot.projections,
        pending: {
          kind: 'apply',
          transactionId: prepared.transactionId,
          previousStatus: 'validated',
          restore: [{
            path: 'note.txt',
            exists: true,
            content: 'before\n',
            ownedStates: [{ exists: true, content: prepared.after }],
          }],
        },
      })
      await writeFile(join(root, 'note.txt'), 'external\n')

      feed = new FileProjectChangeFeed({ path: feedPath })
      await expect(createProjectKernel({
        root,
        changeFeed: feed,
        transactionStatePath: statePath,
      })).rejects.toMatchObject({ reason: 'TRANSACTION_RECOVERY_CONFLICT' })
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('external\n')
      expect(new FileProjectTransactionStateStore({ path: statePath, root }).snapshot().pending).toBeDefined()
    } finally {
      feed.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('commits transaction state before a failed feed and reconciles the audit projection later', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-project-feed-reconcile-'))
    const root = join(directory, 'project')
    const statePath = join(directory, 'host-state', 'transactions.json')
    const feedPath = join(directory, 'host-state', 'changes.jsonl')
    await mkdir(root)
    await writeFile(join(root, 'note.txt'), 'before\n')

    const memory = new MemoryProjectChangeFeed()
    const failingFeed: ProjectChangeFeedWriter = {
      list: (options) => memory.list(options),
      get: (transactionId) => memory.get(transactionId),
      subscribe: (listener) => memory.subscribe(listener),
      record() {
        throw new Error('simulated feed outage')
      },
    }
    const prepared = await prepareReplace(root, statePath, failingFeed)
    const durable = new FileProjectTransactionStateStore({ path: statePath, root }).snapshot()
    expect(durable.transactions).toHaveLength(1)
    expect(durable.projections[0]?.lifecycle).toBe('validated')

    const reopened = await openDurableHarness(root, statePath, feedPath)
    try {
      expect(reopened.controller.get(prepared.transactionId)?.lifecycle).toBe('validated')
      expect(reopened.controller.list()).toHaveLength(1)
    } finally {
      reopened.feed.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
