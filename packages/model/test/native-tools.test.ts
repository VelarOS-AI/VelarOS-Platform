import { createOpenAI } from '@ai-sdk/openai'
import { expect, test } from 'bun:test'

import type { ModelHistoryMessage, ModelTurnDelta, ModelTurnRequest } from '@velaros-ai/kernel'
import { modelRequestEncoder } from '@velaros-ai/kernel'

import { createAiSdkModelDriver, createProviderRequestCompiler } from '../src/index.js'
import { restoreResponseContinuations } from '../src/utils/wire/continuation.js'

const call = { id: 'call_fixture', name: 'node', input: { code: 'console.log(7)' } }
const request: ModelTurnRequest = {
  instructions: 'Execute the task.',
  materials: [],
  mode: 'work',
  outputTokens: 1000,
  response: {
    type: 'tools',
    tools: [
      {
        name: 'node',
        description: 'Execute JavaScript.',
        schema: {
          type: 'object',
          properties: { code: { type: 'string' } },
          required: ['code'],
          additionalProperties: false,
        },
      },
    ],
  },
}
const chunks = [
  { type: 'response.created', response: { id: 'resp_fixture', created_at: 1, model: 'fixture' } },
  {
    type: 'response.output_item.added',
    output_index: 0,
    item: {
      type: 'function_call',
      id: 'fc_fixture',
      call_id: call.id,
      name: call.name,
      arguments: '',
    },
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_fixture',
    output_index: 0,
    delta: JSON.stringify(call.input),
  },
  {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      type: 'function_call',
      id: 'fc_fixture',
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.input),
      status: 'completed',
    },
  },
  { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 20 } } },
]
const stream = (parts: unknown[]) =>
  new Response(parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
const collect = async (
  driver: ReturnType<typeof createAiSdkModelDriver>,
  input: ModelTurnRequest
) => {
  const events: ModelTurnDelta[] = []
  for await (const event of driver.stream(input, new AbortController().signal)) events.push(event)
  return events
}

test('INV-21 Responses declares native tools, preserves call identity and replays a matched result with continuation', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const model = createOpenAI({
    apiKey: 'fixture',
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return stream(chunks)
    },
  })('fixture')
  const driver = createAiSdkModelDriver({
    id: 'fixture',
    model,
    limits: { contextTokens: 128000, inputTokens: 120000, outputTokens: 1000 },
  })
  const events = await collect(driver, request)
  expect(events.filter((event) => event.type === 'error')).toEqual([])
  expect(events.filter((event) => event.type === 'tool-call')).toEqual([
    { type: 'tool-call', value: call },
  ])
  expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
  expect(bodies[0]?.tools).toMatchObject([{ type: 'function', name: 'node' }])
  const continuation = events.find((event) => event.type === 'continuation')
  expect(continuation?.type).toBe('continuation')
  const exchange = modelRequestEncoder.toolExchange({
    text: '',
    calls: [call],
    results: [{ id: call.id, name: call.name, output: { status: 'recorded', resultRef: 'r1' } }],
  })
  const next: ModelTurnRequest = {
    ...request,
    history: [
      {
        role: 'assistant',
        content: JSON.stringify({ text: '', calls: [call] }),
        toolExchange: exchange,
        continuation: continuation?.type === 'continuation' ? continuation.value : undefined,
      },
      {
        role: 'user',
        content: 'OBSERVED_RESULT_7',
        toolResult: { callId: call.id, toolName: call.name },
        cacheBreakpoint: true,
      },
    ],
  }
  expect((await collect(driver, next)).some((event) => event.type === 'error')).toBe(false)
  expect(bodies[1]?.input).toMatchObject([
    { role: 'system' },
    { type: 'function_call', call_id: call.id, name: call.name },
    { type: 'function_call_output', call_id: call.id, output: 'OBSERVED_RESULT_7' },
    { role: 'user' },
  ])
  expect(JSON.stringify(bodies[1]).match(/OBSERVED_RESULT_7/gu)).toHaveLength(1)
  const estimate = await driver.estimate(next)
  const { unit, total, ...parts } = estimate.composition!
  expect(unit).toBe('utf8-bytes')
  expect(Object.values(parts).reduce((a, b) => a + b, 0)).toBe(total)
  const compiler = createProviderRequestCompiler()
  const compiled = await compiler.compileModelTurn(next, driver, 100)
  expect(compiled.providerRequest.tools.length).toBe(1)
  await expect(compiler.verify({ ...compiled.providerRequest, tools: [] })).rejects.toThrow()
})

