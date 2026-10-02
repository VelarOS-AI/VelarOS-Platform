import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { expect, test } from 'bun:test'

import type { ModelInputEstimate, ModelTurnRequest } from '@velaros-ai/kernel'

import {
  createAiSdkModelDriver,
  createModelRuntimeComposition,
  createProviderRequestCompiler,
} from '../src/index.js'
import { estimateRequestInput } from '../src/utils/request-estimate.js'
import { ModelTuning } from '../src/utils/tuning.js'
import {
  applyPromptCacheCallOptions,
  markPromptCacheBreakpoints,
  withPromptCacheKey,
} from '../src/utils/wire/prompt-cache.js'

const png = 'A'.repeat(400_000)

/** 只给出固定估算的驱动，用来检查编译器的准入。 */
function estimate(value: Partial<ModelInputEstimate> & { tokens: number }, inputTokens: number) {
  return {
    id: 'estimate',
    limits: { contextTokens: inputTokens + 1_000, inputTokens, outputTokens: 1_000 },
    estimate: async (): Promise<ModelInputEstimate> => ({
      precision: 'estimate',
      basis: 'test',
      ...value,
    }),
    stream() {
      throw Error('must not send')
    },
  }
}

const base: ModelTurnRequest = {
  instructions: 'Static runtime instructions.',
  materials: [{ ref: 'view-1', origin: 'runtime-view', text: 'current view', totalChars: 12 }],
  response: { type: 'text' },
  mode: 'work',
  outputTokens: 100,
}

test('images count a fixed amount each instead of their base64 bytes', () => {
  const plain = estimateRequestInput(base)
  const withImage = estimateRequestInput({
    ...base,
    images: [{ type: 'image-data', mediaType: 'image/png', data: png, label: 'screen' }],
  })
  expect(plain.images).toEqual({ count: 0, tokens: 0 })
  expect(withImage.images).toEqual({ count: 1, tokens: ModelTuning.estimate.imageTokens })
  expect(withImage.tokens).toBeLessThan(plain.tokens + ModelTuning.estimate.imageTokens + 1000)
  expect(withImage.tokens).toBeLessThan(png.length / 10)
})

test('calibration shrinks only the text part and admits by the calibrated estimate', async () => {
  const compiler = createProviderRequestCompiler()
  const driver = estimate({ tokens: 12_000, images: { count: 1, tokens: 2_000 } }, 6_000)
  const raw = await compiler.compileModelTurn(base, driver, 0)
  expect(raw.okToSend).toBe(false)
  expect(raw.measured).toEqual({ text: 10_000, images: 2_000 })
  const calibrated = await compiler.compileModelTurn(base, driver, 0, { textRatio: 0.3 })
  expect(calibrated.estimate.tokens).toBe(5_000)
  expect(calibrated.measured).toEqual({ text: 10_000, images: 2_000 })
  expect(calibrated.okToSend).toBe(true)
  expect(calibrated.estimate.basis).toContain('校准')

  const exact = estimate({ tokens: 9_000, precision: 'exact' }, 6_000)
  expect(
    (await compiler.compileModelTurn(base, exact, 0, { textRatio: 0.3 })).estimate.tokens
  ).toBe(9_000)
  for (const textRatio of [0, 1.5, Number.NaN])
    await expect(compiler.compileModelTurn(base, driver, 0, { textRatio })).rejects.toThrow(
      '校准比'
    )
})

test('neutral breakpoints and cache keys become provider wire fields on the way out; the key only on lines that accept it', () => {
  const messages = markPromptCacheBreakpoints([
    { role: 'user', content: 'segment base', cacheBreakpoint: true },
    { role: 'assistant', content: 'script' },
  ])
  expect(messages[0]).toEqual({
    role: 'user',
    content: 'segment base',
    providerOptions: { velaros: { promptCacheBreakpoint: true } },
  })
  expect(messages[1]).toEqual({ role: 'assistant', content: 'script' })
  const providerOptions = withPromptCacheKey({ openai: { strictJsonSchema: false } }, 'session-1')
  expect(withPromptCacheKey(undefined, undefined)).toBeUndefined()
  const call = {
    prompt: messages.map((message) => ({
      role: message.role,
      content: [{ type: 'text', text: String(message.content) }],
      providerOptions: message.providerOptions,
    })),
    providerOptions,
  } as never
  const wire = applyPromptCacheCallOptions(call, { sessionKey: true })
  expect(wire.providerOptions).toEqual({
    openai: { strictJsonSchema: false, promptCacheKey: 'session-1' },
  })
  expect(wire.prompt[0]?.providerOptions).toEqual({
    anthropic: { cacheControl: { type: 'ephemeral' } },
  })
  expect(wire.prompt[1]?.providerOptions).toBeUndefined()
  // 不认会话缓存键的线路：内部标记照样剥掉，键不出线，断点照常翻译
  const withoutKey = applyPromptCacheCallOptions(call, { sessionKey: false })
  expect(withoutKey.providerOptions).toEqual({ openai: { strictJsonSchema: false } })
  expect(withoutKey.prompt[0]?.providerOptions).toEqual({
    anthropic: { cacheControl: { type: 'ephemeral' } },
  })
})

