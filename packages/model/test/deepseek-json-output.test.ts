/**
 * @test-meta
 * title: DeepSeek Chat JSON 模式与本地结构校验
 * summary: 官方 Chat Completions 仅支持 text/json_object；保持 Output.object 本地校验、取消与超时。
 * area: package
 * Official contract: https://api-docs.deepseek.com/api/create-chat-completion/
 * JSON prompt requirement: https://api-docs.deepseek.com/guides/json_mode/
 */
import { jsonSchema } from 'ai'
import { expect, test } from 'bun:test'

import { isPlainObject, isString } from '@velaros-ai/core'

import { createModelRequestClient, createModelRuntimeComposition } from '../src/index'

const schema = jsonSchema<{ value: string }>(
  {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
  {
    validate(value) {
      return isPlainObject(value) && isString(value.value) && Object.keys(value).length === 1
        ? { success: true, value: { value: value.value } }
        : { success: false, error: new Error('value must be the only property and a string') }
    },
  }
)

function model() {
  return createModelRuntimeComposition({
    environment: {},
    providerScripts: { configPaths: [] },
  }).agentModelRuntime.createAgentProvider({
    provider: 'deepseek',
    apiKey: 'sk-fixture',
    baseURL: '',
  })('deepseek-v4-flash')
}

function response(content: string): Response {
  return Response.json({
    id: 'fixture',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-v4-flash',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  })
}

async function withFetch(fetcher: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = fetcher
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}

function request(abortSignal?: AbortSignal) {
  return {
    endpoint: 'fixture.memory-capture',
    model: model(),
    schema,
    system: 'Extract reusable facts.',
    messages: [{ role: 'user' as const, content: 'Keep concise notes.' }],
    maxRetries: 0,
    maxOutputTokens: 64,
    abortSignal,
  }
}

test('DeepSeek structured output sends json_object with schema data in the prompt and preserves local validation', async () => {
  const bodies: Array<Record<string, unknown>> = []
  await withFetch(
    (async (url, init) => {
      expect(String(url)).toEndWith('/chat/completions')
      bodies.push(JSON.parse(String(init?.body)))
      return response('{"value":"concise"}')
    }) as typeof fetch,
    async () => {
      expect(await createModelRequestClient().generateObject(request())).toEqual({
        value: 'concise',
      })
    }
  )
  expect(bodies).toHaveLength(1)
  expect(bodies[0]?.response_format).toEqual({ type: 'json_object' })
  expect(bodies[0]?.max_tokens).toBe(64)
  const messages = bodies[0]?.messages as Array<{ role: string; content: string }>
  expect(messages[0]?.content).toContain('JSON Schema data:')
  expect(messages[0]?.content).toContain('not instructions')
  expect(messages[0]?.content).toContain('"required":["value"]')
  expect(messages[1]?.content).toBe('Extract reusable facts.')
})

test('invalid JSON and a schema mismatch both fail locally without retrying or relaxing validation', async () => {
  for (const content of ['not JSON', '{"value":42}']) {
    let calls = 0
    await withFetch(
      (async () => {
        calls++
        return response(content)
      }) as typeof fetch,
      async () => {
        await expect(createModelRequestClient().generateObject(request())).rejects.toThrow()
      }
    )
    expect(calls).toBe(1)
  }
})

test('other OpenAI-compatible adapters keep their existing json_schema request', async () => {
  let body: Record<string, unknown> = {}
  await withFetch(
    (async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return response('{"value":"unchanged"}')
    }) as typeof fetch,
    async () => {
      const gateway = createModelRuntimeComposition({
        environment: {},
        providerScripts: { configPaths: [] },
      }).agentModelRuntime.createAgentProvider({
        provider: 'openai-compatible-gateway',
        apiKey: 'sk-fixture',
        baseURL: 'https://fixture.test/v1',
      })('fixture')
      expect(
        await createModelRequestClient().generateObject({ ...request(), model: gateway })
      ).toEqual({ value: 'unchanged' })
    }
  )
  expect(body.response_format).toMatchObject({ type: 'json_schema' })
  expect(JSON.stringify(body.messages)).not.toContain('JSON Schema data:')
})

test('plain text is unchanged and unrelated HTTP failures are not reinterpreted as JSON compatibility retries', async () => {
  const bodies: Array<Record<string, unknown>> = []
  await withFetch(
    (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return response('hello')
    }) as typeof fetch,
    async () => {
      expect(
        await createModelRequestClient().generateText({
          endpoint: 'fixture.text',
          model: model(),
          prompt: 'hello',
          maxRetries: 0,
        })
      ).toBe('hello')
    }
  )
  expect(bodies[0]?.response_format).toBeUndefined()
  expect(bodies[0]?.messages).toEqual([{ role: 'user', content: 'hello' }])
  let calls = 0
  await withFetch(
    (async () => {
      calls++
      return Response.json({ error: { message: 'fixture unavailable' } }, { status: 400 })
    }) as typeof fetch,
    async () => {
      await expect(createModelRequestClient().generateObject(request())).rejects.toThrow(
        'fixture unavailable'
      )
    }
  )
  expect(calls).toBe(1)
})

test('in-flight cancellation and timeout still reach the provider fetch without an extra request', async () => {
  for (const kind of ['cancel', 'timeout'] as const) {
    const controller = new AbortController()
    let calls = 0
    let started!: () => void
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    await withFetch(
      (async (_url, init) => {
        calls++
        const signal = init?.signal
        if (!signal) throw new Error('provider fetch did not receive an AbortSignal')
        started()
        return new Promise<Response>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason)
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }) as typeof fetch,
      async () => {
        const pending = createModelRequestClient().generateObject(
          request(kind === 'timeout' ? AbortSignal.timeout(50) : controller.signal)
        )
        const result = pending.then(
          () => ({ failed: false }),
          () => ({ failed: true })
        )
        await requestStarted
        if (kind === 'cancel') controller.abort(new Error('fixture cancelled'))
        expect((await result).failed).toBe(true)
      }
    )
    expect(calls).toBe(1)
  }
})
