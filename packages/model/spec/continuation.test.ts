import { createOpenAI } from '@ai-sdk/openai'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { expect, test } from 'bun:test'

import type { ModelTurnDelta, ModelTurnRequest } from '@velaros-ai/kernel'

import { createAiSdkModelDriver, createProviderRequestCompiler } from '../src/index.js'

const request: ModelTurnRequest = {
  instructions: 'fixture',
  materials: [],
  response: { type: 'text' },
  mode: 'work',
  outputTokens: 100,
}
const encrypted = 'synthetic-encrypted-state'.repeat(400)
const limits = { contextTokens: 32_000, inputTokens: 30_000, outputTokens: 1_000 }

test('INV-18 real Responses stream preserves encrypted reasoning with an empty summary and reports its effective context', async () => {
  const bodies: any[] = []
  const api = createOpenAI({
    apiKey: 'fixture',
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      const id = String(bodies.length)
      const chunks = [
        {
          type: 'response.created',
          response: { id: `resp_${id}`, created_at: 1, model: 'gpt-6-sol' },
        },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'reasoning', id: `rs_${id}` },
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'reasoning', id: `rs_${id}`, encrypted_content: `encrypted_${id}` },
        },
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: { type: 'message', id: `msg_${id}`, phase: 'final_answer' },
        },
        { type: 'response.output_text.delta', item_id: `msg_${id}`, delta: 'ok' },
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: { type: 'message', id: `msg_${id}`, phase: 'final_answer' },
        },
        {
          type: 'response.completed',
          response: {
            reasoning: { context: 'all_turns' },
            usage: {
              input_tokens: 10,
              output_tokens: 14,
              output_tokens_details: { reasoning_tokens: 12 },
            },
          },
        },
      ]
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }
      )
    },
  })
  const driver = createAiSdkModelDriver({ id: 'openai/gpt-6-sol', model: api('gpt-6-sol'), limits })
  const events = await collect(driver)
  const state = events.find((event) => event.type === 'continuation')!.value
  expect(events.some((event) => event.type === 'reasoning')).toBe(false)
  expect(state.tokens).toBe(12)
  expect(JSON.parse(state.data).reasoningContext).toBe('all_turns')
  await collect(createAiSdkModelDriver({ id: driver.id, model: api('gpt-6-sol'), limits }), {
    ...request,
    history: [{ role: 'assistant', content: 'ok', continuation: state }],
  })
  const replayed = bodies[1].input.find((item: any) => item.type === 'reasoning')
  expect(replayed).toEqual({
    type: 'reasoning',
    id: 'rs_1',
    summary: [],
    encrypted_content: 'encrypted_1',
  })
  expect(bodies[1].input.find((item: any) => item.role === 'assistant').phase).toBe('final_answer')
  expect(bodies.every((body) => body.store === false)).toBe(true)
})

function provider(seen: any[], finish = 'stop') {
  return new MockLanguageModelV3({
    provider: 'openai.responses',
    modelId: 'gpt-6-sol',
    doStream: async (options) => {
      seen.push(options)
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'reasoning-start', id: 'r' },
            { type: 'reasoning-delta', id: 'r', delta: 'public summary' },
            {
              type: 'reasoning-end',
              id: 'r',
              providerMetadata: {
                openai: { itemId: 'rs_fixture', reasoningEncryptedContent: encrypted },
              },
            },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'first' },
            {
              type: 'text-end',
              id: 't1',
              providerMetadata: { openai: { itemId: 'msg_1', phase: 'commentary' } },
            },
            { type: 'text-start', id: 't2' },
            { type: 'text-delta', id: 't2', delta: 'second' },
            {
              type: 'text-end',
              id: 't2',
              providerMetadata: { openai: { itemId: 'msg_2', phase: 'final_answer' } },
            },
            {
              type: 'finish',
              finishReason: { unified: finish, raw: finish },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 50, text: 10, reasoning: 40 },
              },
            },
          ] as any,
        }),
      }
    },
  })
}
async function collect(driver: ReturnType<typeof createAiSdkModelDriver>, input = request) {
  const events: ModelTurnDelta[] = []
  for await (const event of driver.stream(input, new AbortController().signal)) events.push(event)
  expect(events.some((event) => event.type === 'error')).toBe(false)
  return events
}