test('the driver sends cache markers and reports cache reads and writes', async () => {
  const seen: any[] = []
  const provider = new MockLanguageModelV3({
    doStream: async (options) => {
      seen.push(options)
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'ok' },
            { type: 'text-end', id: 't' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 900, noCache: 100, cacheRead: 700, cacheWrite: 100 },
                outputTokens: { total: 2, text: 2, reasoning: 0 },
              },
            },
          ] as any,
        }),
      }
    },
  })
  const driver = createAiSdkModelDriver({
    id: 'mock',
    model: provider,
    limits: { contextTokens: 32_000, inputTokens: 30_000, outputTokens: 1_000 },
  })
  const events = []
  for await (const event of driver.stream(
    {
      ...base,
      cacheKey: 'session-1',
      history: [{ role: 'user', content: 'segment base', cacheBreakpoint: true }],
    },
    new AbortController().signal
  ))
    events.push(event)
  expect(events).toContainEqual({
    type: 'usage',
    inputTokens: 900,
    outputTokens: 2,
    cacheReadTokens: 700,
    cacheWriteTokens: 100,
  })
  expect(seen[0].providerOptions).toEqual({ velaros: { promptCacheKey: 'session-1' } })
  expect(seen[0].prompt[1].providerOptions).toEqual({ velaros: { promptCacheBreakpoint: true } })
  expect(seen[0].prompt.at(-1).providerOptions).toBeUndefined()
})

test('automatic OpenAI boundaries use remaining slots without selecting an existing or unsupported endpoint', () => {
  const marked = (text: string) => ({
    role: 'user',
    content: [{ type: 'text', text }],
    providerOptions: { velaros: { promptCacheBreakpoint: true } },
  })
  for (const last of [
    {
      ...marked('explicit endpoint'),
      content: [
        {
          type: 'text',
          text: 'explicit endpoint',
          providerOptions: { openai: { promptCacheBreakpoint: { mode: 'explicit' } } },
        },
      ],
    },
    {
      ...marked('image endpoint'),
      content: [
        { type: 'file', mediaType: 'image/png', data: new URL('https://offline.invalid/image') },
      ],
    },
  ]) {
    const stable = last.content[0]?.type === 'file' ? ['old', 'middle', 'new'] : ['old', 'new']
    const options = { prompt: [...stable.map(marked), last] } as never
    const snapshot = JSON.stringify(options)
    const translated = applyPromptCacheCallOptions(options, {
      sessionKey: true,
      openaiBreakpoints: true,
    })
    for (const message of translated.prompt.slice(0, stable.length))
      expect(message).toMatchObject({
        content: [{ providerOptions: { openai: { promptCacheBreakpoint: { mode: 'explicit' } } } }],
      })
    expect(JSON.stringify(options)).toBe(snapshot)
  }
})

test('message cache translation strips the internal namespace and respects a false marker', () => {
  for (const openaiBreakpoints of [true, false, undefined]) {
    const options = {
      providerOptions: { velaros: { promptCacheKey: 'session', internal: 'private' } },
      prompt: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'marked' }],
          providerOptions: { velaros: { promptCacheBreakpoint: true, internal: 'private' } },
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'unmarked' }],
          providerOptions: {
            velaros: { promptCacheBreakpoint: false, internal: 'private' },
            other: { keep: 'caller' },
          },
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'internal-only' }],
          providerOptions: { velaros: { internal: 'private' }, other: { keep: 'caller' } },
        },
      ],
    } as never
    const snapshot = JSON.stringify(options)
    const translated = applyPromptCacheCallOptions(options, { sessionKey: true, openaiBreakpoints })
    expect(JSON.stringify(translated)).not.toContain('velaros')
    expect(translated.prompt[1]?.providerOptions).toEqual({ other: { keep: 'caller' } })
    expect(translated.prompt[2]?.providerOptions).toEqual({ other: { keep: 'caller' } })
    expect(JSON.stringify(options)).toBe(snapshot)
  }
})

