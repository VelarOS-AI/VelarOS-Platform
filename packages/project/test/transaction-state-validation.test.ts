import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { FileProjectTransactionStateStore } from '../src/transaction-state'
import type { ProjectTransactionStatus } from '../src/types/transaction'

interface TransactionFixture {
  status: ProjectTransactionStatus
  appliedAt?: number
}

async function writeSnapshot(
  directory: string,
  root: string,
  name: string,
  transaction: TransactionFixture,
): Promise<string> {
  const statePath = join(directory, 'state', `${name}.json`)
  await mkdir(join(directory, 'state'), { recursive: true })
  await writeFile(statePath, JSON.stringify({
    formatVersion: 1,
    revision: 1,
    root,
    transactions: [{
      transactionId: `tx_${name}`,
      status: transaction.status,
      patches: [],
      changedFiles: [],
      diff: '',
      changedLines: 0,
      risk: 'low',
      createdAt: 1,
      ...(transaction.appliedAt === undefined ? {} : { appliedAt: transaction.appliedAt }),
      baseSnapshots: [],
    }],
    projections: [],
  }))
  return statePath
}

describe('FileProjectTransactionStateStore lifecycle validation', () => {
  test('rejects durable transactions whose status and appliedAt disagree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-project-state-invalid-'))
    const root = join(directory, 'project')
    await mkdir(root)

    try {
      const invalid = [
        { name: 'prepared-with-applied-at', status: 'prepared', appliedAt: 2 },
        { name: 'validated-with-applied-at', status: 'validated', appliedAt: 2 },
        { name: 'applied-without-applied-at', status: 'applied' },
        { name: 'rolled-back-without-applied-at', status: 'rolled_back' },
      ] as const

      for (const fixture of invalid) {
        const statePath = await writeSnapshot(directory, root, fixture.name, fixture)
        expect(() => new FileProjectTransactionStateStore({ path: statePath, root })).toThrow(
          'transaction status/appliedAt mismatch',
        )
        try {
          new FileProjectTransactionStateStore({ path: statePath, root })
          throw new Error('Expected invalid durable transaction to fail')
        } catch (error) {
          expect(error).toMatchObject({ reason: 'TRANSACTION_RECOVERY_CONFLICT' })
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('loads every consistent durable stable state without changing format version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-project-state-valid-'))
    const root = join(directory, 'project')
    await mkdir(root)

    try {
      const valid = [
        { name: 'prepared', status: 'prepared' },
        { name: 'validated', status: 'validated' },
        { name: 'applied', status: 'applied', appliedAt: 0 },
        { name: 'rolled-back', status: 'rolled_back', appliedAt: 2 },
      ] as const

      for (const fixture of valid) {
        const statePath = await writeSnapshot(directory, root, fixture.name, fixture)
        const snapshot = new FileProjectTransactionStateStore({ path: statePath, root }).snapshot()
        expect(snapshot.formatVersion).toBe(1)
        expect(snapshot.transactions[0]?.status).toBe(fixture.status)
        expect(snapshot.transactions[0]?.appliedAt).toBe(fixture.appliedAt)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
