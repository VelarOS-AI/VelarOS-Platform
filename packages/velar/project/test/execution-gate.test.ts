import { expect, test } from 'bun:test'

import { ProjectExecutionGate } from '../impl/operations/ProjectExecutionGate'

const gate = new ProjectExecutionGate()
const signal = () => new AbortController().signal
function deferred() {
  let done!: () => void
  const promise = new Promise<void>((resolve) => {
    done = resolve
  })
  return { promise, done }
}

test('foreground build completion precedes a dependent read across agent calls, while other workspaces progress', async () => {
  const build = deferred()
  const started = deferred()
  const order: string[] = []
  const writing = gate.run('/repo', true, signal(), async () => {
    order.push('build')
    started.done()
    await build.promise
    order.push('built')
  })
  await started.promise
  const reading = gate.run('/repo', false, signal(), () => {
    order.push('test')
  })
  await gate.run('/other', true, signal(), () => {
    order.push('other')
  })
  expect(order).toEqual(['build', 'other'])
  build.done()
  await Promise.all([writing, reading])
  expect(order).toEqual(['build', 'other', 'built', 'test'])
})

test('readers overlap, a queued writer is fair, and cancelled waiters never run', async () => {
  const release = deferred()
  const order: string[] = []
  const one = gate.run('/fair', false, signal(), async () => {
    order.push('read1')
    await release.promise
  })
  const two = gate.run('/fair', false, signal(), () => {
    order.push('read2')
  })
  await two
  expect(order).toEqual(['read1', 'read2'])
  const writer = gate.run('/fair', true, signal(), () => {
    order.push('write')
  })
  const abort = new AbortController()
  const cancelled = gate.run('/fair', false, abort.signal, () => {
    throw new Error('must not run')
  }).catch(() => 'cancelled')
  abort.abort()
  const after = gate.run('/fair', false, signal(), () => {
    order.push('after')
  })
  release.done()
  await Promise.all([one, writer, after])
  expect(await cancelled).toBe('cancelled')
  expect(order).toEqual(['read1', 'read2', 'write', 'after'])
})
