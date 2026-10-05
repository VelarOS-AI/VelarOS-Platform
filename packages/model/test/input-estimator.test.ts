import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { expect, test } from 'bun:test'
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base'

import type { ModelTurnRequest } from '@velaros-ai/kernel'
import { modelRequestEncoder } from '@velaros-ai/kernel'

import { ModelInputEstimator } from '../src/impl/requests/ModelInputEstimator.js'
import { createAiSdkModelDriver, createProviderRequestCompiler } from '../src/index.js'
import { restoreResponseContinuations } from '../src/utils/wire/continuation.js'

const request = (text: string, cacheKey = 'parent'): ModelTurnRequest => ({
  instructions: 'Use the supplied material to complete the task.',
  history: [{ role: 'user', content: text }],
  materials: [],
  response: { type: 'text' },
  mode: 'work',
  outputTokens: 1000,
  cacheKey,
})

function fixture(provider = 'openai.chat', modelId = 'gpt-4o') {
  let inputTokens = 0
  let failure: string | undefined
  const model = new MockLanguageModelV3({
    provider,
    modelId,
    doStream: async () => {
      if (failure) throw Error(failure)
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'done' },
            { type: 'text-end', id: 't' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: {
                  total: inputTokens,
                  noCache: inputTokens,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ],
        }),
      }
    },
  })
  const driver = createAiSdkModelDriver({
    id: 'route-with-private-overhead',
    model,
    limits: { contextTokens: 65536, inputTokens: 32768, outputTokens: 1000 },
  })
  const textTokens = (value: ModelTurnRequest) => {
    const restored = restoreResponseContinuations(
      modelRequestEncoder.messages(value),
      model,
      driver.id
    )
    return countTokens(
      JSON.stringify({ system: value.instructions, messages: restored.messages }),
      {
        disallowedSpecial: new Set(),
      }
    )
  }
  const send = async (value: ModelTurnRequest, tokens: number, error?: string) => {
    inputTokens = tokens
    failure = error
    const events = []
    for await (const event of driver.stream(value, new AbortController().signal)) events.push(event)
    return events
  }
  return { driver, textTokens, send }
}

test('a new child request reuses actual route overhead and admits complete source within the window', async () => {
  const f = fixture()
  const first = request('Read the project and preserve the full user requirements. '.repeat(40))
  const child = request('const greeting = "你好，🌈";\n'.repeat(1100), 'maintenance-child')
  const snapshot = JSON.stringify(child)
  const cold = await f.driver.estimate(child)
  expect(cold.tokens).toBeGreaterThan(f.driver.limits.inputTokens)
  const actualFirst = f.textTokens(first) + 4300
  const events = await f.send(first, actualFirst)
  expect(events.filter((event) => event.type === 'usage')).toHaveLength(1)
  const warm = await f.driver.estimate(child)
  expect(warm.tokens).toBeGreaterThanOrEqual(f.textTokens(child) + 4300)
  expect(warm.tokens).toBeLessThan(f.driver.limits.inputTokens)
  expect(warm.precision).toBe('estimate')
  expect(warm.composition).toEqual(cold.composition)
  const compiled = await createProviderRequestCompiler().compileModelTurn(child, f.driver, 1024, {
    textRatio: 0.1,
  })
  expect(compiled.estimate.tokens).toBe(warm.tokens)
  expect(compiled.okToSend).toBe(true)
  expect(JSON.stringify(child)).toBe(snapshot)
})

test('route calibration bounds input growth without charging every request the largest observed overhead', async () => {
  const f = fixture()
  const actual = (value: ModelTurnRequest) => Math.ceil(f.textTokens(value) * 1.5 + 1200)
  const samples = [200, 2000, 800].map((size) => request('const item = 1;\n'.repeat(size)))
  for (const value of samples) await f.send(value, actual(value))
  const target = request('const item = 1;\n'.repeat(1200), 'independent-child')
  const maximumOverhead = Math.max(...samples.map((value) => actual(value) - f.textTokens(value)))
  const snapshot = JSON.stringify(target)
  const estimate = await f.driver.estimate(target)
  expect(estimate.tokens).toBeGreaterThanOrEqual(actual(target))
  expect(estimate.tokens).toBeLessThan(f.textTokens(target) + maximumOverhead)
  for (const value of samples)
    expect((await f.driver.estimate(value)).tokens).toBeGreaterThanOrEqual(actual(value))
  expect(JSON.stringify(target)).toBe(snapshot)
})

test('growth calibration keeps the fixed upper bound outside observed input sizes', async () => {
  const f = fixture()
  const samples = [200, 900].map((size) => request('body '.repeat(size)))
  const usage = samples.map((value) => Math.ceil(f.textTokens(value) * 1.4 + 600))
  for (const [index, value] of samples.entries()) await f.send(value, usage[index]!)
  const maximumOverhead = Math.max(
    ...samples.map((value, index) => usage[index]! - f.textTokens(value))
  )
  for (const size of [10, 1800]) {
    const value = request('body '.repeat(size))
    expect((await f.driver.estimate(value)).tokens).toBeGreaterThanOrEqual(
      f.textTokens(value) + maximumOverhead
    )
  }
})