test('INV-21 missing, repeated and mismatched tool results cannot become model history', () => {
  for (const results of [
    [],
    [{ id: 'wrong', name: 'node', output: null }],
    [{ id: call.id, name: 'shell', output: null }],
  ])
    expect(() => modelRequestEncoder.toolExchange({ text: '', calls: [call], results })).toThrow()
  expect(() =>
    modelRequestEncoder.toolExchange({
      text: '',
      calls: [call, call],
      results: [
        { ...call, output: null },
        { ...call, output: null },
      ],
    })
  ).toThrow()
})

for (const partial of [false, true])
  test(`native result presentation pairs batches and reused ids without duplicating bodies (partial=${partial})`, async () => {
    const calls = [call, { ...call, id: 'second-call', input: { code: 'console.log(8)' } }]
    const assistant = (batch: typeof calls): ModelHistoryMessage => ({
      role: 'assistant',
      content: JSON.stringify({ text: '', calls: batch }),
      toolExchange: {
        text: '',
        calls: batch,
        results: batch.map((item) => ({ ...item, output: { recorded: item.id } })),
      },
    })
    const body = (id: string, content: string): ModelHistoryMessage => ({
      role: 'user',
      content,
      toolResult: { callId: id, toolName: 'node' },
      cacheBreakpoint: true,
    })
    const history: ModelHistoryMessage[] = [
      assistant(calls),
      ...(partial ? [] : [body('second-call', 'SECOND_OUTPUT')]),
      body(call.id, 'FIRST_OUTPUT'),
      { role: 'user', content: 'UNBOUND_LOG' },
      assistant([call]),
      body(call.id, 'LATER_OUTPUT'),
    ]
    const original = structuredClone(history)
    const bodies: Array<{ input: Array<{ type?: string; call_id?: string; output?: string }> }> = []
    const model = createOpenAI({
      apiKey: 'fixture',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return stream(chunks)
      },
    })('fixture')
    const restored = restoreResponseContinuations(
      modelRequestEncoder.messages({ ...request, history }),
      model,
      'fixture'
    )
    expect(
      restored.messages
        .filter((message) => message.role === 'tool')
        .map((message) => message.providerOptions?.velaros?.promptCacheBreakpoint)
    ).toEqual([true, true])
    const driver = createAiSdkModelDriver({
      id: 'fixture',
      model,
      limits: { contextTokens: 128000, inputTokens: 120000, outputTokens: 1000 },
    })
    expect((await collect(driver, { ...request, history })).at(-1)).toEqual({
      type: 'finish',
      reason: 'stop',
    })
    expect(bodies[0]!.input.filter((item) => item.type === 'function_call_output')).toEqual([
      { type: 'function_call_output', call_id: call.id, output: 'FIRST_OUTPUT' },
      {
        type: 'function_call_output',
        call_id: 'second-call',
        output: partial ? JSON.stringify({ recorded: 'second-call' }) : 'SECOND_OUTPUT',
      },
      { type: 'function_call_output', call_id: call.id, output: 'LATER_OUTPUT' },
    ])
    for (const text of ['FIRST_OUTPUT', 'LATER_OUTPUT', 'UNBOUND_LOG'])
      expect(JSON.stringify(bodies[0]).match(new RegExp(text, 'gu'))).toHaveLength(1)
    expect(JSON.stringify(bodies[0])).not.toContain('toolResult')
    expect(history).toEqual(original)
  })