/** 原生 Anthropic 适配器和实际 SDK 出线校验；所有 fetch 都由本地夹具截获。 */
async function captureAnthropicCacheWire(options: readonly unknown[]) {
  const composition = createModelRuntimeComposition({
    environment: {},
    providerScripts: { configPaths: [] },
  })
  const bodies: Array<{
    cache_control?: unknown
    tools?: Array<{ name: string; cache_control?: unknown }>
    system?: Array<{ text: string; cache_control?: unknown }>
    messages: Array<{ content: Array<{ type: string; text?: string; cache_control?: unknown }> }>
  }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init: { body?: unknown }) => {
    expect(String(input)).toBe('https://offline.invalid/v1/messages')
    bodies.push(JSON.parse(String(init.body)))
    return Response.json(
      {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'offline Anthropic cache fixture' },
      },
      { status: 400 }
    )
  }) as typeof fetch
  try {
    const factory = composition.agentModelRuntime.createAgentProvider({
      provider: 'anthropic',
      apiKey: 'offline-fixture',
      baseURL: 'https://offline.invalid/v1',
      reasoningLevel: 'low',
    })
    for (const request of options)
      await expect(factory('claude-sonnet-4-5').doGenerate(request as never)).rejects.toThrow(
        'offline Anthropic cache fixture'
      )
  } finally {
    globalThis.fetch = originalFetch
  }
  return bodies
}

const anthropicControl = { type: 'ephemeral' }
const anthropicMarked = (text: string) => ({
  role: 'user',
  content: [{ type: 'text', text }],
  providerOptions: { velaros: { promptCacheBreakpoint: true } },
})

test('Anthropic native budget preserves the stable opening and latest accepted prefix without losing caller boundaries', async () => {
  const [canonical, caller] = await captureAnthropicCacheWire([
    {
      prompt: ['base', 'goal', 'stable-result', 'history-end', 'accepted-frame'].map(
        anthropicMarked
      ),
    },
    {
      prompt: [
        ...['base', 'goal', 'stable-result', 'history-end'].map(anthropicMarked),
        {
          role: 'user',
          content: [{ type: 'text', text: 'caller-explicit' }],
          providerOptions: { anthropic: { cacheControl: anthropicControl } },
        },
      ],
    },
  ])
  const marked = (body: typeof canonical) =>
    body!.messages
      .flatMap((m) => m.content)
      .filter((p) => p.cache_control)
      .map((p) => p.text)
  expect(marked(canonical)).toEqual(['base', 'stable-result', 'history-end', 'accepted-frame'])
  expect(marked(caller)).toEqual(['base', 'stable-result', 'history-end', 'caller-explicit'])
})

test('Anthropic reserves explicit tool, system and content endpoints and deduplicates a shadowed message option', async () => {
  const request = {
    tools: [
      {
        type: 'function',
        name: 'caller-tool',
        inputSchema: { type: 'object', properties: {} },
        providerOptions: { anthropic: { cacheControl: anthropicControl } },
      },
    ],
    prompt: [
      {
        role: 'system',
        content: 'caller-system',
        providerOptions: { anthropic: { cache_control: anthropicControl } },
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'caller-part',
            providerOptions: { anthropic: { cacheControl: anthropicControl } },
          },
        ],
        providerOptions: { anthropic: { cacheControl: anthropicControl } },
      },
      ...['base', 'goal', 'stable-result', 'history-end', 'accepted-frame'].map(anthropicMarked),
    ],
  }
  const snapshot = JSON.stringify(request)
  const [body] = await captureAnthropicCacheWire([request])
  expect(body?.tools?.[0]?.cache_control).toEqual(anthropicControl)
  expect(body?.system?.[0]?.cache_control).toEqual(anthropicControl)
  expect(
    body?.messages
      .flatMap((m) => m.content)
      .filter((p) => p.cache_control)
      .map((p) => p.text)
  ).toEqual(['caller-part', 'accepted-frame'])
  expect(JSON.stringify(request)).toBe(snapshot)
})

