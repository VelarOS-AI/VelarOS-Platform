import { describe, expect, test } from 'bun:test'

import { VelarCloudModelRuntime } from '../src/impl/providers/VelarCloudModelRuntime'
import { createModelRuntimeComposition, modelCatalog } from '../src/index'
import { isVelarCloudManagedProvider } from '../src/utils/catalog/model-selection'

const VelarDevModelId = 'velar-dev/Z3B0LTUuNC1taW5p'

interface CapturedRequest {
  readonly body: Record<string, unknown>
  readonly url: string
}

function createChatCompletionFetch(captured: CapturedRequest[]): typeof fetch {
  return (async (input, init) => {
    captured.push({
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      url: String(input),
    })
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 0,
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }) as typeof fetch
}

/** 只有宿主注入的 fetch 才带账户认证，这个替身用来证明 embedding 走的是它。 */
function createEmbeddingFetch(captured: CapturedRequest[]): typeof fetch {
  return (async (input, init) => {
    captured.push({
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      url: String(input),
    })
    return new Response(JSON.stringify({ data: [{ embedding: [0.5] }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
}

const ChatCallOptions = {
  prompt: [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
    },
  ],
}

describe('Velar Cloud managed providers', () => {
  test('declares Velar Dev as a Cloud-managed provider with a dynamic catalog', () => {
    const manifest = modelCatalog.manifest('velar-dev')
    const catalog = modelCatalog.catalog('velar-dev')

    expect(manifest).toMatchObject({
      id: 'velar-dev',
      label: 'Velar Dev',
      enabledByDefault: true,
      managedByCloud: true,
      validationKind: 'velar-managed',
    })
    expect(catalog).toEqual({
      provider: 'velar-dev',
      defaultModel: '',
      models: [],
    })
    expect(modelCatalog.resolveModelSelection('velar-dev', VelarDevModelId)).toEqual({
      model: VelarDevModelId,
      didFallback: false,
    })
    expect(isVelarCloudManagedProvider('velaros')).toBe(true)
    expect(isVelarCloudManagedProvider('velar-dev')).toBe(true)
    expect(isVelarCloudManagedProvider('openrouter')).toBe(false)
  })

  test('keeps the runtime config ready but cannot execute without its own Cloud binding', () => {
    const composition = createModelRuntimeComposition({
      providerScripts: { configPaths: [] },
    })

    expect(composition.providerCollection.getDefaultRuntimeConfig('velar-dev')).toMatchObject({
      provider: 'velar-dev',
      enabled: true,
    })
    expect(composition.velarCloudRuntime.hasProvider('velar-dev')).toBe(false)
    expect(() =>
      composition.agentModelRuntime.createAgentProvider({
        provider: 'velar-dev',
        apiKey: '',
        baseURL: '',
      })
    ).toThrow('Velar Dev 模型服务尚未连接，请先登录已授权账户。')
  })

  test('keeps velaros register/require bound to Velar and never crosses provider bindings', () => {
    const runtime = new VelarCloudModelRuntime()
    const velarFetch = createChatCompletionFetch([])
    const velarDevFetch = createChatCompletionFetch([])

    runtime.registerProvider('velaros', {
      baseURL: 'https://cloud.test/v1/model/',
      fetch: velarFetch,
    })

    expect(runtime.require()).toEqual({
      baseURL: 'https://cloud.test/v1/model',
      fetch: velarFetch,
    })
    expect(() => runtime.require('velar-dev')).toThrow(
      'Velar Dev 模型服务尚未连接，请先登录已授权账户。'
    )

    runtime.registerProvider('velar-dev', {
      baseURL: 'https://cloud.test/v1/velar-dev/',
      fetch: velarDevFetch,
    })

    expect(runtime.require('velaros').fetch).toBe(velarFetch)
    expect(runtime.require('velar-dev')).toEqual({
      baseURL: 'https://cloud.test/v1/velar-dev',
      fetch: velarDevFetch,
    })
    expect(runtime.hasProvider('velaros')).toBe(true)
    expect(runtime.hasProvider('velar-dev')).toBe(true)

    expect(runtime.unregisterProvider('velar-dev')).toBe(true)
    expect(runtime.hasProvider('velar-dev')).toBe(false)
    expect(runtime.require('velaros').fetch).toBe(velarFetch)
    expect(() => runtime.require('velar-dev')).toThrow(
      'Velar Dev 模型服务尚未连接，请先登录已授权账户。'
    )
    expect(runtime.unregisterProvider('velar-dev')).toBe(false)

    runtime.registerProvider('velar-dev', {
      baseURL: 'https://cloud.test/v1/velar-dev',
      fetch: velarDevFetch,
    })
    expect(runtime.unregisterProvider('velaros')).toBe(true)
    expect(runtime.require('velar-dev').fetch).toBe(velarDevFetch)
    expect(() => runtime.require('velaros')).toThrow('Velar 模型服务尚未连接，请先登录内部账户。')
  })

  test('rejects empty bindings instead of silently creating a cross-provider fallback', () => {
    const runtime = new VelarCloudModelRuntime()

    expect(() =>
      runtime.registerProvider('velar-dev', {
        baseURL: ' / ',
        fetch: createChatCompletionFetch([]),
      })
    ).toThrow('velar-dev Cloud 模型服务地址不能为空。')
    expect(runtime.hasProvider('velar-dev')).toBe(false)
  })

  test('routes each provider through its own binding and preserves the dynamic model id', async () => {
    const velarRequests: CapturedRequest[] = []
    const velarDevRequests: CapturedRequest[] = []
    const composition = createModelRuntimeComposition({
      providerScripts: { configPaths: [] },
    })
    composition.velarCloudRuntime.registerProvider('velaros', {
      baseURL: 'https://cloud.test/v1/model',
      fetch: createChatCompletionFetch(velarRequests),
    })
    composition.velarCloudRuntime.registerProvider('velar-dev', {
      baseURL: 'https://cloud.test/v1/velar-dev',
      fetch: createChatCompletionFetch(velarDevRequests),
    })

    const velarDev = composition.agentModelRuntime.createAgentProvider({
      provider: 'velar-dev',
      apiKey: '',
      baseURL: '',
      thinkingDepth: 'deep',
      reasoningLevel: 'ultra',
    })
    await velarDev(VelarDevModelId).doGenerate(ChatCallOptions)

    expect(velarDevRequests).toEqual([
      {
        url: 'https://cloud.test/v1/velar-dev/chat/completions',
        body: expect.objectContaining({ model: VelarDevModelId }),
      },
    ])
    expect(velarDevRequests[0]?.body.reasoning).toBeUndefined()
    expect(velarRequests).toHaveLength(0)

    const velaros = composition.agentModelRuntime.createAgentProvider({
      provider: 'velaros',
      apiKey: '',
      baseURL: '',
      thinkingDepth: 'deep',
      reasoningLevel: 'ultra',
    })
    await velaros('velaros/auto').doGenerate(ChatCallOptions)

    expect(velarRequests).toEqual([
      {
        url: 'https://cloud.test/v1/model/chat/completions',
        body: expect.objectContaining({
          model: 'velaros/auto',
          // 这次调用没给 maxOutputTokens，请求体里也就没有 max_tokens，ultra 按 ultraFloor 发。
          reasoning: { effort: 'high', max_tokens: 16_000 },
        }),
      },
    ])
    expect(velarDevRequests).toHaveLength(1)
  })

  test('requires an explicit Velar Dev chat model and rejects embedding without crossing services', () => {
    const composition = createModelRuntimeComposition({
      providerScripts: { configPaths: [] },
    })
    composition.velarCloudRuntime.registerProvider('velar-dev', {
      baseURL: 'https://cloud.test/v1/velar-dev',
      fetch: createChatCompletionFetch([]),
    })
    const factory = composition.agentModelRuntime.createAgentProvider({
      provider: 'velar-dev',
      apiKey: '',
      baseURL: '',
    })

    expect(() => factory('')).toThrow('Velar Dev 模型必须由 Cloud 动态目录显式选择。')
    expect(composition.providerCollection.isEmbeddingCapable('velar-dev')).toBe(false)
    expect(() =>
      composition.modelAdapterRegistry.createEmbeddingRequest(
        { provider: 'velar-dev', apiKey: '', baseURL: '' },
        VelarDevModelId,
        ['hello']
      )
    ).toThrow('Velar Dev 当前只提供聊天模型，不支持 embedding。')

    composition.velarCloudRuntime.registerProvider('velaros', {
      baseURL: 'https://cloud.test/v1/model',
      fetch: createChatCompletionFetch([]),
    })
    const embeddingRequest = composition.modelAdapterRegistry.createEmbeddingRequest(
      { provider: 'velaros', apiKey: '', baseURL: '' },
      'ignored-model',
      ['hello']
    )
    expect({
      url: embeddingRequest.url,
      headers: embeddingRequest.headers,
      body: embeddingRequest.body,
    }).toEqual({
      url: 'https://cloud.test/v1/model/embeddings',
      headers: { Authorization: 'Bearer velar-managed' },
      body: { model: 'velaros/embedding', input: ['hello'] },
    })
    expect(typeof embeddingRequest.execute).toBe('function')
  })

  test('embedding 走宿主注入的带账户认证 fetch', async () => {
    const requests: CapturedRequest[] = []
    const composition = createModelRuntimeComposition({
      providerScripts: { configPaths: [] },
    })
    composition.velarCloudRuntime.registerProvider('velaros', {
      baseURL: 'https://cloud.test/v1/model',
      fetch: createEmbeddingFetch(requests),
    })

    const request = composition.modelAdapterRegistry.createEmbeddingRequest(
      { provider: 'velaros', apiKey: '', baseURL: '' },
      'ignored-model',
      ['hello']
    )
    const payload = await request.execute?.()

    expect(requests).toEqual([
      {
        url: 'https://cloud.test/v1/model/embeddings',
        body: { model: 'velaros/embedding', input: ['hello'] },
      },
    ])
    expect(payload).toEqual({ data: [{ embedding: [0.5] }] })
  })

  test('embedding 失败时给出带状态码的中文原因', async () => {
    const composition = createModelRuntimeComposition({
      providerScripts: { configPaths: [] },
    })
    composition.velarCloudRuntime.registerProvider('velaros', {
      baseURL: 'https://cloud.test/v1/model',
      fetch: (async () =>
        new Response('{"error":"quota"}', { status: 402 })) as unknown as typeof fetch,
    })

    const request = composition.modelAdapterRegistry.createEmbeddingRequest(
      { provider: 'velaros', apiKey: '', baseURL: '' },
      'ignored-model',
      ['hello']
    )

    expect(request.execute?.()).rejects.toThrow(
      'Velar embedding 请求失败（HTTP 402）：{"error":"quota"}'
    )
  })

  test('服务地址末尾的多余分隔符被去干净', () => {
    const composition = createModelRuntimeComposition({
      providerScripts: { configPaths: [] },
    })
    composition.velarCloudRuntime.registerProvider('velaros', {
      baseURL: 'https://cloud.test/v1/model//',
      fetch: createChatCompletionFetch([]),
    })

    expect(
      composition.modelAdapterRegistry.createEmbeddingRequest(
        { provider: 'velaros', apiKey: '', baseURL: '' },
        'ignored-model',
        ['hello']
      ).url
    ).toBe('https://cloud.test/v1/model/embeddings')
    expect(
      composition.providerCollection.resolveBaseURL({
        provider: 'openai',
        baseURL: 'https://proxy.test/v1//',
      })
    ).toBe('https://proxy.test/v1')
  })
})
