import { expect, test } from 'bun:test'

import { KernelEventHub } from '../../src/impl/runtime/KernelEventHub'

test('a late old subscription disposal cannot remove the new generation bucket', async () => {
  const hub = new KernelEventHub()
  const received: number[] = []
  const old = hub.subscribe('subscriber', 1, 'changed', () => {
    received.push(1)
  })
  hub.removeOwner('subscriber', 1)
  hub.subscribe('subscriber', 2, 'changed', () => {
    received.push(2)
  })
  old.dispose()
  old.dispose()

  await hub.publish('publisher', 1, 'changed', null)
  expect(received).toEqual([2])
  hub.removeOwner('subscriber', 2)
  await hub.publish('publisher', 1, 'changed', null)
  expect(received).toEqual([2])
})