test('Anthropic tool-result part, output and final message options share one actual block endpoint', async () => {
  const output = (text: string) => ({
    type: 'content',
    value: [
      { type: 'text', text, providerOptions: { anthropic: { cache_control: anthropicControl } } },
    ],
  })
  const request = {
    prompt: [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'one',
            toolName: 'fixture',
            output: {
              ...output('shadowed-output'),
              providerOptions: { anthropic: { cacheControl: anthropicControl } },
            },
            providerOptions: { anthropic: { cacheControl: anthropicControl } },
          },
          {
            type: 'tool-result',
            toolCallId: 'two',
            toolName: 'fixture',
            output: output('nested-output'),
          },
        ],
        providerOptions: { anthropic: { cacheControl: anthropicControl } },
      },
      ...['base', 'middle', 'accepted-frame'].map(anthropicMarked),
    ],
  }
  const snapshot = JSON.stringify(request)
  const [body] = await captureAnthropicCacheWire([request])
  const blocks = body!.messages.flatMap((m) => m.content).filter((p) => p.cache_control)
  expect(blocks).toHaveLength(4)
  expect(blocks.map((p) => p.type)).toEqual(['tool_result', 'tool_result', 'text', 'text'])
  expect(blocks.filter((p) => p.type === 'text').map((p) => p.text)).toEqual([
    'base',
    'accepted-frame',
  ])
  expect(JSON.stringify(request)).toBe(snapshot)
})

test('Anthropic top-level automatic caching reserves one native slot and caller excess fails before sending', async () => {
  const top = { anthropic: { cacheControl: anthropicControl } }
  const [body] = await captureAnthropicCacheWire([
    {
      providerOptions: top,
      prompt: ['base', 'goal', 'stable', 'accepted-frame'].map(anthropicMarked),
    },
  ])
  expect(body?.cache_control).toEqual(anthropicControl)
  expect(
    body?.messages
      .flatMap((m) => m.content)
      .filter((p) => p.cache_control)
      .map((p) => p.text)
  ).toEqual(['base', 'stable', 'accepted-frame'])
  for (const automatic of [false, true]) {
    const options = {
      ...(automatic ? { providerOptions: top } : {}),
      prompt: Array.from({ length: automatic ? 4 : 5 }, (_, i) => ({
        role: 'user',
        content: [{ type: 'text', text: `caller-${i}` }],
        providerOptions: { anthropic: { cacheControl: anthropicControl } },
      })),
    } as never
    const snapshot = JSON.stringify(options)
    expect(() =>
      applyPromptCacheCallOptions(options, { sessionKey: false, anthropicBreakpointLimit: 4 })
    ).toThrow('超过本线路 4')
    expect(JSON.stringify(options)).toBe(snapshot)
  }
})

test('Anthropic automatic marks respect caller TTL order without upgrading the internal cache lifetime', async () => {
  const long = { type: 'ephemeral', ttl: '1h' }
  const [explicit, automatic] = await captureAnthropicCacheWire([
    {
      prompt: [
        anthropicMarked('base'),
        {
          role: 'user',
          content: [{ type: 'text', text: 'long-caller' }],
          providerOptions: { anthropic: { cacheControl: long } },
        },
        anthropicMarked('accepted-frame'),
      ],
    },
    {
      providerOptions: { anthropic: { cacheControl: long } },
      prompt: ['base', 'accepted-frame'].map(anthropicMarked),
    },
  ])
  expect(
    explicit?.messages
      .flatMap((m) => m.content)
      .filter((p) => p.cache_control)
      .map((p) => ({ text: p.text, control: p.cache_control }))
  ).toEqual([
    { text: 'long-caller', control: long },
    { text: 'accepted-frame', control: anthropicControl },
  ])
  expect(automatic?.cache_control).toEqual(long)
  expect(automatic?.messages.flatMap((m) => m.content).filter((p) => p.cache_control)).toEqual([])
})

