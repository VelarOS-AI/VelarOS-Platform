import { createOpenAI } from '@ai-sdk/openai'
import { expect, test } from 'bun:test'

import type { ModelTurnDelta, ModelTurnRequest } from '@velaros-ai/kernel'

import { createAiSdkModelDriver } from '../src/index.js'
import { planProviderRetry, providerErrorMessage } from '../src/utils/retry.js'

const request: ModelTurnRequest = {
  instructions: 'stream fixture',
  materials: [],
  response: { type: 'text' },
  mode: 'work',
  outputTokens: 100,
}
const partial = 'A complete-looking program is not permission to execute.'
const prefix = [
  { type: 'response.created', response: { id: 'resp_fixture', created_at: 1, model: 'fixture' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
  { type: 'response.output_text.delta', item_id: 'msg_1', delta: partial },
]
const usage = { input_tokens: 19, output_tokens: 7, input_tokens_details: { cached_tokens: 3 } }
const networkError = () =>
  new TypeError('terminated', {
    cause: Object.assign(Error('socket reset'), { code: 'ECONNRESET' }),
  })

async function collect(chunks: unknown[], tail = '', disconnect = false) {
  const encoded = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
  if (tail) encoded.push(tail)
  let index = 0
  const model = createOpenAI({
    apiKey: 'fixture-only',
    fetch: async () =>
      new Response(
        new ReadableStream({
          async pull(controller) {
            if (index < encoded.length)
              controller.enqueue(new TextEncoder().encode(encoded[index++]!))
            else if (disconnect) {
              await new Promise((resolve) => setTimeout(resolve, 10))
              controller.error(networkError())
            } else controller.close()
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      ),
  })('fixture')
  const driver = createAiSdkModelDriver({
    id: 'openai/fixture',
    model,
    limits: { contextTokens: 32000, inputTokens: 30000, outputTokens: 1000 },
  })
  const events: ModelTurnDelta[] = []
  for await (const event of driver.stream(request, new AbortController().signal)) events.push(event)
  return events
}

for (const [name, tail] of [
  ['clean EOF', ''],
  ['non-SSE JSON tail', '{"error":{"message":"upstream disconnected"}}'],
  ['DONE without a response terminal', 'data: [DONE]\n\n'],
])
  test(`INV-19 Responses ${name} rejects partial output as retryable and keeps missing usage unknown`, async () => {
    const events = await collect(prefix, tail)
    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', text: partial },
    ])
    expect(
      events.filter((event) => ['finish', 'continuation', 'usage'].includes(event.type))
    ).toEqual([])
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      code: 'provider',
      retryAfterMs: expect.any(Number),
    })
    expect((events.at(-1) as { message: string }).message).toContain('终端')
  })

test('INV-19 genuine socket failure retains transient classification and the received prefix', async () => {
  const events = await collect(prefix, '', true)
  expect(events.filter((event) => event.type === 'text')).toEqual([{ type: 'text', text: partial }])
  expect(
    events.filter((event) => ['finish', 'continuation', 'usage'].includes(event.type))
  ).toEqual([])
  expect(events.at(-1)).toMatchObject({
    type: 'error',
    message: 'terminated',
    retryAfterMs: expect.any(Number),
  })
})

test('INV-19 a failed terminal retains its measured usage and exact provider message without retrying authentication', async () => {
  const events = await collect([
    ...prefix,
    {
      type: 'response.failed',
      sequence_number: 4,
      response: {
        error: { code: 'invalid_api_key', message: 'invalid api key: fixture rejected' },
        usage,
      },
    },
  ])
  expect(events.filter((event) => event.type === 'usage')).toEqual([
    expect.objectContaining({
      type: 'usage',
      inputTokens: 19,
      outputTokens: 7,
      cacheReadTokens: 3,
    }),
  ])
  expect(events.at(-1)).toMatchObject({
    type: 'error',
    message: 'invalid api key: fixture rejected',
  })
  expect(events.at(-1)).not.toHaveProperty('retryAfterMs')
  expect(events.some((event) => ['finish', 'continuation'].includes(event.type))).toBe(false)
})

test('INV-19 failed Responses terminals preserve code-based retry decisions, usage and unaccepted output', async () => {
  for (const [code, message, retryable] of [
    ['stream_read_error', 'stream_read_error', true],
    ['server_error', 'opaque temporary failure', true],
    ['unknown_provider_code', 'stream_read_error', true],
    ['invalid_api_key', 'opaque provider failure', false],
    ['invalid_request_error', 'stream_read_error', false],
    ['insufficient_quota', 'stream_read_error', false],
    ['unknown_provider_code', 'opaque provider failure', false],
  ] as const) {
    const events = await collect([
      ...prefix,
      {
        type: 'response.failed',
        sequence_number: 4,
        response: { error: { code, message }, usage },
      },
    ])
    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', text: partial },
    ])
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'provider', message })
    if (retryable) expect(events.at(-1)).toHaveProperty('retryAfterMs', expect.any(Number))
    else expect(events.at(-1)).not.toHaveProperty('retryAfterMs')
    expect(events.some((event) => ['finish', 'continuation'].includes(event.type))).toBe(false)
  }
})

