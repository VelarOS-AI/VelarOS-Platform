import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { expect, test } from 'bun:test'

import type { ModelInputEstimate, ModelTurnRequest } from '@velaros-ai/kernel'

import { createAiSdkModelDriver, createProviderRequestCompiler } from '../src/index.js'
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