test('Anthropic TTL allocation follows hoisted and inline system wire order rather than source indexes', async () => {
  const long = { type: 'ephemeral', ttl: '1h' }
  const markedSystem = (content: string) => ({
    role: 'system',
    content,
    providerOptions: { velaros: { promptCacheBreakpoint: true } },
  })
  const callerSystem = {
    role: 'system',
    content: 'inline-long',
    providerOptions: { anthropic: { cacheControl: long } },
  }
  const [hoisted, inline] = await captureAnthropicCacheWire([
    {
      prompt: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'user-long' }],
          providerOptions: { anthropic: { cacheControl: long } },
        },
        markedSystem('late-hoisted'),
      ],
    },
    {
      prompt: [
        markedSystem('top-system'),
        anthropicMarked('early-user'),
        callerSystem,
        anthropicMarked('accepted-frame'),
      ],
    },
  ])
  expect(hoisted?.system?.map((p) => ({ text: p.text, control: p.cache_control }))).toEqual([
    { text: 'late-hoisted', control: undefined },
  ])
  expect(
    hoisted?.messages
      .flatMap((m) => m.content)
      .filter((p) => p.cache_control)
      .map((p) => ({ text: p.text, control: p.cache_control }))
  ).toEqual([{ text: 'user-long', control: long }])
  expect(inline?.system?.map((p) => ({ text: p.text, control: p.cache_control }))).toEqual([
    { text: 'top-system', control: undefined },
  ])
  expect(
    inline?.messages
      .flatMap((m) => m.content)
      .filter((p) => p.cache_control)
      .map((p) => ({ text: p.text, control: p.cache_control }))
  ).toEqual([
    { text: 'inline-long', control: long },
    { text: 'accepted-frame', control: anthropicControl },
  ])
})

test('Anthropic rejects explicit non-cacheable endpoints while canonical invalid endpoints consume no native slots', async () => {
  const [body] = await captureAnthropicCacheWire([
    {
      prompt: [
        anthropicMarked('base'),
        {
          role: 'assistant',
          content: [{ type: 'reasoning', text: 'thinking' }],
          providerOptions: { velaros: { promptCacheBreakpoint: true } },
        },
        anthropicMarked('accepted-frame'),
      ],
    },
  ])
  expect(
    body?.messages
      .flatMap((m) => m.content)
      .filter((p) => p.cache_control)
      .map((p) => p.text)
  ).toEqual(['base', 'accepted-frame'])
  for (const content of [
    [],
    [{ type: 'reasoning', text: 'thinking' }],
    [{ type: 'text', text: '' }],
  ]) {
    const options = {
      prompt: [
        {
          role: 'assistant',
          content,
          providerOptions: { anthropic: { cacheControl: anthropicControl } },
        },
      ],
    } as never
    expect(() =>
      applyPromptCacheCallOptions(options, { sessionKey: false, anthropicBreakpointLimit: 4 })
    ).toThrow('没有可缓存内容块落点')
  }
})

interface OpenAiCacheWire {
  model: string
  prompt_cache_key?: string
  prompt_cache_options?: unknown
  input: Array<{
    role: string
    content: Array<{
      type: string
      text: string
      prompt_cache_breakpoint?: { mode: string }
    }>
  }>
}

/** 经正式适配器和真实 SDK 捕获出线 JSON；夹具拒绝请求，全程不访问供应商。 */
async function captureOpenAiCacheWire(
  model: string,
  requests: readonly ModelTurnRequest[],
  selectionOverrides: Record<string, unknown> = {},
  runtimeOverrides?: Record<string, unknown>,
  composition = createModelRuntimeComposition({
    environment: {},
    providerScripts: { configPaths: [] },
  })
) {
  const selection = {
    provider: 'openai',
    apiKey: 'offline-fixture',
    baseURL: 'https://offline.invalid/v1',
    reasoningLevel: 'high',
    ...selectionOverrides,
  }
  const bodies: OpenAiCacheWire[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init: { body?: unknown }) => {
    if (String(input) === 'https://offline.invalid/v1/models')
      return Response.json({ data: [{ id: model }] })
    expect(String(input)).toBe('https://offline.invalid/v1/responses')
    bodies.push(JSON.parse(String(init.body)))
    return Response.json({ error: { message: 'offline cache fixture' } }, { status: 400 })
  }) as typeof fetch
  try {
    const factory = runtimeOverrides
      ? (
          await composition.agentModelRuntime.resolveRoleRuntime(
            { ...selection, model },
            {
              providerRuntimeConfigs: [
                { ...selection, enabled: true, defaultModel: model, ...runtimeOverrides },
              ],
              openRouter: { useFreeModelsForDebug: false },
            }
          )
        ).provider
      : composition.agentModelRuntime.createAgentProvider(selection)
    const driver = createAiSdkModelDriver({
      id: `openai/${model}`,
      model: factory(model),
      limits: { contextTokens: 32_000, inputTokens: 30_000, outputTokens: 1_000 },
    })
    for (const request of requests) {
      const deltas = []
      for await (const delta of driver.stream(request, new AbortController().signal))
        deltas.push(delta)
      expect(deltas.at(-1)).toMatchObject({ type: 'error' })
    }
  } finally {
    globalThis.fetch = originalFetch
  }
  expect(bodies).toHaveLength(requests.length)
  return bodies
}

