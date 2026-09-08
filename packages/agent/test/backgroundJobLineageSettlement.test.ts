import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { KernelBackgroundJobManager } from '../src/kernel/background-jobs'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('session cancellation crosses a completed parent to a still-running descendant', async () => {
  const manager = new KernelBackgroundJobManager()
  let childCancelled = false
  manager.start({ id: 'parent', sessionId: 'root', kind: 'sub-agent', label: 'parent' })
  manager.start({ id: 'child', sessionId: 'child-session', parentSessionId: 'parent', kind: 'sub-agent', label: 'child', onCancel: () => { childCancelled = true } })
  manager.complete('parent')
  assert.equal(manager.cancelSession('root'), 1)
  assert.equal(childCancelled, true)
  assert.equal(manager.snapshotOutputForSession('child-session', 'child')?.status, 'cancelled')
})

test('parent settlement and terminal pruning cannot detach descendant cancellation or cleanup waits', async () => {
  let now = 0
  const manager = new KernelBackgroundJobManager({ now: () => now, terminalJobTtlMs: 1 })
  const parent = gate()
  const child = gate()
  manager.start({ id: 'parent', sessionId: 'root', kind: 'sub-agent', label: 'parent' })
  manager.trackExecution('parent', parent.promise)
  manager.start({ id: 'child', sessionId: 'child-session', parentSessionId: 'parent', kind: 'sub-agent', label: 'child' })
  manager.trackExecution('child', child.promise)
  manager.complete('parent')
  parent.resolve()
  await parent.promise
  await Promise.resolve()
  now = 2
  manager.start({ id: 'unrelated', sessionId: 'unrelated', kind: 'sub-agent', label: 'unrelated' })
  assert.equal(manager.snapshotOutputForSession('root', 'parent'), null)
  let settled = false
  const wait = manager.awaitSessionSettled('root').then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(manager.cancelSession('root'), 1)
  assert.equal(manager.snapshotOutputForSession('unrelated', 'unrelated')?.status, 'running')
  child.resolve()
  await wait
  assert.equal(settled, true)
})