test('INV-18 accepted Responses output retains opaque reasoning and message phases across a recreated driver', async () => {
  const seen: any[] = []
  const driver = createAiSdkModelDriver({ id: 'openai/gpt-6-sol', model: provider(seen), limits })
  const events = await collect(driver)
  const state = events.find((event) => event.type === 'continuation')?.value
  expect(state).toBeDefined()
  expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
  const text = events
    .filter((event) => event.type === 'text')
    .map((event) => event.text)
    .join('')
  expect(text).toBe('first\nsecond')
  const input = {
    ...request,
    history: [
      { role: 'assistant' as const, content: text, continuation: state, cacheBreakpoint: true },
    ],
  }
  const restored = createAiSdkModelDriver({ id: driver.id, model: provider(seen), limits })
  await collect(restored, input)
  const history = seen[1].prompt.find((message: any) => message.role === 'assistant')
  expect(history.content.map((part: any) => part.type)).toEqual(['reasoning', 'text', 'text'])
  expect(history.content[0].providerOptions.openai.reasoningEncryptedContent).toBe(encrypted)
  expect(history.content[1].providerOptions.openai.phase).toBe('commentary')
  expect(history.content[2].providerOptions.openai.phase).toBe('final_answer')
  expect(seen[1].providerOptions.openai.store).toBe(false)
  expect(history.providerOptions.velaros.promptCacheBreakpoint).toBe(true)
  expect(JSON.stringify(seen[1].prompt.at(-1))).not.toContain(encrypted)
  const estimate = await restored.estimate(input)
  expect(estimate.opaqueTokens).toBe(40)
  expect(estimate.tokens).toBeLessThan(encrypted.length / 2)
  const compiled = await createProviderRequestCompiler().compileModelTurn(input, restored, 0, {
    textRatio: 0.1,
  })
  expect(compiled.measured.opaque).toBe(40)
  expect(compiled.estimate.tokens).toBe(Math.ceil(compiled.measured.text * 0.1) + 40)

  const switched = createAiSdkModelDriver({ id: 'another/model', model: provider(seen), limits })
  await collect(switched, input)
  expect(JSON.stringify(seen.at(-1).prompt)).not.toContain(encrypted)
  expect((await switched.estimate(input)).opaqueTokens ?? 0).toBe(0)
  await collect(restored, {
    ...input,
    history: [{ ...input.history[0], content: 'edited history' }],
  })
  expect(JSON.stringify(seen.at(-1).prompt)).not.toContain(encrypted)
  const partial = createAiSdkModelDriver({ id: driver.id, model: provider([], 'length'), limits })
  expect((await collect(partial)).some((event) => event.type === 'continuation')).toBe(false)

  // 真正的 Responses SDK 编码；fetch 是本地夹具，不能发送网络或丢失 phase / 密文。
  const bodies: any[] = []
  const openai = createOpenAI({
    apiKey: 'fixture',
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json(
        { error: { message: 'fixture stop after wire capture' } },
        { status: 400 }
      )
    },
  })
  const wire = createAiSdkModelDriver({ id: driver.id, model: openai('gpt-6-sol'), limits })
  for await (const _ of wire.stream(input, new AbortController().signal)) {
    /* inspect request only */
  }
  expect(bodies).toHaveLength(1)
  expect(bodies[0].store).toBe(false)
  const reasoning = bodies[0].input.find((item: any) => item.type === 'reasoning')
  expect(reasoning.encrypted_content).toBe(encrypted)
  expect(
    bodies[0].input.filter((item: any) => item.role === 'assistant').map((item: any) => item.phase)
  ).toEqual(['commentary', 'final_answer'])
  expect(bodies[0].input.some((item: any) => item.type === 'item_reference')).toBe(false)
})
