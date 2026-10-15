import { createOpenAI } from '@ai-sdk/openai'
import { expect, test } from 'bun:test'

import type { ModelTurnDelta, ModelTurnRequest } from '@velaros-ai/kernel'

import { createAiSdkModelDriver, modelRequestDispatcher } from '../src/index.js'

const request: ModelTurnRequest = {
  instructions: 'dispatch boundary fixture',
  materials: [],
  response: { type: 'text' },
  mode: 'work',
  outputTokens: 100,
  budgetRequestId: 'host-only-request-identity',
}

function fixture() {
  const bodies: string[] = []
  const model = createOpenAI({
    apiKey: 'fixture-only',
    fetch: async (_url, options) => {
      bodies.push(String(options?.body))
      return new Response(
        [
          {
            type: 'response.created',
            response: { id: 'resp_fixture', created_at: 1, model: 'fixture' },
          },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', id: 'msg_1' },
          },
          { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Done.' },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: { type: 'message', id: 'msg_1' },
          },
          {
            type: 'response.completed',
            response: { usage: { input_tokens: 19, output_tokens: 7 } },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    },
  })('fixture')
  return {
    bodies,
    driver: createAiSdkModelDriver({
      id: 'openai/fixture',
      model,
      limits: { contextTokens: 32000, inputTokens: 30000, outputTokens: 1000 },
    }),
  }
}

test('SDK dispatch waits for host registration and host budget identity never enters the wire', async () => {
  const { driver, bodies } = fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let registrations = 0
  const events: ModelTurnDelta[] = []
  const running = (async () => {
    for await (const event of driver.stream(request, new AbortController().signal, async () => {
      registrations++
      entered.resolve()
      await release.promise
    }))
      events.push(event)
  })()
  await entered.promise
  expect(bodies).toHaveLength(0)
  release.resolve()
  await running
  expect(registrations).toBe(1)
  expect(bodies).toHaveLength(1)
  expect(bodies[0]).not.toContain('budgetRequestId')
  expect(bodies[0]).not.toContain(request.budgetRequestId!)
  expect(events).toContainEqual(expect.objectContaining({ type: 'usage', inputTokens: 19 }))
  expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
})

test('a rejected host dispatch registration preserves its error and sends no SDK request', async () => {
  const { driver, bodies } = fixture()
  const failure = Object.assign(new Error('fixture persistence failure'), { code: 'FIXTURE' })
  const iterator = driver
    .stream(request, new AbortController().signal, async () => {
      throw failure
    })
    [Symbol.asyncIterator]()
  await expect(iterator.next()).rejects.toBe(failure)
  expect(bodies).toHaveLength(0)
})

test('a dispatch-aware driver cannot bypass registration while a legacy driver stays conservative', async () => {
  for (const dispatchAware of [true, false]) {
    let registrations = 0
    const { driver } = fixture()
    const bypass = {
      ...driver,
      id: driver.id,
      limits: driver.limits,
      estimate: driver.estimate.bind(driver),
      dispatchAware,
      async *stream(): AsyncIterable<ModelTurnDelta> {
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const iterator = modelRequestDispatcher
      .stream(bypass, request, new AbortController().signal, async () => {
        registrations++
      })
      [Symbol.asyncIterator]()
    if (dispatchAware) await expect(iterator.next()).rejects.toMatchObject({ code: 'PROTOCOL' })
    else expect((await iterator.next()).value).toEqual({ type: 'finish', reason: 'stop' })
    expect(registrations).toBe(dispatchAware ? 0 : 1)
    await iterator.return?.()
  }
})
