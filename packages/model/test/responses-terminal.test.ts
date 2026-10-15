import { expect, test } from 'bun:test'

import type { ModelTurnDelta, ModelTurnRequest } from '@velaros-ai/kernel'

import { createAiSdkModelDriver, createModelRuntimeComposition } from '../src/index.js'
import { ModelTuning } from '../src/utils/tuning.js'
import { createResponsesFetch } from '../src/utils/wire/responses-stream.js'

const request: ModelTurnRequest = {
  instructions: 'offline terminal fixture',
  materials: [],
  response: { type: 'text' },
  mode: 'work',
  outputTokens: 100,
}
const usage = {
  input_tokens: 19,
  output_tokens: 14,
  input_tokens_details: { cached_tokens: 3 },
  output_tokens_details: { reasoning_tokens: 12 },
}
const prefix = [
  { type: 'response.created', response: { id: 'resp_fixture', created_at: 1, model: 'fixture' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
  {
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted_fixture' },
  },
  {
    type: 'response.output_item.added',
    output_index: 1,
    item: { type: 'message', id: 'msg_1', phase: 'final_answer' },
  },
  { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'ok🙂' },
  {
    type: 'response.output_item.done',
    output_index: 1,
    item: { type: 'message', id: 'msg_1', phase: 'final_answer' },
  },
]
const terminal = {
  type: 'response.completed',
  response: { usage, reasoning: { context: 'all_turns' } },
}

/** 正式工厂与真实 SDK；供应商流停在终端后，不依靠网络 EOF 完成。 */
async function heldStream(
  chunks: unknown[],
  encode = (values: unknown[]) => [
    new TextEncoder().encode(values.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')),
  ],
  close = false
) {
  const original = globalThis.fetch
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let cancelled = 0
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value
          for (const part of encode(chunks)) value.enqueue(part)
          if (close) value.close()
        },
        cancel() {
          cancelled++
          return new Promise<void>(() => {})
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } }
    )) as typeof fetch
  const composition = createModelRuntimeComposition({
    environment: {},
    providerScripts: { configPaths: [] },
  })
  const factory = composition.agentModelRuntime.createAgentProvider({
    provider: 'openai',
    apiKey: 'offline',
    baseURL: 'https://offline.invalid/v1',
  })
  const driver = createAiSdkModelDriver({
    id: 'openai/fixture',
    model: factory('fixture'),
    limits: { contextTokens: 32000, inputTokens: 30000, outputTokens: 1000 },
  })
  const events: ModelTurnDelta[] = []
  const pending = (async () => {
    for await (const event of driver.stream(request, new AbortController().signal))
      events.push(event)
    return 'completed'
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const state = await Promise.race([
      pending,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('waiting-for-tail'), 1000)
      }),
    ])
    expect(state).toBe('completed')
    return { events, cancelled }
  } finally {
    if (timer) clearTimeout(timer)
    if (!cancelled && !close) controller?.close()
    await pending
    globalThis.fetch = original
  }
}

test('INV-20 built-in Responses finalizes SDK usage and continuation before an unrelated held-open tail', async () => {
  const { events, cancelled } = await heldStream([...prefix, terminal])
  expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
  expect(events.filter((e) => e.type === 'usage')).toEqual([
    {
      type: 'usage',
      inputTokens: 19,
      outputTokens: 14,
      cacheReadTokens: 3,
      cacheWriteTokens: undefined,
    },
  ])
  const continuation = events.find((e) => e.type === 'continuation')!
  expect(continuation.value.tokens).toBe(12)
  expect(JSON.parse(continuation.value.data).reasoningContext).toBe('all_turns')
  expect(continuation.value.data).toContain('encrypted_fixture')
  expect(continuation.value.data).toContain('final_answer')
  expect(
    events
      .filter((e) => e.type === 'text')
      .map((e) => e.text)
      .join('')
  ).toBe('ok🙂')
  expect(cancelled).toBe(1)
})