test.each([
  ['gpt-5.6', true],
  ['gpt-5.6-sol', true],
  ['gpt-5.6-terra', true],
  ['gpt-5.6-luna', true],
  ['gpt-5.6-2026-09-01', true],
  ['gpt-5.6-sol-2026-09-01', true],
  ['gpt-6-sol', true],
  ['gpt-6-sol-2026-09-01', true],
  ['gpt-5.5', false],
  ['gpt-5.4', false],
  ['gpt-4.1', false],
  ['gpt-5.6-private', false],
  ['gpt-5.6-sol-private', false],
  ['gpt-5.60', false],
  ['gpt-5.7', false],
  ['custom-model', false],
] as const)(
  'OpenAI %s explicit cache capability is %s on the real SDK wire',
  async (model, enabled) => {
    const [wire] = await captureOpenAiCacheWire(model, [
      {
        ...base,
        history: [{ role: 'user', content: 'stable history', cacheBreakpoint: true }],
        cacheKey: 'offline-session',
      },
    ])
    expect(wire!.model).toBe(model)
    expect(wire!.prompt_cache_key).toBe('offline-session')
    const marked = wire!.input
      .flatMap((message) => message.content)
      .filter((part) => part.prompt_cache_breakpoint)
    expect(marked).toEqual(
      enabled
        ? [
            {
              type: 'input_text',
              text: 'stable history',
              prompt_cache_breakpoint: { mode: 'explicit' },
            },
          ]
        : []
    )
    expect(wire!.input.at(-1)!.content.every((part) => !part.prompt_cache_breakpoint)).toBe(true)
    expect(JSON.stringify(wire)).not.toContain('velaros')
    expect(wire).not.toHaveProperty('prompt_cache_options')
  }
)

test('GPT-5.6 preserves the marked history prefix while current frames change', async () => {
  const history: ModelTurnRequest['history'] = [
    { role: 'user', content: 'segment base', cacheBreakpoint: true },
    { role: 'assistant', content: 'previous script' },
    { role: 'user', content: 'stable result', cacheBreakpoint: true },
  ]
  const wires = await captureOpenAiCacheWire(
    'gpt-5.6-sol',
    ['current frame A', 'current frame B'].map((compiledPrompt) => ({
      ...base,
      history,
      compiledPrompt,
      cacheKey: 'offline-session',
    }))
  )
  expect(wires[0]!.input[0]!.role).toBe('developer')
  expect(wires[0]!.input.slice(0, -1)).toEqual(wires[1]!.input.slice(0, -1))
  for (const [index, wire] of wires.entries()) {
    expect(
      wire.input
        .flatMap((message) => message.content)
        .filter((part) => part.prompt_cache_breakpoint)
        .map((part) => part.text)
    ).toEqual(['segment base', 'stable result'])
    expect(wire.input.at(-1)!.content).toEqual([
      { type: 'input_text', text: `current frame ${index ? 'B' : 'A'}` },
    ])
  }
})