test('INV-21 Chat Completions replays native calls and results without Responses continuation', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const parts = [
    {
      delta: {
        role: 'assistant',
        tool_calls: [
          { index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: '' } },
        ],
      },
      finish_reason: null,
    },
    {
      delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(call.input) } }] },
      finish_reason: null,
    },
    { delta: {}, finish_reason: 'tool_calls' },
  ].map((choice) => ({
    id: 'chat_fixture',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fixture',
    choices: [{ index: 0, ...choice }],
  }))
  const driver = createAiSdkModelDriver({
    id: 'fixture',
    model: createOpenAI({
      apiKey: 'fixture',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return stream(parts)
      },
    }).chat('fixture'),
    limits: { contextTokens: 128000, inputTokens: 120000, outputTokens: 1000 },
  })
  const events = await collect(driver, request)
  expect(events.filter((event) => event.type === 'tool-call')).toEqual([
    { type: 'tool-call', value: call },
  ])
  expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
  expect(events.some((event) => event.type === 'continuation')).toBe(false)
  const next = {
    ...request,
    history: [
      {
        role: 'assistant' as const,
        content: JSON.stringify({ text: '', calls: [call] }),
        toolExchange: modelRequestEncoder.toolExchange({
          text: '',
          calls: [call],
          results: [
            { id: call.id, name: call.name, output: { status: 'recorded', resultRef: 'r1' } },
          ],
        }),
      },
      {
        role: 'user' as const,
        content: 'OBSERVED_RESULT_7',
        toolResult: { callId: call.id, toolName: call.name },
      },
    ],
  }
  expect((await collect(driver, next)).at(-1)).toEqual({ type: 'finish', reason: 'stop' })
  expect(bodies[1]?.messages).toMatchObject([
    { role: 'system' },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        },
      ],
    },
    { role: 'tool', tool_call_id: call.id, content: 'OBSERVED_RESULT_7' },
    { role: 'user' },
  ])
  expect(JSON.stringify(bodies[1]).match(/OBSERVED_RESULT_7/gu)).toHaveLength(1)
})

test('INV-21 a truncated native response is never reported as a successful turn', async () => {
  const driver = createAiSdkModelDriver({
    id: 'fixture',
    model: createOpenAI({ apiKey: 'fixture', fetch: async () => stream(chunks.slice(0, -1)) })(
      'fixture'
    ),
    limits: { contextTokens: 128000, inputTokens: 120000, outputTokens: 1000 },
  })
  const events = await collect(driver, request)
  expect(events.some((event) => event.type === 'finish' && event.reason === 'stop')).toBe(false)
  expect(events.some((event) => event.type === 'error')).toBe(true)
})

test('INV-21 a response containing a tool followed by text preserves the saved continuation', async () => {
  const text = '执行已提交。'
  const message = {
    type: 'message',
    id: 'msg_after_call',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  const parts = [
    ...chunks.slice(0, -1),
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { ...message, status: 'in_progress', content: [] },
    },
    {
      type: 'response.content_part.added',
      item_id: message.id,
      output_index: 1,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: message.id,
      output_index: 1,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.output_text.done',
      item_id: message.id,
      output_index: 1,
      content_index: 0,
      text,
    },
    { type: 'response.output_item.done', output_index: 1, item: message },
    chunks.at(-1),
  ]
  const driver = createAiSdkModelDriver({
    id: 'fixture',
    model: createOpenAI({ apiKey: 'fixture', fetch: async () => stream(parts) })('fixture'),
    limits: { contextTokens: 128000, inputTokens: 120000, outputTokens: 1000 },
  })
  const events = await collect(driver, request)
  expect(events.filter((event) => event.type === 'text')).toEqual([{ type: 'text', text }])
  expect(events.some((event) => event.type === 'continuation')).toBe(true)
  expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
})
