import { expect, test } from 'bun:test'

import type { ComputerOperationContext } from '../contract/requires'
import { computerOperations } from '../impl/ComputerOperations'

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
