import { expect, test } from 'bun:test'

import { RetryPolicy } from '../src/agent/retry'

test('host retry decisions use one retry loop and may recover provider failures', async () => {
  const attempts: number[] = []
  let requests = 0
  const result = await new RetryPolicy().runWithConnectionRetry(async () => {
    requests++
    if (requests < 3) throw new Error('host-classified provider failure')
    return 'ok'
  }, {
    phase: 'stream', turn: 1, abortSignal: new AbortController().signal,
    policy: { onFailure: ({ attempt }) => { attempts.push(attempt); return { delayMs: 0 } } },
  })
  expect(result).toBe('ok')
  expect(attempts).toEqual([1, 2])
  expect(requests).toBe(3)
})

for (const guard of ['output', 'tool', 'abort'] as const) {
  test(`host retry policy cannot bypass ${guard} safety`, async () => {
    const controller = new AbortController()
    if (guard === 'abort') controller.abort()
    let decisions = 0
    await expect(new RetryPolicy().runWithConnectionRetry(async () => { throw new Error('network error') }, {
      phase: 'stream', turn: 1, abortSignal: controller.signal,
      hasVisibleOutput: () => guard === 'output', hasToolUse: () => guard === 'tool',
      policy: { onFailure: () => { decisions++; return { delayMs: 0 } } },
    })).rejects.toThrow('network error')
    expect(decisions).toBe(0)
  })
}
