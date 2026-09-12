import { describe, expect, test } from 'bun:test'

import { TransactionRepository } from '../src/core/transaction-repository'
import type {
  ProjectTransactionStatus,
  StoredTransaction,
} from '../src/types/transaction'

function transaction(
  transactionId: string,
  status: ProjectTransactionStatus = 'prepared',
): StoredTransaction {
  return {
    transactionId,
    status,
    patches: [],
    changedFiles: [],
    diff: '',
    changedLines: 0,
    risk: 'low',
    createdAt: 1,
    baseSnapshots: [],
    ...(status === 'applied' || status === 'rolled_back' ? { appliedAt: 2 } : {}),
  }
}

function repository(
  options: { maxTransactions?: number; maxTerminalTransactions?: number } = {},
): TransactionRepository {
  return new TransactionRepository({
    maxTransactions: options.maxTransactions ?? 100,
    maxTerminalTransactions: options.maxTerminalTransactions ?? 100,
  })
}

describe('TransactionRepository', () => {
  test('stores transactions and preserves insertion order', () => {
    const transactions = repository()
    const first = transaction('tx_first')
    const second = transaction('tx_second')

    transactions.add(first)
    transactions.add(second)

    expect(transactions.size).toBe(2)
    expect(transactions.get(first.transactionId)).toBe(first)
    expect(transactions.has(second.transactionId)).toBe(true)
    expect([...transactions.values()]).toEqual([first, second])
  })

  test('caps abandoned transactions by insertion order', () => {
    const transactions = repository({ maxTransactions: 2 })

    expect(transactions.add(transaction('tx_first'))).toEqual([])
    expect(transactions.add(transaction('tx_second'))).toEqual([])
    expect(transactions.add(transaction('tx_third'))).toEqual(['tx_first'])

    expect([...transactions.values()].map((value) => value.transactionId)).toEqual([
      'tx_second',
      'tx_third',
    ])
  })

  test('restores a structural snapshot after a failed publication', () => {
    const transactions = repository()
    const retained = transaction('tx_retained')
    transactions.add(retained)
    const before = transactions.snapshot()

    transactions.add(transaction('tx_transient'))
    transactions.delete(retained.transactionId)
    transactions.restore(before)

    expect([...transactions.values()]).toEqual([retained])
  })

  test('does not prune durable transactions while hydrating', () => {
    const transactions = repository({
      maxTransactions: 1,
      maxTerminalTransactions: 1,
    })
    const first = transaction('tx_first', 'applied')
    const second = transaction('tx_second', 'rolled_back')

    transactions.hydrate(
      [first, second],
      (value) => value.status === 'applied' || value.status === 'rolled_back',
    )

    expect([...transactions.values()]).toEqual([first, second])

    transactions.retainTerminal(second.transactionId)
    expect([...transactions.values()]).toEqual([second])
  })

  test('terminal retention is LRU and delete removes retention metadata', () => {
    const transactions = repository({ maxTerminalTransactions: 2 })
    const first = transaction('tx_first', 'applied')
    const second = transaction('tx_second', 'applied')
    const third = transaction('tx_third', 'applied')
    transactions.hydrate(
      [first, second, third],
      (value) => value.status === 'applied' || value.status === 'rolled_back',
    )

    expect(transactions.retainTerminal(first.transactionId)).toEqual(['tx_second'])
    expect(transactions.has(second.transactionId)).toBe(false)
    expect(transactions.has(first.transactionId)).toBe(true)
    expect(transactions.has(third.transactionId)).toBe(true)

    transactions.delete(third.transactionId)
    transactions.retainTerminal(first.transactionId)
    expect([...transactions.values()]).toEqual([first])
  })
})
