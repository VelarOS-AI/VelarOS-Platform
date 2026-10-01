import { expect, test } from 'bun:test'

import { BrowserSessionActionQueue } from '../../impl/session/BrowserSessionActionQueue'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('INV-16 a timed out action never overlaps its successor while it is still running', async () => {
  const queue = new BrowserSessionActionQueue()
  const held = deferred()
  const entered = deferred()
  const first = queue.run(
    's',
    async () => {
      entered.resolve()
      await held.promise
    },
    { holdCapMs: 10 }
  )
  await entered.promise
  let touched = false
  const next = queue.run('s', async () => {
    touched = true
  })
  const failures = Promise.allSettled([first, next])
  const result = await failures
  expect(result.every((item) => item.status === 'rejected')).toBe(true)
  expect(touched).toBe(false)
  queue.clear('s')
  await expect(
    queue.run('s', async () => {
      touched = true
    })
  ).rejects.toBeDefined()
  held.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await queue.run('s', async () => 'recovered')).toBe('recovered')
})

test('clear invalidates already queued actions and allows unrelated session recovery', async () => {
  const queue = new BrowserSessionActionQueue()
  const held = deferred()
  const entered = deferred()
  const first = queue.run(
    'old',
    async () => {
      entered.resolve()
      await held.promise
    },
    { holdCapMs: 1000 }
  )
  await entered.promise
  let touched = false
  const queued = queue.run('old', async () => {
    touched = true
  })
  const settled = Promise.allSettled([first, queued])
  queue.clear('old')
  expect(await queue.run('new', async () => 'new resource')).toBe('new resource')
  held.resolve()
  const result = await settled
  expect(result[1].status).toBe('rejected')
  expect(touched).toBe(false)
})

test('a late action cannot attach a replacement resource after clear', async () => {
  const queue = new BrowserSessionActionQueue()
  const held = deferred()
  const entered = deferred()
  let attached = false
  const old = queue.run('s', async () => {
    entered.resolve()
    await held.promise
    queue.assertAvailable('s')
    attached = true
  })
  await entered.promise
  queue.clear('s')
  held.resolve()
  await expect(old).rejects.toMatchObject({ code: 'CLOSED' })
  expect(attached).toBe(false)
})
