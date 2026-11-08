import { expect, test } from 'bun:test'

import type { ComputerOperationContext } from '../contract/requires'
import { computerOperations } from '../impl/ComputerOperations'

test('cancelled screenshot response cannot deliver a late attachment', async () => {
  const abort = new AbortController()
  const attached: unknown[] = []
  const ctx = {
    abortSignal: abort.signal,
    attachImage: (image: unknown) => attached.push(image),
    computer: {
      ensureAvailable: async () => ({ available: true }),
      screenshot: async () => {
        abort.abort()
        return { base64: 'late-pixels', format: 'jpeg' }
      },
    },
  } as unknown as ComputerOperationContext
  await expect(computerOperations.screenshot(ctx)).rejects.toBeDefined()
  expect(attached).toEqual([])
})

test.each(['typeText', 'key'])(
  'cancelled availability check prevents %s dispatch',
  async (operation) => {
    const abort = new AbortController()
    let dispatched = false
    const ctx = {
      abortSignal: abort.signal,
      computer: {
        ensureAvailable: async () => {
          abort.abort()
          return { available: true }
        },
        typeText: async () => {
          dispatched = true
          return {}
        },
        key: async () => {
          dispatched = true
          return {}
        },
      },
    } as unknown as ComputerOperationContext
    await expect(
      operation === 'typeText'
        ? computerOperations.typeText({ text: 'example' }, ctx)
        : computerOperations.key({ keys: 'enter' }, ctx)
    ).rejects.toBeDefined()
    expect(dispatched).toBe(false)
  }
)
