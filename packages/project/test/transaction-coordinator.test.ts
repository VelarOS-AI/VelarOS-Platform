import { describe, expect, test } from 'bun:test'

import { TransactionCoordinator } from '../src/core/transaction-coordinator'
import { ProjectError } from '../src/errors'

describe('TransactionCoordinator', () => {
  test('serializes commands for one transaction and releases the queue after failure', async () => {
    const coordinator = new TransactionCoordinator()
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = coordinator.run('tx_same', async () => {
      events.push('first:start')
      await firstGate
      events.push('first:end')
      throw new Error('first failed')
    })
    const second = coordinator.run('tx_same', async () => {
      events.push('second')
      return 'ok'
    })

    await Promise.resolve()
    expect(coordinator.isBusy('tx_same')).toBe(true)
    expect(events).toEqual(['first:start'])
    releaseFirst()

    await expect(first).rejects.toThrow('first failed')
    await expect(second).resolves.toBe('ok')
    expect(events).toEqual(['first:start', 'first:end', 'second'])
    expect(coordinator.isBusy('tx_same')).toBe(false)
  })

  test('rejects nested transaction commands before they enter a queue', async () => {
    const coordinator = new TransactionCoordinator()

    await coordinator.run('tx_active', async () => {
      for (const requestedTransactionId of ['tx_active', 'tx_other']) {
        try {
          await coordinator.run(requestedTransactionId, async () => undefined)
          throw new Error('Expected nested command to fail')
        } catch (error) {
          expect(error).toBeInstanceOf(ProjectError)
          expect(error).toMatchObject({
            reason: 'INVALID_INPUT',
            details: {
              activeTransactionId: 'tx_active',
              requestedTransactionId,
            },
          })
          expect(coordinator.isBusy(requestedTransactionId)).toBe(
            requestedTransactionId === 'tx_active',
          )
        }
      }
    })

    expect(coordinator.isBusy('tx_active')).toBe(false)
    expect(coordinator.isBusy('tx_other')).toBe(false)
  })

  test('allows a child async task to start a command after the outer command finishes', async () => {
    const coordinator = new TransactionCoordinator()
    let runDeferred!: () => void
    const deferred = new Promise<void>((resolve, reject) => {
      runDeferred = () => {
        void coordinator.run('tx_deferred', async () => undefined).then(resolve, reject)
      }
    })

    await coordinator.run('tx_outer', async () => {
      setTimeout(runDeferred, 0)
    })
    await expect(deferred).resolves.toBeUndefined()
    expect(coordinator.isBusy('tx_deferred')).toBe(false)
  })
})
