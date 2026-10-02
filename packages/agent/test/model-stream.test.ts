import { expect, test } from 'bun:test'

import type { ModelDriver, ModelTurnDelta, ModelTurnRequest } from '@velaros-ai/kernel'

import { boundedModelStream } from '../src/utils/model-stream.js'

const request: ModelTurnRequest = {
  instructions: '',
  materials: [],
  response: { type: 'text' },
  mode: 'work',
  outputTokens: 100,
}

function simultaneous(controller: AbortController, delta: ModelTurnDelta): ModelDriver {
  return {
    id: 'fixture',
    limits: { contextTokens: 1000, inputTokens: 900, outputTokens: 100 },
    estimate: async () => ({ tokens: 1, precision: 'exact', basis: 'fixture' }),
    stream: () => ({
      [Symbol.asyncIterator]: () => ({
        next() {
          controller.abort(new DOMException('fixture cancel', 'AbortError'))
          return Promise.resolve({ done: false, value: delta })
        },
        return: async () => ({ done: true, value: undefined }),
      }),
    }),
  }
}

test('already received usage crosses cancellation once; text and finish do not', async () => {
  for (const delta of [
    { type: 'usage', inputTokens: 3, outputTokens: 2 },
    { type: 'text', text: 'must not accept' },
    { type: 'finish', reason: 'stop' },
  ] as const) {
    const controller = new AbortController()
    const events: ModelTurnDelta[] = []
    await expect(
      (async () => {
        for await (const event of boundedModelStream(
          simultaneous(controller, delta),
          request,
          controller.signal
        ))
          events.push(event)
      })()
    ).rejects.toThrow('fixture cancel')
    expect(events).toEqual(delta.type === 'usage' ? [delta] : [])
  }
})

test('a pending uncooperative driver cancels promptly and retains unknown usage', async () => {
  const controller = new AbortController()
  const driver = simultaneous(controller, { type: 'usage', inputTokens: 3, outputTokens: 2 })
  driver.stream = () => ({
    [Symbol.asyncIterator]: () => ({
      next() {
        queueMicrotask(() => controller.abort(new DOMException('pending cancel', 'AbortError')))
        return new Promise<IteratorResult<ModelTurnDelta>>(() => {})
      },
      return: () => new Promise<IteratorResult<ModelTurnDelta>>(() => {}),
    }),
  })
  const events: ModelTurnDelta[] = []
  await expect(
    (async () => {
      for await (const event of boundedModelStream(driver, request, controller.signal))
        events.push(event)
    })()
  ).rejects.toThrow('pending cancel')
  expect(events).toEqual([])
}, 1000)

test('cancellation never turns malformed usage into accounting evidence', async () => {
  const controller = new AbortController()
  await expect(
    boundedModelStream(
      simultaneous(controller, {
        type: 'usage',
        inputTokens: 3,
        outputTokens: 2,
        cacheReadTokens: 4,
      }),
      request,
      controller.signal
    )
      [Symbol.asyncIterator]()
      .next()
  ).rejects.toThrow('实际计数')
})

test('an iterator ending simultaneously with cancellation preserves the cancellation reason', async () => {
  const controller = new AbortController()
  const driver = simultaneous(controller, { type: 'finish', reason: 'stop' })
  driver.stream = () => ({
    [Symbol.asyncIterator]: () => ({
      next() {
        controller.abort(new DOMException('cancelled EOF', 'AbortError'))
        return Promise.resolve({ done: true, value: undefined })
      },
    }),
  })
  await expect(
    boundedModelStream(driver, request, controller.signal)[Symbol.asyncIterator]().next()
  ).rejects.toThrow('cancelled EOF')
})