test('INV-20 fragmented UTF-8 and CRLF multiline terminal preserve the real SDK response', async () => {
  const { events } = await heldStream([...prefix, terminal], (chunks) => {
    const text = `\uFEFF: keepalive\r\n\r\n${chunks
      .map((chunk) => {
        const json = JSON.stringify(chunk)
        return `data: ${json.slice(0, 1)}\r\ndata: ${json.slice(1)}\r\n\r\n`
      })
      .join('')}`
    return Array.from(new TextEncoder().encode(text), (byte) => new Uint8Array([byte]))
  })
  expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
  expect(
    events
      .filter((e) => e.type === 'text')
      .map((e) => e.text)
      .join('')
  ).toBe('ok🙂')
  expect(events.find((e) => e.type === 'continuation')?.value.data).toContain('encrypted_fixture')
})

test('INV-20 failed and incomplete terminals retain measured usage and original SDK outcomes', async () => {
  for (const [type, reason] of [
    ['response.failed', 'invalid_api_key'],
    ['response.incomplete', 'max_output_tokens'],
    ['response.incomplete', 'content_filter'],
  ]) {
    const { events } = await heldStream([
      ...prefix,
      {
        type,
        sequence_number: 8,
        response: {
          usage,
          ...(type === 'response.failed'
            ? { error: { code: reason, message: 'fixture denied' } }
            : { incomplete_details: { reason } }),
        },
      },
    ])
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(1)
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      inputTokens: 19,
      outputTokens: 14,
    })
    expect(events.some((e) => e.type === 'continuation')).toBe(false)
    if (reason === 'max_output_tokens')
      expect(events.at(-1)).toEqual({ type: 'finish', reason: 'length' })
    else expect(events.at(-1)).toMatchObject({ type: 'error' })
  }
})

for (const fixture of [
  {
    name: 'missing sequence number',
    error: { code: 'server_error', message: 'opaque service failure' },
    message: 'opaque service failure',
    retryable: true,
  },
  {
    name: 'code without message',
    error: { code: 'stream_read_error' },
    message: 'stream_read_error',
    retryable: true,
  },
  {
    name: 'message without code',
    error: { message: 'overloaded_error' },
    message: 'overloaded_error',
    retryable: true,
  },
  {
    name: 'authentication with transient wording',
    error: { code: 'invalid_api_key', message: 'service unavailable' },
    message: 'service unavailable',
    retryable: false,
  },
  {
    name: 'permanent wording overrides transient code',
    error: { code: 'server_error', message: 'invalid api key: rejected' },
    message: 'invalid api key: rejected',
    retryable: false,
  },
  {
    name: 'unknown error',
    error: { code: 'unknown_provider_failure', message: 'opaque failure' },
    message: 'opaque failure',
    retryable: false,
  },
])
  test(`INV-19 raw failed terminal preserves ${fixture.name} through SDK schema fallback`, async () => {
    for (const measured of [false, true]) {
      const { events } = await heldStream([
        ...prefix,
        {
          type: 'response.failed',
          response: { error: fixture.error, ...(measured ? { usage } : {}) },
        },
      ])
      expect(events.at(-1)).toMatchObject({
        type: 'error',
        code: 'provider',
        message: fixture.message,
      })
      if (fixture.retryable)
        expect(events.at(-1)).toHaveProperty('retryAfterMs', expect.any(Number))
      else expect(events.at(-1)).not.toHaveProperty('retryAfterMs')
      expect(events.filter((event) => event.type === 'usage')).toHaveLength(measured ? 1 : 0)
      expect(
        events.some((event) => ['finish', 'continuation', 'output'].includes(event.type))
      ).toBe(false)
    }
  })

test('INV-19 invalid raw failure diagnostics never infer retry or stringify unrelated fields', async () => {
  for (const error of [
    null,
    { message: { code: 'server_error', privateRequest: 'fixture-secret' } },
    {
      code: 'server_error',
      message: `${'x'.repeat(ModelTuning.stream.failureMessageChars + 1)}invalid api key`,
    },
    { code: 'server_error'.repeat(100), privateRequest: 'fixture-secret' },
    { privateRequest: 'fixture-secret', retryable: true },
  ]) {
    const { events } = await heldStream([{ type: 'response.failed', response: { error } }])
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'provider' })
    expect(events.at(-1)).not.toHaveProperty('retryAfterMs')
    expect(JSON.stringify(events)).not.toContain('fixture-secret')
    expect(JSON.stringify(events).length).toBeLessThan(500)
    expect(events.some((event) => ['finish', 'continuation', 'usage'].includes(event.type))).toBe(
      false
    )
  }
})

