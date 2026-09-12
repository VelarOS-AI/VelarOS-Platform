import { describe, expect, test } from 'bun:test'

import type { ProjectChangeRecordInput } from '../src/change-feed'
import { TransactionProjectionRepository } from '../src/core/transaction-projection-repository'

function projection(
  transactionId: string,
  lifecycle: ProjectChangeRecordInput['lifecycle'] = 'prepared',
): ProjectChangeRecordInput {
  return {
    transactionId,
    lifecycle,
    intents: [],
    patches: [],
    changedFiles: [],
    diff: '',
    changedLines: 0,
    risk: 'low',
    revisions: [],
    createdAt: 1,
  }
}

describe('TransactionProjectionRepository', () => {
  test('stores and replaces the latest projection by transaction id', () => {
    const repository = new TransactionProjectionRepository({ maxProjections: 100 })
    const prepared = projection('tx_one')
    const applied = projection('tx_one', 'applied')

    repository.set(prepared)
    expect(repository.get('tx_one')).toBe(prepared)

    repository.set(applied)
    expect(repository.get('tx_one')).toBe(applied)
    expect([...repository.values()]).toEqual([applied])
  })

  test('hydrates in durable order and clears stale in-memory entries', () => {
    const repository = new TransactionProjectionRepository({ maxProjections: 100 })
    repository.set(projection('tx_stale'))
    const first = projection('tx_first')
    const second = projection('tx_second', 'validated')

    repository.hydrate([first, second])

    expect(repository.get('tx_stale')).toBeUndefined()
    expect([...repository.values()]).toEqual([first, second])
  })

  test('caps only projections whose transactions are no longer retained', () => {
    const repository = new TransactionProjectionRepository({ maxProjections: 2 })
    repository.hydrate([
      projection('tx_retained'),
      projection('tx_orphan_old'),
      projection('tx_orphan_new'),
    ])

    const evicted = repository.cap((transactionId) => transactionId === 'tx_retained')

    expect(evicted).toEqual(['tx_orphan_old'])
    expect([...repository.values()].map((value) => value.transactionId)).toEqual([
      'tx_retained',
      'tx_orphan_new',
    ])
  })

  test('restores projection values and insertion order from a structural snapshot', () => {
    const repository = new TransactionProjectionRepository({ maxProjections: 2 })
    const first = projection('tx_first')
    const second = projection('tx_second')
    repository.hydrate([first, second])
    const before = repository.snapshot()

    repository.delete(first.transactionId)
    repository.set(projection('tx_third'))
    repository.restore(before)

    expect([...repository.values()]).toEqual([first, second])
  })

  test('supports synchronizing transaction eviction without retaining stale projections', () => {
    const repository = new TransactionProjectionRepository({ maxProjections: 2 })
    repository.hydrate([
      projection('tx_first'),
      projection('tx_second'),
    ])

    repository.delete('tx_first')
    repository.set(projection('tx_third'))
    repository.cap((transactionId) => transactionId === 'tx_second' || transactionId === 'tx_third')

    expect([...repository.values()].map((value) => value.transactionId)).toEqual([
      'tx_second',
      'tx_third',
    ])
  })

  test('deletes projections without affecting unrelated entries', () => {
    const repository = new TransactionProjectionRepository({ maxProjections: 100 })
    const retained = projection('tx_retained')
    repository.hydrate([projection('tx_deleted'), retained])

    expect(repository.delete('tx_deleted')).toBe(true)
    expect(repository.delete('tx_missing')).toBe(false)
    expect([...repository.values()]).toEqual([retained])
  })
})