test('unusual intermediate samples remain covered by the calibrated envelope', async () => {
  const f = fixture()
  const samples = [100, 1600, 500, 950].map((size) => request('render(value);\n'.repeat(size)))
  const usage = samples.map((value, index) => f.textTokens(value) + (index === 2 ? 2400 : 400))
  for (const [index, value] of samples.entries()) await f.send(value, usage[index]!)
  for (const [index, value] of samples.entries())
    expect((await f.driver.estimate(value)).tokens).toBeGreaterThanOrEqual(usage[index]!)
})

test('provider overflow resets learned route estimates and missing usage never seeds them', async () => {
  const f = fixture()
  const value = request('Investigate and report only verified facts. '.repeat(200))
  const cold = await f.driver.estimate(value)
  await f.send(value, f.textTokens(value) + 700)
  expect((await f.driver.estimate(value)).tokens).toBeLessThan(cold.tokens)
  const events = await f.send(value, 0, 'maximum context length exceeded')
  expect(events.at(-1)).toMatchObject({ type: 'error', code: 'context-limit' })
  expect(await f.driver.estimate(value)).toEqual(cold)
  await f.send(value, 0, 'request rejected')
  expect(await f.driver.estimate(value)).toEqual(cold)
})

test.each([
  ['custom.chat', 'gpt-4o'],
  ['openai.chat', 'private-router'],
  ['openai.chat', 'gpt-3.5-private-router'],
  ['anthropic.messages', 'gpt-4o'],
])(
  'unknown tokenizer identity %s/%s retains the existing byte estimate',
  async (provider, modelId) => {
    const f = fixture(provider, modelId)
    const value = request('abcdef '.repeat(1000))
    const cold = await f.driver.estimate(value)
    await f.send(value, 500)
    expect(await f.driver.estimate(value)).toEqual(cold)
  }
)

test('image requests and separate driver instances do not contaminate text calibration', async () => {
  const f = fixture()
  const value = request('abcdef '.repeat(1000))
  const cold = await f.driver.estimate(value)
  await f.send(
    { ...value, images: [{ type: 'image-data', mediaType: 'image/png', data: 'AAAA' }] },
    10000
  )
  expect(await f.driver.estimate(value)).toEqual(cold)
  await f.send(value, f.textTokens(value) + 500)
  expect((await f.driver.estimate(value)).tokens).toBeLessThan(cold.tokens)
  expect(await fixture().driver.estimate(value)).toEqual(cold)
})

test('literal tokenizer control strings remain ordinary source text after calibration', async () => {
  const f = fixture()
  const value = request('The file contains <|endoftext|> and <|fim_suffix|>. '.repeat(150))
  await f.send(value, f.textTokens(value) + 900)
  const estimated = await f.driver.estimate(value)
  expect(estimated.tokens).toBeGreaterThanOrEqual(f.textTokens(value) + 900)
  expect(estimated.tokens).toBeLessThan(estimated.composition!.total)
})

test('late samples after a route reset cannot restore old calibration and opaque capacity stays separate', async () => {
  const model = new MockLanguageModelV3({ provider: 'openai.responses', modelId: 'gpt-5' })
  const estimator = new ModelInputEstimator(model)
  const value = request('source();\n'.repeat(500))
  const restored = {
    messages: [{ role: 'user' as const, content: 'ordinary source '.repeat(300) }],
    opaqueTokens: 0,
  }
  const late = await estimator.prepare(value, restored)
  estimator.reset()
  estimator.record(late, 100)
  const cold = await estimator.prepare(value, restored)
  expect(cold.estimate.calibration).toBeUndefined()
  estimator.record(cold, cold.textTokens! + 3000)
  const warm = await estimator.prepare(value, restored)
  const opaque = await estimator.prepare(value, { ...restored, opaqueTokens: 1900 })
  expect(warm.estimate.calibration).toBe('provider-usage')
  expect(opaque.estimate.tokens).toBe(warm.estimate.tokens + 1900)
  expect(opaque.estimate.opaqueTokens).toBe(1900)
  estimator.record(opaque, 20000)
  expect((await estimator.prepare(value, restored)).estimate.tokens).toBeGreaterThanOrEqual(20000)
})

test('an earlier supported model selects its own encoding while newer unknown families stay conservative', async () => {
  const known = fixture('openai.chat', 'gpt-4-0613')
  const value = request('source();\n'.repeat(500))
  await known.send(value, 3000)
  expect((await known.driver.estimate(value)).basis).toContain('cl100k_base')
  const unknown = fixture('openai.chat', 'gpt-99-experimental')
  const cold = await unknown.driver.estimate(value)
  await unknown.send(value, 100)
  expect(await unknown.driver.estimate(value)).toEqual(cold)
})
