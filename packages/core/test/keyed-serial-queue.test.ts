import { expect, test } from 'bun:test'

import { createKeyedSerialQueue } from '../src/utils/KeyedSerialQueue'

test('same-key work is FIFO while other keys run independently', async () => {
  const queue = createKeyedSerialQueue()
  const events: string[] = []
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = queue.run('a', async () => {
    events.push('a1:start')
    await blocked
    events.push('a1:end')
  })
  const second = queue.run('a', () => {
    events.push('a2')
    return 2
  })
  const third = queue.run('a', () => {
    events.push('a3')
    return 3
  })
  try {
    await queue.run('b', () => {
      events.push('b')
    })
    expect(events).toEqual(['a1:start', 'b'])
  } finally {
    release()
  }
  expect(await Promise.all([first, second, third])).toEqual([undefined, 2, 3])
  expect(events).toEqual(['a1:start', 'b', 'a1:end', 'a2', 'a3'])
})

test('a failed operation reports its own error and releases queued and future work', async () => {
  const queue = createKeyedSerialQueue()
  const error = new Error('write failed')
  const first = queue.run('file', () => {
    throw error
  })
  const second = queue.run('file', async () => 'next')
  expect(await Promise.allSettled([first, second])).toEqual([
    { status: 'rejected', reason: error },
    { status: 'fulfilled', value: 'next' },
  ])
  expect(await queue.run('file', () => 'after idle')).toBe('after idle')
})
