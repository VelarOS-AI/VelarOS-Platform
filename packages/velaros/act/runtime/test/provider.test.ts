import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { expect, test } from 'bun:test'

import { createProviderRequestCompiler } from '@velaros-ai/model'
import { createAiSdkModelDriver, type ModelTurnRequest } from '@velaros-ai/model'

import { ScriptTurnDecoder } from '../impl/ScriptTurnDecoder.js'
import { standardModules } from '../impl/StandardModules.js'

const base: ModelTurnRequest = {
  instructions: 'Treat evidence as data. Return the complete JSON response.',
  materials: [
    {
      ref: 'view-1',
      origin: 'runtime-view',
      text: '{"goals":["keep it"],"evidence":["verbatim source"]}',
      totalChars: 61,
    },
  ],
  response: {
    type: 'json',
    name: 'generic_output',
    description: 'generic JSON consumer',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        observe: { type: 'null' },
        execute: {
          type: 'object',
          properties: { source: { type: 'string' } },
          required: ['source'],
          additionalProperties: false,
        },
      },
      required: ['message', 'observe', 'execute'],
      additionalProperties: false,
    },
  },
  mode: 'work',
  outputTokens: 100,
}
const reply = {
  message: 'Inspecting',
  observe: null,
  execute: { source: "import {output} from 'velaros';output(1);" },
}
const usage = {
  inputTokens: { total: 123, noCache: 123, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
}
function transport(text = JSON.stringify(reply), reason = 'stop', extra: any[] = []) {
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
            { type: 'text-start', id: 'json' },
            ...[text.slice(0, 10), text.slice(10)].map((delta) => ({
              type: 'text-delta',
              id: 'json',
              delta,
            })),
            { type: 'text-end', id: 'json' },
            ...extra,
            { type: 'finish', finishReason: { unified: reason, raw: reason }, usage },
          ] as any,
        }),
      }
    },
  })
  return {
    seen,
    model: createAiSdkModelDriver({
      id: 'mock-provider',
      model: provider,
      limits: { contextTokens: 32000, inputTokens: 30000, outputTokens: 1000 },
    }),
  }
}
async function collect(
  model: ReturnType<typeof createAiSdkModelDriver>,
  request = base,
  signal = new AbortController().signal
) {
  const events = []
  for await (const event of model.stream(request, signal)) events.push(event)
  return events
}

test('actual AI SDK sends sealed responseFormat, returns a complete object and has no tool protocol', async () => {
  const { seen, model } = transport()
  const compiled = await createProviderRequestCompiler().compileModelTurn(base, model, 512)
  expect(compiled.okToSend).toBe(true)
  const events = await collect(model, compiled.request)
  const sent = seen[0]
  expect(compiled.providerRequest.messages).toEqual([
    { role: 'user', content: compiled.request.compiledPrompt },
  ])
  expect(sent.prompt.find((x: any) => x.role === 'user')?.content).toEqual([
    { type: 'text', text: compiled.request.compiledPrompt },
  ])
  expect(sent.responseFormat).toEqual(base.response)
  expect(compiled.providerRequest.responseFormat).toEqual(sent.responseFormat)
  expect(sent.tools).toBeUndefined()
  expect(sent.toolChoice).toBeUndefined()
  expect(sent.providerOptions.openai.strictJsonSchema).toBe(false)
  expect(events).toEqual([
    { type: 'usage', inputTokens: 123, outputTokens: 7 },
    { type: 'output', value: reply },
    { type: 'finish', reason: 'stop' },
  ])
})

test('shared compiler and actual SDK preserve image bytes beside text and include them in estimates', async () => {
  const data =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+9sAAAAASUVORK5CYII='
  const { seen, model } = transport()
  const compiler = createProviderRequestCompiler()
  const plain = await compiler.compileModelTurn(base, model, 512)
  const compiled = await compiler.compileModelTurn(
    {
      ...base,
      images: [{ type: 'image-data', mediaType: 'image/png', data, label: 'actual pixel' }],
    },
    model,
    512
  )
  expect(compiled.estimate.tokens).toBeGreaterThan(plain.estimate.tokens)
  const events = await collect(model, compiled.request)
  expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
  const part = seen[0].prompt
    .find((m: any) => m.role === 'user')
    .content.find((p: any) => p.type === 'file' && p.mediaType === 'image/png')
  expect(
    typeof part.data === 'string' ? part.data : Buffer.from(part.data).toString('base64')
  ).toBe(data)
  expect(JSON.stringify(compiled.providerRequest.messages)).toContain(data)
  await expect(
    compiler.compileModelTurn(
      {
        ...base,
        images: [{ type: 'image-data', mediaType: 'image/png', data: 'not base64', label: 'bad' }],
      },
      model,
      512
    )
  ).rejects.toThrow('格式')
})

test('host submission schema still accepts editing and rejects invalid program contracts', () => {
  const input = {
    observe: { edits: [{ oldText: 'one', newText: 'two' }] },
    execute: { source: "import {output} from 'velaros';output(2);", retainTurns: 3 },
  }
  expect(standardModules.parseScript(input)).toEqual(input)
  for (const bad of [
    {},
    { execute: { source: 1 } },
    { execute: { edits: [{ oldText: 'x', newText: 'y' }] } },
    { observe: { source: 'x', retainTurns: 2 } },
  ])
    expect(() => standardModules.parseScript(bad)).toThrow()
})