test('INV-20 malformed terminal still fails SDK validation and invents no usage', async () => {
  const { events } = await heldStream([...prefix, { type: 'response.completed', response: null }])
  expect(events.at(-1)).toMatchObject({ type: 'error' })
  expect(events.some((e) => ['finish', 'continuation', 'usage'].includes(e.type))).toBe(false)
})

/** 只在内存中检查 wire 分帧，不运行任何供应商请求。 */
async function wireResponse(
  text: string,
  options: {
    url?: string
    type?: string
    signal?: AbortSignal
    hold?: boolean
    rejectCancel?: boolean
    stream?: boolean
  } = {}
) {
  let cancelled = 0
  const original = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        if (!options.hold) controller.close()
      },
      cancel() {
        cancelled++
        if (options.rejectCancel) return Promise.reject(new Error('fixture cleanup rejection'))
      },
    }),
    { headers: { 'content-type': options.type ?? 'text/event-stream' } }
  )
  const response = await createResponsesFetch(async () => original)(
    options.url ?? 'https://offline.invalid/v1/responses',
    {
      method: 'POST',
      body: JSON.stringify({ stream: options.stream ?? true }),
      signal: options.signal,
    }
  )
  return { response, original, cancelled: () => cancelled }
}

test('INV-20 only a real complete top-level terminal ends the wire and rejects no successful cleanup', async () => {
  const fake = `data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'x', delta: JSON.stringify(terminal) })}\n\n`
  const done = `data: ${JSON.stringify({ type: 'response.output_text.done', item_id: 'x', text: 'done' })}\n\n`
  const complete = `data: ${JSON.stringify(terminal)}\r\n\r\n`
  const { response, cancelled } = await wireResponse(
    `${fake + done + complete}data: {malformed trailing data}\n\n`,
    { hold: true, rejectCancel: true }
  )
  expect(await response.text()).toBe(fake + done + complete)
  expect(cancelled()).toBe(1)
})

test('INV-20 partial terminal and DONE alone do not become complete response terminals', async () => {
  for (const text of [
    `data: ${JSON.stringify(terminal)}\n`,
    'data: [DONE]\n\n',
    'event: response.completed\ndata: {}\n\n',
  ]) {
    const { response, cancelled } = await wireResponse(text)
    expect(await response.text()).toBe(text)
    expect(cancelled()).toBe(0)
  }
})

test('INV-20 an oversized event fails closed without publishing a clipped terminal', async () => {
  const { response } = await wireResponse(
    `data: ${'x'.repeat(
      ModelTuning.stream.responseEventBytes
    )}\n\ndata: ${JSON.stringify(terminal)}\n\n`
  )
  await expect(response.text()).rejects.toMatchObject({ code: 'LIMIT' })
})

test('INV-20 caller cancellation before terminal terminates the read and its owned transport', async () => {
  const abort = new AbortController()
  const { response, cancelled } = await wireResponse(
    'data: {"type":"response.output_text.delta"}\n\n',
    { hold: true, signal: abort.signal }
  )
  const reading = response.text()
  abort.abort(new Error('fixture caller abort'))
  await expect(reading).rejects.toThrow('fixture caller abort')
  expect(cancelled()).toBe(1)
})

test('INV-20 non-Responses paths and non-SSE responses retain original behavior', async () => {
  for (const options of [
    { url: 'https://offline.invalid/v1/chat/completions' },
    { type: 'application/json' },
    { url: 'https://offline.invalid/other?next=/responses' },
    { url: '/local/v1/responses', stream: false },
  ]) {
    const { response, original } = await wireResponse(
      `data: ${JSON.stringify(terminal)}\n\n`,
      options
    )
    expect(response).toBe(original)
  }
})

