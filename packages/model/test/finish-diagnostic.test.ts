import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { expect, test } from 'bun:test'

import { createAiSdkModelDriver } from '../src/index.js'

for (const raw of [
  'content_filter',
  'private-token service unavailable maximum tokens',
  undefined,
]) {
  test(`finish diagnostics whitelist raw reason: ${String(raw)}`, async () => {
    const model = new MockLanguageModelV3({
      provider: 'openai.chat',
      modelId: 'fixture',
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'finish',
              finishReason: { unified: 'content-filter', raw },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 0, text: 0, reasoning: 0 },
              },
            },
          ],
        }),
      }),
    })
    const driver = createAiSdkModelDriver({
      id: 'diagnostic-fixture',
      model,
      limits: { contextTokens: 32000, inputTokens: 30000, outputTokens: 1000 },
    })
    const events = []
    for await (const event of driver.stream(
      {
        instructions: 'fixture',
        materials: [],
        response: { type: 'text' },
        mode: 'work',
        outputTokens: 100,
      },
      new AbortController().signal
    ))
      events.push(event)
    const failure = events.find((event) => event.type === 'error')!
    expect(failure.code).toBe('provider')
    expect(failure.retryAfterMs).toBeUndefined()
    expect(failure.message).toContain(
      `raw=${raw === undefined ? 'missing' : raw === 'content_filter' ? raw : 'unrecognized'}`
    )
    expect(failure.message).toContain('finish=content-filter')
    expect(failure.message).not.toContain('private-token')
    expect(events.some((event) => event.type === 'finish')).toBe(false)
  })
}
