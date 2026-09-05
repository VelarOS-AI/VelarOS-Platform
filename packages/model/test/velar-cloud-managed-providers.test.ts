import { describe, expect, test } from 'bun:test'

import {
  getModelProviderOperationalManifest,
  getSharedProviderCatalog,
  isModelProviderEmbeddingCapable,
  isVelarCloudManagedProviderId,
  resolveProviderModelSelection,
  VelarCloudModelRuntime,
} from '../src'
import { createModelRuntimeComposition } from '../src/node'

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
    const manifest = getModelProviderOperationalManifest('velar-dev')
    const catalog = getSharedProviderCatalog('velar-dev')

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
    expect(resolveProviderModelSelection('velar-dev', VelarDevModelId)).toEqual({
      model: VelarDevModelId,
      didFallback: false,
    })
    expect(isVelarCloudManagedProviderId('velar')).toBe(true)
    expect(isVelarCloudManagedProviderId('velar-dev')).toBe(true)
    expect(isVelarCloudManagedProviderId('openrouter')).toBe(false)
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

  test('keeps legacy register/require bound to Velar and never crosses provider bindings', () => {
    const runtime = new VelarCloudModelRuntime()
    const velarFetch = createChatCompletionFetch([])
    const velarDevFetch = createChatCompletionFetch([])

    runtime.register({ baseURL: 'https://cloud.test/v1/model/', fetch: velarFetch })

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

    expect(runtime.require('velar').fetch).toBe(velarFetch)
    expect(runtime.require('velar-dev')).toEqual({
      baseURL: 'https://cloud.test/v1/velar-dev',
      fetch: velarDevFetch,
    })
    expect(runtime.hasProvider('velar')).toBe(true)
    expect(runtime.hasProvider('velar-dev')).toBe(true)

    expect(runtime.unregisterProvider('velar-dev')).toBe(true)
    expect(runtime.hasProvider('velar-dev')).toBe(false)
    expect(runtime.require('velar').fetch).toBe(velarFetch)
    expect(() => runtime.require('velar-dev')).toThrow(
      'Velar Dev 模型服务尚未连接，请先登录已授权账户。'
    )
    expect(runtime.unregisterProvider('velar-dev')).toBe(false)

    runtime.registerProvider('velar-dev', {
      baseURL: 'https://cloud.test/v1/velar-dev',
      fetch: velarDevFetch,
    })
    expect(runtime.unregisterProvider('velar')).toBe(true)
    expect(runtime.require('velar-dev').fetch).toBe(velarDevFetch)
    expect(() => runtime.require('velar')).toThrow(
      'Velar 模型服务尚未连接，请先登录内部账户。'
    )
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
    composition.velarCloudRuntime.register({
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

    const velar = composition.agentModelRuntime.createAgentProvider({
      provider: 'velar',
      apiKey: '',
      baseURL: '',
      thinkingDepth: 'deep',
      reasoningLevel: 'ultra',
    })
    await velar('velar/auto').doGenerate(ChatCallOptions)

    expect(velarRequests).toEqual([
      {
        url: 'https://cloud.test/v1/model/chat/completions',
        body: expect.objectContaining({
          model: 'velar/auto',
          reasoning: { effort: 'high', max_tokens: 24_000 },
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
    expect(isModelProviderEmbeddingCapable(composition.providerCollection, 'velar-dev')).toBe(false)
    expect(() =>
      composition.modelAdapterRegistry.createEmbeddingRequest(
        { provider: 'velar-dev', apiKey: '', baseURL: '' },
        VelarDevModelId,
        ['hello']
      )
    ).toThrow('Velar Dev 当前只提供聊天模型，不支持 embedding。')

    composition.velarCloudRuntime.register({
      baseURL: 'https://cloud.test/v1/model',
      fetch: createChatCompletionFetch([]),
    })
    expect(
      composition.modelAdapterRegistry.createEmbeddingRequest(
        { provider: 'velar', apiKey: '', baseURL: '' },
        'ignored-model',
        ['hello']
      )
    ).toEqual({
      url: 'https://cloud.test/v1/model/embeddings',
      headers: { Authorization: 'Bearer velar-managed' },
      body: { model: 'velar/embedding', input: ['hello'] },
    })
  })
})
