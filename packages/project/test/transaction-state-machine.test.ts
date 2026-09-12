import { describe, expect, test } from 'bun:test'

import {
  type ProjectTransactionCommand,
  ProjectTransactionCommandTable,
  TransactionStateMachine,
} from '../src/core/transaction-state-machine'
import { ProjectError } from '../src/errors'
import type {
  ProjectTransactionStatus,
  StoredTransaction,
} from '../src/types/transaction'

const StableStatuses = [
  'prepared',
  'validated',
  'applied',
  'rolled_back',
] as const satisfies readonly ProjectTransactionStatus[]

function transaction(
  status: ProjectTransactionStatus,
  options: { appliedAt?: number } = {},
): StoredTransaction {
  return {
    transactionId: `tx_${status}`,
    status,
    patches: [],
    changedFiles: [],
    diff: '',
    changedLines: 0,
    risk: 'low',
    createdAt: 1,
    baseSnapshots: [],
    ...(options.appliedAt === undefined ? {} : { appliedAt: options.appliedAt }),
  }
}

function invoke(
  machine: TransactionStateMachine,
  command: ProjectTransactionCommand,
  value: StoredTransaction,
): unknown {
  switch (command) {
    case 'amend':
      return machine.amend(value)
    case 'validate':
      return machine.validationSucceeded(value)
    case 'apply':
      return machine.beginApply(value)
    case 'rollback':
      return machine.beginRollback(value)
    case 'discard':
      return machine.assertDiscardable(value)
  }
}

describe('TransactionStateMachine', () => {
  test('declares and enforces the complete command-by-stable-state table', () => {
    const machine = new TransactionStateMachine()

    for (const command of Object.keys(ProjectTransactionCommandTable) as ProjectTransactionCommand[]) {
      for (const status of StableStatuses) {
        const value = transaction(
          status,
          status === 'applied' || status === 'rolled_back' ? { appliedAt: 2 } : {},
        )
        const allowed = ProjectTransactionCommandTable[command]
          .includes(status as never)

        if (allowed) {
          expect(() => invoke(machine, command, value)).not.toThrow()
        } else {
          try {
            invoke(machine, command, value)
            throw new Error(`Expected ${command} from ${status} to fail`)
          } catch (error) {
            expect(error).toBeInstanceOf(ProjectError)
            expect(error).toMatchObject({
              reason: 'INVALID_INPUT',
              details: {
                transactionId: value.transactionId,
                command,
                status,
              },
            })
          }
        }
      }
    }
  })

  test('moves a successful validation only from mutable stable states', () => {
    const machine = new TransactionStateMachine()

    expect(machine.validationSucceeded(transaction('prepared'))).toBe('validated')
    expect(machine.validationSucceeded(transaction('validated'))).toBe('validated')
    expect(machine.validationSucceeded(transaction('applied', { appliedAt: 2 }))).toBe('applied')
    expect(machine.validationSucceeded(transaction('rolled_back', { appliedAt: 2 }))).toBe('rolled_back')
  })

  test('amend invalidates validation and rejects inconsistent appliedAt state', () => {
    const machine = new TransactionStateMachine()

    expect(machine.amend(transaction('prepared'))).toBe('prepared')
    expect(machine.amend(transaction('validated'))).toBe('prepared')
    expect(() => machine.amend(transaction('prepared', { appliedAt: 2 }))).toThrow(ProjectError)
  })

  test('apply execution tokens commit or abort without persisting execution state', () => {
    const machine = new TransactionStateMachine()

    for (const status of ['prepared', 'validated', 'rolled_back'] as const) {
      const execution = machine.beginApply(transaction(
        status,
        status === 'rolled_back' ? { appliedAt: 2 } : {},
      ))
      expect(execution).toEqual({ command: 'apply', from: status, status: 'applying' })
      expect(machine.executionStatus(execution)).toBe('applying')
      expect(machine.commit(execution)).toBe('applied')
      expect(machine.abort(execution)).toBe(status)
    }
  })

  test('rollback execution tokens commit or abort to the applied state', () => {
    const machine = new TransactionStateMachine()
    const execution = machine.beginRollback(transaction('applied', { appliedAt: 2 }))

    expect(execution).toEqual({ command: 'rollback', from: 'applied', status: 'rolling_back' })
    expect(machine.executionStatus(execution)).toBe('rolling_back')
    expect(machine.commit(execution)).toBe('rolled_back')
    expect(machine.abort(execution)).toBe('applied')
  })

  test('rejects every command when status and appliedAt describe different stable states', () => {
    const machine = new TransactionStateMachine()
    const inconsistent = [
      transaction('prepared', { appliedAt: 2 }),
      transaction('validated', { appliedAt: 2 }),
      transaction('applied'),
      transaction('rolled_back'),
    ]

    for (const value of inconsistent) {
      for (const command of Object.keys(ProjectTransactionCommandTable) as ProjectTransactionCommand[]) {
        expect(() => invoke(machine, command, value)).toThrow('事务状态与 appliedAt 不一致')
      }
    }
  })

  test('recognizes only durable terminal states', () => {
    const machine = new TransactionStateMachine()

    expect(machine.isTerminal('prepared')).toBe(false)
    expect(machine.isTerminal('validated')).toBe(false)
    expect(machine.isTerminal('applied')).toBe(true)
    expect(machine.isTerminal('rolled_back')).toBe(true)
  })
})