test('explicit cache capability can be disabled without changing request bodies or implicit cache keys', async () => {
  const composition = createModelRuntimeComposition({
    environment: {},
    providerScripts: { configPaths: [] },
  })
  const requests: ModelTurnRequest[] = ['frame A', 'frame B'].map((compiledPrompt) => ({
    ...base,
    compiledPrompt,
    cacheKey: 'same-session',
    history: [
      { role: 'user', content: 'stable prefix', cacheBreakpoint: true },
      { role: 'assistant', content: 'prior answer' },
      { role: 'user', content: 'stable result', cacheBreakpoint: true },
    ],
  }))
  const snapshot = JSON.stringify(requests)
  const defaults = await captureOpenAiCacheWire('gpt-5.6-sol', requests, {}, undefined, composition)
  const enabled = await captureOpenAiCacheWire(
    'gpt-5.6-sol',
    requests,
    {
      openaiExplicitCacheBreakpoints: true,
    },
    undefined,
    composition
  )
  const disabled = await captureOpenAiCacheWire(
    'gpt-5.6-sol',
    requests,
    {
      openaiExplicitCacheBreakpoints: false,
    },
    undefined,
    composition
  )
  expect(enabled).toEqual(defaults)
  expect(JSON.stringify(disabled)).not.toContain('prompt_cache_breakpoint')
  expect(disabled).toEqual(
    defaults.map((body) => ({
      ...body,
      input: body.input.map((message) => ({
        ...message,
        content: Array.isArray(message.content)
          ? message.content.map(({ prompt_cache_breakpoint: _breakpoint, ...part }) => part)
          : message.content,
      })),
    }))
  )
  expect(JSON.stringify(requests)).toBe(snapshot)
  expect(await captureOpenAiCacheWire('gpt-5.6-sol', requests, {}, undefined, composition)).toEqual(
    defaults
  )
  const alias = await captureOpenAiCacheWire('custom-model', requests.slice(0, 1), {
    openaiExplicitCacheBreakpoints: true,
  })
  expect(JSON.stringify(alias)).toContain('prompt_cache_breakpoint')
})

test('runtime provider cache capability is inherited and an explicit selection overrides it', async () => {
  const request = {
    ...base,
    history: [{ role: 'user' as const, content: 'prefix', cacheBreakpoint: true }],
  }
  const inherited = await captureOpenAiCacheWire(
    'gpt-5.6-sol',
    [request],
    {},
    { openaiExplicitCacheBreakpoints: false }
  )
  expect(JSON.stringify(inherited)).not.toContain('prompt_cache_breakpoint')
  const override = await captureOpenAiCacheWire(
    'gpt-5.6-sol',
    [request],
    { openaiExplicitCacheBreakpoints: true },
    { openaiExplicitCacheBreakpoints: false }
  )
  expect(JSON.stringify(override)).toContain('prompt_cache_breakpoint')
  await expect(
    captureOpenAiCacheWire('gpt-5.6-sol', [request], { openaiExplicitCacheBreakpoints: 'false' })
  ).rejects.toThrow('openaiExplicitCacheBreakpoints')
  await expect(
    captureOpenAiCacheWire('gpt-5.6-sol', [request], {}, { openaiExplicitCacheBreakpoints: 0 })
  ).rejects.toThrow('openaiExplicitCacheBreakpoints')
})

test('explicitly disabling OpenAI breakpoints rejects conflicting caller fields without rewriting them', () => {
  const options = {
    prompt: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'prefix',
            providerOptions: { openai: { promptCacheBreakpoint: { mode: 'explicit' } } },
          },
        ],
      },
    ],
  } as never
  const snapshot = JSON.stringify(options)
  expect(() =>
    applyPromptCacheCallOptions(options, { sessionKey: true, openaiBreakpoints: false })
  ).toThrow('显式缓存断点')
  expect(JSON.stringify(options)).toBe(snapshot)
  expect(applyPromptCacheCallOptions(options, { sessionKey: true })).toBe(options)
})

test('GPT-5.6 adds no boundary without an internal marker and keeps three explicit write slots', async () => {
  const wires = await captureOpenAiCacheWire('gpt-5.6-sol', [
    { ...base, history: [{ role: 'user', content: 'unmarked history' }] },
    {
      ...base,
      history: ['old base', 'user input', 'retired prefix', 'history end'].map((content) => ({
        role: 'user',
        content,
        cacheBreakpoint: true,
      })),
    },
  ])
  expect(JSON.stringify(wires[0])).not.toContain('prompt_cache_breakpoint')
  expect(
    wires[1]!.input
      .flatMap((message) => message.content)
      .filter((part) => part.prompt_cache_breakpoint)
      .map((part) => part.text)
  ).toEqual(['user input', 'retired prefix', 'history end'])
  expect(wires[1]!.input.at(-1)!.content.every((part) => !part.prompt_cache_breakpoint)).toBe(true)
})
