/**
 * @test-meta
 * title: 通用模型请求客户端
 * summary: 第三方 transport 无需产品协议即可执行 text/object 请求。
 * area: package
 */
import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { ModelRequestClient } from '../src/ModelRequestClient'
import { ModelRequestService } from '../src/ModelRequestService'

test('accepts a third-party transport and preserves caller endpoint', async () => {
  const envelopes = []
  const transport = {
    generateText: async (envelope) => {
      envelopes.push(envelope)
      return {
        text: 'transport response',
        output: { value: 42 },
      }
    },
    streamText: () => {
      throw new Error('stream not used by this fixture')
    },
    createObjectOutput: (input) => ({ type: 'object', ...input }),
  }
  const client = new ModelRequestClient({ transport })

  const text = await client.generateText({
    endpoint: 'third-party.summary',
    model: 'fixture-model',
    prompt: 'hello',
  })
  const object = await client.generateDecodedObject({
    endpoint: 'third-party.extract',
    model: 'fixture-model',
    system: 'extract',
    messages: [{ role: 'user', content: 'hello' }],
    schema: {},
    schemaName: 'Fixture',
    schemaDescription: 'fixture schema',
    decodeOutput: async (output) => output.value,
  })
  const legacyMappedObject = await client.generateObject({
    endpoint: 'third-party.legacy-extract',
    model: 'fixture-model',
    system: 'extract',
    messages: [{ role: 'user', content: 'hello' }],
    schema: {},
    schemaName: 'LegacyFixture',
    schemaDescription: 'legacy fixture schema',
    mapOutput: (output) => output.value,
  })

  assert.equal(text, 'transport response')
  assert.equal(object, 42)
  assert.equal(legacyMappedObject, 42)
  assert.deepEqual(
    envelopes.map((envelope) => envelope.endpoint),
    ['third-party.summary', 'third-party.extract', 'third-party.legacy-extract']
  )
})

test('legacy service remains an instanceof the generic client', () => {
  const transport = {
    generateText: async () => ({ text: '', output: undefined }),
    streamText: () => {
      throw new Error('not used')
    },
    createObjectOutput: () => undefined,
  }

  assert.ok(new ModelRequestService({ transport }) instanceof ModelRequestClient)
})

test('policy preserves explicit request values and forwards streaming lifecycle callbacks', async () => {
  let captured
  const abort = new AbortController()
  const onError = () => undefined
  const client = new ModelRequestClient({
    transport: {
      generateText: async () => {
        throw new Error('not used')
      },
      createObjectOutput: () => undefined,
      streamText: (envelope) => {
        captured = envelope
        return {
          textStream: (async function* () {
            yield 'answer'
          })(),
        }
      },
    },
  })
  const stream = client.streamText(
    {
      endpoint: 'caller.owned-purpose',
      model: 'fixture-model',
      messages: [{ role: 'user', content: 'input' }],
      maxOutputTokens: 64,
      temperature: 0,
      maxRetries: 0,
      abortSignal: abort.signal,
      onError,
    },
    {
      requestPolicy: { temperature: 0.4, topP: 0.8, maxOutputTokens: 256 },
    }
  )
  const chunks = []
  for await (const text of stream.textStream) chunks.push(text)
  assert.equal(chunks.join(''), 'answer')
  assert.deepEqual(captured, {
    endpoint: 'caller.owned-purpose',
    request: {
      model: 'fixture-model',
      messages: [{ role: 'user', content: 'input' }],
      maxOutputTokens: 64,
      temperature: 0,
      topP: 0.8,
      maxRetries: 0,
      abortSignal: abort.signal,
      onError,
    },
  })
})

test('collection closes the source as soon as the caller stop condition is satisfied', async () => {
  let nextChunks = 0
  let closed = false
  const client = new ModelRequestClient({
    transport: {
      generateText: async () => {
        throw new Error('not used')
      },
      createObjectOutput: () => undefined,
      streamText: () => ({
        textStream: (async function* () {
          try {
            for (const text of ['ab', 'cd', 'unexpected']) {
              nextChunks += 1
              yield text
            }
          } finally {
            closed = true
          }
        })(),
      }),
    },
  })
  assert.equal(
    await client.collectTextStream({
      endpoint: 'caller.bounded-output',
      model: 'fixture-model',
      messages: [],
      stopWhen: (text) => text.length >= 4,
    }),
    'abcd'
  )
  assert.equal(nextChunks, 2)
  assert.equal(closed, true)
})

test('the compatibility constructor exposes the same generic request surface', () => {
  assert.equal(ModelRequestService, ModelRequestClient)
  assert.deepEqual(Object.getOwnPropertyNames(ModelRequestClient.prototype).sort(), [
    'collectTextStream',
    'constructor',
    'generateDecodedObject',
    'generateObject',
    'generateText',
    'streamText',
  ])
})