test('INV-19 usage from a received completed terminal survives a later socket reset without accepting or regenerating the response', async () => {
  const events = await collect(
    [...prefix, { type: 'response.completed', response: { usage } }],
    '',
    true
  )
  expect(events.filter((event) => event.type === 'usage')).toEqual([
    expect.objectContaining({
      type: 'usage',
      inputTokens: 19,
      outputTokens: 7,
      cacheReadTokens: 3,
    }),
  ])
  expect(events.at(-1)).toMatchObject({
    type: 'error',
    message: 'terminated',
  })
  expect(events.at(-1)).not.toHaveProperty('retryAfterMs')
  expect(events.some((event) => ['finish', 'continuation'].includes(event.type))).toBe(false)
})

test('provider error diagnostics never stringify an unknown object', () => {
  const failure = {
    retryable: true,
    toString() {
      throw Error('must not serialize a request-bearing object')
    },
  }
  expect(providerErrorMessage(failure)).toBe('供应商请求失败')
  expect(planProviderRetry(failure, { retryIndex: 1 })).toMatchObject({
    kind: 'provider',
    message: '供应商请求失败',
  })
  expect(providerErrorMessage({ response: { error: { message: 'fixture reason' } } })).toBe(
    'fixture reason'
  )
})

test('INV-19 a completed response succeeds once while explicit incomplete reasons remain distinct from missing terminal', async () => {
  for (const [type, reason, finish] of [
    ['response.completed', undefined, 'stop'],
    ['response.incomplete', 'max_output_tokens', 'length'],
    ['response.incomplete', 'content_filter', undefined],
    ['response.incomplete', 'unsupported_fixture_reason', undefined],
  ] as const) {
    const events = await collect([
      ...prefix,
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'message', id: 'msg_1' },
      },
      { type, response: { usage, incomplete_details: reason ? { reason } : null } },
    ])
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(1)
    if (finish) expect(events.at(-1)).toEqual({ type: 'finish', reason: finish })
    else {
      expect(events.at(-1)).toMatchObject({ type: 'error' })
      expect(events.at(-1)).not.toHaveProperty('retryAfterMs')
    }
  }
})

test('INV-19 empty Responses EOF is a missing terminal, while malformed SSE remains a protocol failure', async () => {
  const empty = await collect([])
  expect(empty).toEqual([
    expect.objectContaining({ type: 'error', retryAfterMs: expect.any(Number) }),
  ])
  const malformed = await collect(prefix, 'data: {malformed fixture}\n\n')
  expect(malformed.at(-1)).toMatchObject({ type: 'error' })
  expect(malformed.at(-1)).not.toHaveProperty('retryAfterMs')
  expect(malformed.some((event) => ['finish', 'continuation', 'usage'].includes(event.type))).toBe(
    false
  )
})

test('INV-19 cancellation after a raw terminal preserves its usage once and accepts no response', async () => {
  const controller = new AbortController()
  const model = createOpenAI({
    apiKey: 'fixture-only',
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(
              new TextEncoder().encode(
                [...prefix, { type: 'response.completed', response: { usage } }]
                  .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
                  .join('')
              )
            )
          },
          cancel() {
            return new Promise<void>(() => {})
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      ),
  })('fixture')
  const driver = createAiSdkModelDriver({
    id: 'openai/fixture',
    model,
    limits: { contextTokens: 32000, inputTokens: 30000, outputTokens: 1000 },
  })
  const events: ModelTurnDelta[] = []
  await expect(
    (async () => {
      for await (const event of driver.stream(request, controller.signal)) {
        events.push(event)
        if (event.type === 'usage')
          controller.abort(new DOMException('fixture cancel', 'AbortError'))
      }
    })()
  ).rejects.toThrow('fixture cancel')
  expect(events.filter((event) => event.type === 'usage')).toEqual([
    { type: 'usage', inputTokens: 19, outputTokens: 7, cacheReadTokens: 3 },
  ])
  expect(events.some((event) => ['finish', 'continuation', 'error'].includes(event.type))).toBe(
    false
  )
}, 1000)

test('INV-19 cancellation does not await an uncooperative stream and missing terminal usage stays unknown', async () => {
  const controller = new AbortController()
  let opened: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    opened = resolve
  })
  const model = createOpenAI({
    apiKey: 'fixture-only',
    fetch: async () => {
      opened()
      return new Response(
        new ReadableStream({
          cancel() {
            return new Promise<void>(() => {})
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    },
  })('fixture')
  const driver = createAiSdkModelDriver({
    id: 'openai/fixture',
    model,
    limits: { contextTokens: 32000, inputTokens: 30000, outputTokens: 1000 },
  })
  const events: ModelTurnDelta[] = []
  const pending = (async () => {
    for await (const event of driver.stream(request, controller.signal)) events.push(event)
  })()
  await ready
  controller.abort(new DOMException('fixture pending cancel', 'AbortError'))
  await expect(pending).rejects.toThrow('fixture pending cancel')
  expect(events).toEqual([])
}, 1000)