test('INV-20 CR-only complete terminals finish without a following byte or EOF', async () => {
  const { events, cancelled } = await heldStream([...prefix, terminal], (chunks) =>
    Array.from(
      new TextEncoder().encode(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\r`).join('')
      ),
      (byte) => new Uint8Array([byte])
    )
  )
  expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
  expect(events.find((e) => e.type === 'usage')).toMatchObject({
    inputTokens: 19,
    outputTokens: 14,
  })
  expect(events.find((e) => e.type === 'continuation')?.value.data).toContain('encrypted_fixture')
  expect(cancelled).toBe(1)
})

test('INV-20 complete events followed by a partial next event preserve raw data across pulls', async () => {
  const event = `data: ${JSON.stringify(prefix[0])}\n\n`
  const final = `data: ${JSON.stringify(terminal)}\r\n\r\n`
  let cancelled = 0
  const response = await createResponsesFetch(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(event + final.slice(0, 17)))
            controller.enqueue(new TextEncoder().encode(final.slice(17, -1)))
            controller.enqueue(
              new TextEncoder().encode(`${final.slice(-1)}unrelated trailing bytes`)
            )
          },
          cancel() {
            cancelled++
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
  )('https://offline.invalid/responses', { body: '{"stream":true}' })
  expect(await response.text()).toBe(event + final)
  expect(cancelled).toBe(1)
})

test('INV-20 abort while the upstream read is pending does not throw during reader disposal', async () => {
  const abort = new AbortController()
  let started: () => void = () => {}
  const pendingRead = new Promise<void>((resolve) => {
    started = resolve
  })
  let cancelled = 0
  const response = await createResponsesFetch(
    async () =>
      new Response(
        new ReadableStream({
          pull() {
            started()
            return new Promise<void>(() => {})
          },
          cancel() {
            cancelled++
            return Promise.reject(new Error('fixture cleanup failed'))
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
  )('https://offline.invalid/responses', { body: '{"stream":true}', signal: abort.signal })
  const reading = response.text()
  await pendingRead
  abort.abort(new Error('fixture pending read abort'))
  await expect(reading).rejects.toThrow('fixture pending read abort')
  expect(cancelled).toBe(1)
})

test('INV-20 half a terminal at EOF retains partial text and fails instead of executing a complete response', async () => {
  const { events, cancelled } = await heldStream(
    [...prefix, terminal],
    (chunks) => [
      new TextEncoder().encode(
        `${chunks
          .slice(0, -1)
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
          .join('')}data: ${JSON.stringify(terminal).slice(0, -4)}`
      ),
    ],
    true
  )
  expect(
    events
      .filter((e) => e.type === 'text')
      .map((e) => e.text)
      .join('')
  ).toBe('ok🙂')
  expect(events.at(-1)).toMatchObject({
    type: 'error',
    retryAfterMs: ModelTuning.retry.initialDelayMs,
  })
  expect(
    events.some((e) => e.type === 'usage' || e.type === 'continuation' || e.type === 'finish')
  ).toBe(false)
  expect(cancelled).toBe(0)
})

test('INV-20 absent terminal usage remains unknown and an earlier error is not hidden by incomplete', async () => {
  const failure = {
    type: 'response.failed',
    sequence_number: 8,
    response: { error: { code: 'server_error', message: 'fixture original failure' } },
  }
  const { events } = await heldStream([...prefix, failure])
  expect(events.at(-1)).toMatchObject({ type: 'error', message: 'fixture original failure' })
  expect(
    events.some((e) => e.type === 'usage' || e.type === 'continuation' || e.type === 'finish')
  ).toBe(false)
  const { events: errored } = await heldStream([
    ...prefix,
    {
      type: 'error',
      code: 'server_error',
      message: 'fixture event failure',
      param: null,
      sequence_number: 8,
    },
    {
      type: 'response.incomplete',
      response: { usage, incomplete_details: { reason: 'max_output_tokens' } },
    },
  ])
  expect(errored.at(-1)).toMatchObject({ type: 'error' })
  expect(errored.some((e) => e.type === 'continuation' || e.type === 'finish')).toBe(false)
})

test('INV-20 a BOM on a later data line cannot forge a terminal boundary', async () => {
  const first = ': comment\n\n'
  const forged = `\uFEFFdata: ${JSON.stringify(terminal)}\n\n`
  const actual = `data: ${JSON.stringify(terminal)}\n\n`
  const { response } = await wireResponse(`${first + forged + actual}tail`, { hold: true })
  expect(await response.text()).toBe(first + forged + actual)
})

test('INV-20 relative Responses URLs keep browser fetch compatibility', async () => {
  const final = `data: ${JSON.stringify(terminal)}\n\n`
  const { response, original, cancelled } = await wireResponse(`${final}tail`, {
    url: '/local/v1/responses',
    hold: true,
  })
  expect(response).not.toBe(original)
  expect(await response.text()).toBe(final)
  expect(cancelled()).toBe(1)
})