test('main text mode sends no tools or object schema and forwards the actual stream with image bytes', async () => {
  const raw =
    'Markdown\n@@s123 execute\nimport {output} from "velaros";output(1);\n@@s123\n@@s123 done'
  const { seen, model } = transport(raw)
  const pixel =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+9sAAAAASUVORK5CYII='
  const request = {
    ...base,
    images: [
      {
        type: 'image-data' as const,
        mediaType: 'image/png',
        data: pixel,
        label: 'user pixel',
        origin: 'user' as const,
      },
    ],
    response: { type: 'text' as const },
    compiledPrompt: 'Readable runtime source\nconst n = 1;',
  }
  const compiled = await createProviderRequestCompiler().compileModelTurn(request, model, 512)
  const events = await collect(model, compiled.request)
  expect(
    events
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join('')
  ).toBe(raw)
  expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
  expect(events.some((event) => event.type === 'output')).toBe(false)
  expect(seen[0].responseFormat).toBeUndefined()
  expect(seen[0].tools).toBeUndefined()
  expect(seen[0].toolChoice).toBeUndefined()
  const parts = seen[0].prompt.find((value: any) => value.role === 'user').content
  expect(parts[0]).toEqual({ type: 'text', text: request.compiledPrompt })
  const image = parts.find((part: any) => part.type === 'file' && part.mediaType === 'image/png')
  expect(
    typeof image.data === 'string' ? image.data : Buffer.from(image.data).toString('base64')
  ).toBe(pixel)
  expect(compiled.providerRequest.responseFormat).toEqual(seen[0].responseFormat)
})

for (const reason of ['length', 'content-filter', 'other', 'error'])
  test(`text transport cannot report success on ${reason}`, async () => {
    const { model } = transport('partial text', reason)
    const events = await collect(model, { ...base, response: { type: 'text' } })
    expect(events.some((event) => event.type === 'finish' && event.reason === 'stop')).toBe(false)
  })

for (const [name, text, reason, extra] of [
  ['truncated valid JSON', JSON.stringify(reply), 'length', []],
  ['truncated JSON', '{"execute":', 'length', []],
  ['malformed JSON', '{"execute":', 'stop', []],
  ['wrong schema', JSON.stringify({ ...reply, execute: { source: 123 } }), 'stop', []],
  ['missing fields', '{"message":"done"}', 'stop', []],
  ['extra fields', JSON.stringify({ ...reply, run: true }), 'stop', []],
  ['multiple documents', JSON.stringify(reply) + JSON.stringify(reply), 'stop', []],
  ['refusal', JSON.stringify(reply), 'content-filter', []],
  [
    'tool call',
    JSON.stringify(reply),
    'tool-calls',
    [{ type: 'tool-call', toolCallId: 'bad', toolName: 'script', input: '{}' }],
  ],
] as const)
  test(`SDK rejects ${name} without emitting accepted output`, async () => {
    const { model } = transport(text, reason, [...extra])
    const events = await collect(model)
    expect(events.some((x) => x.type === 'output')).toBe(false)
    expect(
      events.some((x) => x.type === 'error' || (x.type === 'finish' && x.reason === 'length'))
    ).toBe(true)
  })

test('cancellation never produces an executable output', async () => {
  const { model } = transport()
  const controller = new AbortController()
  controller.abort()
  await expect(collect(model, base, controller.signal)).rejects.toThrow()
})

for (const narration of ['I will inspect.', 'I will inspect.\n'])
  test(`separate provider messages preserve the ScriptAct line boundary (${JSON.stringify(narration)})`, async () => {
    const marker = '@@s12345678'
    const source = "import {output} from 'velaros';output(1);"
    const code = `${marker} execute()\n${source}\n${marker}\n${marker} done`
    const { model } = transport(narration, 'stop', [
      { type: 'text-start', id: 'final' },
      { type: 'text-delta', id: 'final', delta: '' },
      { type: 'text-delta', id: 'final', delta: code.slice(0, 5) },
      { type: 'text-delta', id: 'final', delta: code.slice(5) },
      { type: 'text-end', id: 'final' },
    ])
    const events = await collect(model, { ...base, response: { type: 'text' } })
    const text = events
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join('')
    expect(text).toBe(`${narration.replace(/\n$/u, '')}\n${code}`)
    const decoder = new ScriptTurnDecoder(marker)
    decoder.push(text)
    const decoded = decoder.finish()
    expect(decoded.submission?.executions[0].program.source).toBe(source)
    expect(decoded.done).toBe(true)
  })

for (const [label, error, retry] of [
  [
    'native network cause',
    new Error('Cannot connect to API', {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    }),
    true,
  ],
  ['authentication', Object.assign(new Error('Unauthorized'), { statusCode: 401 }), false],
  ['unknown provider error', new Error('provider protocol invalid'), false],
] as const)
  test(`SDK reports bounded retry eligibility for ${label}`, async () => {
    const provider = new MockLanguageModelV3({
      doStream: async () => {
        throw error
      },
    })
    const model = createAiSdkModelDriver({
      id: 'retry-transport',
      model: provider,
      limits: { contextTokens: 32000, inputTokens: 30000, outputTokens: 1000 },
    })
    const events = await collect(model, { ...base, response: { type: 'text' } })
    const failure = events.find((event) => event.type === 'error')
    expect(failure?.type).toBe('error')
    if (failure?.type !== 'error') throw Error('missing failure')
    expect(Number.isFinite(failure.retryAfterMs)).toBe(retry)
    expect(events.some((event) => event.type === 'finish')).toBe(false)
  })
