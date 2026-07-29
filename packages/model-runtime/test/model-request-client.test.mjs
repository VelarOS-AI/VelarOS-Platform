/**
 * @test-meta
 * title: 通用模型请求客户端
 * summary: 第三方 transport 无需产品协议即可执行 text/object 请求。
 * area: package
 */
import assert from 'node:assert/strict'

import { test } from 'bun:test'

import {
  ModelRequestClient,
  ModelRequestService,
} from '@velaros-ai/model-runtime'

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
  const object = await client.generateObject({
    endpoint: 'third-party.extract',
    model: 'fixture-model',
    system: 'extract',
    messages: [{ role: 'user', content: 'hello' }],
    schema: {},
    schemaName: 'Fixture',
    schemaDescription: 'fixture schema',
    mapOutput: (output) => output.value,
  })

  assert.equal(text, 'transport response')
  assert.equal(object, 42)
  assert.deepEqual(
    envelopes.map((envelope) => envelope.endpoint),
    ['third-party.summary', 'third-party.extract']
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
