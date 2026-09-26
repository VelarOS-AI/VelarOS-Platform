/**
 * model 域的不变量验收：`spec/invariants.md` 里每一条「测试」档的检验器。
 * 用例名以 INV-<编号> 开头，`check:module-ownership` 按这个前缀核对登记表与实现对得上。
 */
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { describe, expect, test } from 'bun:test'

import type { KernelModuleActivateContext, ModelTurnRequest } from '@velaros-ai/kernel'
import type { CapabilityToken } from '@velaros-ai/kernel/contracts'

import { ReasoningFallback } from '../src/impl/adapters/ReasoningFallback'
import {
  type ChatProviderId,
  createAiSdkModelDriver,
  createModelKernelModule,
  createModelRuntimeComposition,
  DefaultProviderModels,
  type ModelAdapterRegistryApi,
  ModelCapability,
  modelCatalog,
  ModelErrorCodes,
  ModelProviderOperationalManifests,
  type ModelRuntimeCapabilityService,
  modelUsage,
} from '../src/index'
import { SharedProviderCatalogs } from '../src/utils/catalog/provider-catalogs'
import { ModelTuning } from '../src/utils/tuning'

const InjectedProviderId = 'velaros-spec-provider' as ChatProviderId

const InjectedProviderSource = `
module.exports = {
  manifest: {
    id: '${InjectedProviderId}',
    label: 'Spec Provider',
    description: '验收用的注入 provider。',
    defaultBaseURL: 'https://example.test/v1',
    defaultApiKey: '',
    apiKeyOptional: true,
    baseURLConfigurable: false,
    enabledByDefault: true,
    defaultModel: 'spec-chat',
    models: [{ id: 'spec-chat', label: 'Spec Chat' }]
  },
  createLanguageModelFactory() {
    return function createLanguageModel() {
      return {}
    }
  }
}
`

/** 每次都造一份互不相干的对象图：磁盘上的 dev.json 一律不读。 */
function createIsolatedComposition() {
  return createModelRuntimeComposition({ providerScripts: { configPaths: [] } })
}

/** 把内核模块激活起来，拿到它登记的能力服务。 */
async function activate(registry: ModelAdapterRegistryApi) {
  const module = createModelKernelModule({ registry })
  let service: ModelRuntimeCapabilityService | undefined
  const context = {
    registerService<TService extends object>(
      token: CapabilityToken<TService>,
      registered: TService
    ) {
      expect(token.id).toBe(ModelCapability.id)
      service = registered as unknown as ModelRuntimeCapabilityService
      return { dispose() {} }
    },
  } as unknown as KernelModuleActivateContext
  await module.activate(context)
  return service
}

describe('model 不变量验收', () => {
  test('INV-1 只在同一个 provider 内回退模型，绝不换 provider', () => {
    // 逐个内置 provider 核对：拿别家的模型名来解析，结果要么是用户填的原名（目录只是建议的
    // 那几家），要么是**本家**目录里的模型，绝不会解析成别家目录独有的模型。
    for (const manifest of ModelProviderOperationalManifests) {
      const ownModels = modelCatalog.models(manifest.id)
      for (const foreignModel of ['claude-sonnet-4-6', 'gpt-5.5', 'not-a-real-model']) {
        if (ownModels.includes(foreignModel)) continue
        const resolution = modelCatalog.resolveModelSelection(manifest.id, foreignModel)
        const keptRequested = resolution.model === foreignModel && !resolution.didFallback
        const fellBackWithinProvider =
          ownModels.includes(resolution.model) || resolution.model === foreignModel
        expect(`${manifest.id}/${foreignModel}:${keptRequested || fellBackWithinProvider}`).toBe(
          `${manifest.id}/${foreignModel}:true`
        )
      }
    }

    // 不认得的 provider 直接报 providerUnknown，不换一家能用的顶上。
    const composition = createIsolatedComposition()
    expect(() =>
      composition.agentModelRuntime.createAgentProvider({
        provider: 'not-a-provider',
        model: 'x',
        apiKey: 'k',
        baseURL: '',
      })
    ).toThrow('未找到 provider 适配器：not-a-provider')
  })

  test('INV-2 两份对象图之间不共享任何可变状态', () => {
    const first = createIsolatedComposition()
    const second = createIsolatedComposition()

    first.providerScriptRegistry.registerSource({
      source: InjectedProviderSource,
      scriptPath: '/tmp/velaros-model-spec-provider.cjs',
    })

    expect(first.providerScriptRegistry.supportsProvider(InjectedProviderId)).toBe(true)
    expect(second.providerScriptRegistry.supportsProvider(InjectedProviderId)).toBe(false)
    expect(first.providerCollection).not.toBe(second.providerCollection)
    expect(first.velarCloudRuntime).not.toBe(second.velarCloudRuntime)
    expect(first.velarCloudRuntime.hasProvider('velaros')).toBe(false)
  })

  test('INV-3 未注册的 Cloud 服务直接报错，不回落别的 provider', () => {
    const composition = createIsolatedComposition()

    expect(() =>
      composition.modelAdapterRegistry.createLanguageModelFactory({
        provider: 'velar-dev',
        apiKey: '',
        baseURL: '',
      })
    ).toThrow('Velar Dev 模型服务尚未连接，请先登录已授权账户。')
  })

  test('INV-4 可移植面不发现宿主进程，环境值只能显式给', () => {
    const previous = process.env.VELAROS_OLLAMA_CHAT_MODEL
    process.env.VELAROS_OLLAMA_CHAT_MODEL = 'ambient-model'

    try {
      expect(modelCatalog.resolveOllamaChatModel('fallback-model')).toBe('fallback-model')
      expect(modelCatalog.resolveOllamaContextWindow()).toBeNull()
      expect(
        modelCatalog.resolveOllamaChatModel('fallback-model', {
          read: (name) => (name === 'VELAROS_OLLAMA_CHAT_MODEL' ? 'qwen3:8b' : undefined),
        })
      ).toBe('qwen3:8b')
    } finally {
      if (previous === undefined) delete process.env.VELAROS_OLLAMA_CHAT_MODEL
      else process.env.VELAROS_OLLAMA_CHAT_MODEL = previous
    }
  })

  test('INV-5 缺凭据是错误码不是文案', () => {
    const composition = createIsolatedComposition()

    try {
      composition.providerCollection.requireApiKey({ provider: 'openai', apiKey: '' })
      throw new Error('缺 key 时应当抛错')
    } catch (error) {
      expect((error as { code?: string }).code).toBe(ModelErrorCodes.credentialMissing)
    }
  })

  test('INV-6 agent 侧入口收 unknown 并当场收窄，形状不对就拒绝', () => {
    const composition = createIsolatedComposition()

    expect(() =>
      composition.agentModelRuntime.createAgentProvider({ apiKey: '', baseURL: '' })
    ).toThrow('模型 selection.provider 必须显式提供。')
    expect(() => composition.agentModelRuntime.createAgentProvider(null)).toThrow()
  })

  test('INV-7 内核 wire 面只开 supports_provider，入参严格解析', async () => {
    const composition = createIsolatedComposition()
    const service = await activate(composition.modelAdapterRegistry)
    const signal = new AbortController().signal

    /** 把一次内核调用的失败收成错误码，同步抛与 Promise 拒绝都算。 */
    const invokeFailureCode = async (operation: string, input: unknown): Promise<string> => {
      try {
        await service?.invoke(operation, undefined, input, signal)
        return 'no-failure'
      } catch (error) {
        return (error as { code?: string }).code ?? 'unknown'
      }
    }

    expect(service?.getOperationMetadata('supports_provider')).toMatchObject({ permissions: [] })
    expect(
      await service?.invoke('supports_provider', undefined, { provider: 'openai' }, signal)
    ).toBe(true)
    // wire 面只有这一条：注册表的另外两个方法只给同进程持有服务的宿主直调，不进内核操作表。
    expect(await invokeFailureCode('create_language_model', {})).toBe('OPERATION_NOT_FOUND')
    expect(await invokeFailureCode('supports_provider', { provider: 'openai', extra: 1 })).toBe(
      'VALIDATION'
    )
    expect(await invokeFailureCode('supports_provider', {})).toBe('VALIDATION')
  })

  test('INV-8 静态目录与常量表始终一致', () => {
    const fromCatalog = Object.fromEntries(
      SharedProviderCatalogs.map((catalog) => [catalog.provider, catalog.defaultModel])
    )

    expect({ ...DefaultProviderModels }).toEqual(fromCatalog)
    expect(Object.keys(DefaultProviderModels).sort()).toEqual(
      ModelProviderOperationalManifests.map((manifest) => manifest.id).sort()
    )
    for (const manifest of ModelProviderOperationalManifests) {
      expect(`${manifest.id}:${!!modelCatalog.manifest(manifest.id)}`).toBe(`${manifest.id}:true`)
    }
  })

  test('INV-9 账本永远非负，查不到单价就不算钱', () => {
    const negative = modelUsage.normalizePersistedUsage({
      inputTokens: -5,
      outputTokens: -1,
      totalTokens: -6,
    })
    expect(negative.inputTokens).toBe(0)
    expect(negative.outputTokens).toBe(0)
    expect(negative.totalTokens).toBe(0)

    const catalog = {
      currency: 'USD' as const,
      version: '1',
      updatedAt: '2026-01-01',
      expiresAt: '2027-01-01',
      entries: [
        {
          provider: 'openai',
          model: 'gpt-5.5',
          aliases: ['gpt-5.5-latest'],
          inputUsdPerMillion: 2,
          outputUsdPerMillion: 8,
          source: 'spec',
        },
      ],
    }
    expect(modelUsage.pricingRates(catalog, 'openai', 'gpt-5.5-latest')).toEqual({
      inputPerMillion: 2,
      outputPerMillion: 8,
    })
    expect(modelUsage.pricingRates(catalog, 'anthropic', 'gpt-5.5')).toBeNull()
    expect(
      modelUsage.normalizeRunUsage({ inputTokens: 1_000_000, outputTokens: 0 }).cost
    ).toBeNull()
  })
})

test('INV-12 凭据探测使用供应商鉴权端点，缺密钥不发请求', async () => {
  const urls: string[] = []
  const runtime = createModelRuntimeComposition({
    environment: {},
    providerScripts: { configPaths: [] },
    providerCatalog: {
      fetch: async (input) => {
        urls.push(String(input))
        return Response.json({ error: { message: 'invalid api key' } }, { status: 401 })
      },
    },
  })
  const service = runtime.providerModelCatalogService
  expect(
    await service.validateProviderRuntime({ provider: 'openai', apiKey: '', baseURL: '' })
  ).toEqual({ ok: false, message: null })
  expect(urls).toEqual([])
  expect(
    (
      await service.validateProviderRuntime({
        provider: 'openrouter',
        apiKey: 'fixture',
        baseURL: '',
      })
    ).ok
  ).toBe(false)
  expect(urls).toEqual(['https://openrouter.ai/api/v1/key'])
})

/** 用一段模拟的供应商流驱动 AI SDK 驱动，收下转给宿主的思考摘要。 */
async function streamedReasoning(parts: readonly unknown[]): Promise<string[]> {
  const request: ModelTurnRequest = {
    instructions: 'spec',
    materials: [],
    response: { type: 'text' },
    mode: 'work',
    outputTokens: 100,
  }
  const driver = createAiSdkModelDriver({
    id: 'spec',
    model: new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            ...parts,
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'ok' },
            { type: 'text-end', id: 't' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 2, text: 2, reasoning: 0 },
              },
            },
          ] as any,
        }),
      }),
    }),
    limits: { contextTokens: 32_000, inputTokens: 30_000, outputTokens: 1_000 },
  })
  const reasoning: string[] = []
  let text = ''
  for await (const delta of driver.stream(request, new AbortController().signal)) {
    if (delta.type === 'reasoning') reasoning.push(delta.text)
    if (delta.type === 'text') text += delta.text
    if (delta.type === 'error') throw Error(delta.message)
  }
  expect(text).toBe('ok')
  return reasoning
}

test('INV-13 思考摘要只转给宿主展示：一条响应只认一路来源，分段空一行，超出上限只停转发', async () => {
  // Responses、Anthropic、Google：SDK 解析出的思考分片
  expect(
    await streamedReasoning([
      { type: 'reasoning-start', id: 'r:0' },
      { type: 'reasoning-delta', id: 'r:0', delta: '先看目录' },
      { type: 'reasoning-end', id: 'r:0' },
      { type: 'reasoning-start', id: 'r:1' },
      { type: 'reasoning-delta', id: 'r:1', delta: '再读文件' },
      { type: 'reasoning-end', id: 'r:1' },
    ])
  ).toEqual(['先看目录', '\n\n再读文件'])
  // Chat Completions：原始分块里的 reasoning_content 或 reasoning，别的形状不算
  expect(
    await streamedReasoning([
      { type: 'raw', rawValue: { choices: [{ delta: { reasoning_content: '想一想' } }] } },
      { type: 'raw', rawValue: { choices: [{ delta: { reasoning: '再想想', content: null } }] } },
      { type: 'raw', rawValue: { choices: [{ delta: { reasoning_content: null } }] } },
      { type: 'raw', rawValue: { type: 'response.reasoning_summary_text.delta', delta: '不算' } },
    ])
  ).toEqual(['想一想', '再想想'])
  // 两路都有时只认先到的那一路，同一段思考不重复
  expect(
    await streamedReasoning([
      { type: 'raw', rawValue: { choices: [{ delta: { reasoning_content: '一次' } }] } },
      { type: 'reasoning-start', id: 'r:0' },
      { type: 'reasoning-delta', id: 'r:0', delta: '一次' },
      { type: 'reasoning-end', id: 'r:0' },
    ])
  ).toEqual(['一次'])
  // 超出上限不再转发，正文照常收完
  const long = 'x'.repeat(ModelTuning.stream.reasoningChars)
  expect(
    await streamedReasoning([
      { type: 'reasoning-start', id: 'r:0' },
      { type: 'reasoning-delta', id: 'r:0', delta: long },
      { type: 'reasoning-delta', id: 'r:0', delta: '更多' },
      { type: 'reasoning-end', id: 'r:0' },
    ])
  ).toEqual([long])
})

test('INV-14 型号不认思考参数时往下退档重发、退到底不带思考参数，并在同一份运行时里记住；与思考无关的 400 原样交出', async () => {
  const efforts: unknown[] = []
  const chat = new ReasoningFallback().chatFetch({
    provider: 'openai-compatible-gateway',
    level: 'max',
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        reasoning_effort?: string
        messages: unknown[]
      }
      efforts.push(body.reasoning_effort ?? null)
      if (body.messages.length > 0)
        return Response.json(
          { error: { message: 'maximum context length exceeded' } },
          { status: 400 }
        )
      return body.reasoning_effort === 'xhigh'
        ? Response.json(
            { error: { message: "reasoning_effort does not support 'xhigh'" } },
            { status: 400 }
          )
        : Response.json({ ok: true })
    },
  })
  const send = (messages: unknown[]) =>
    chat('https://gateway.test/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.5', messages }),
    })

  expect((await send([])).status).toBe(200)
  expect((await send([])).status).toBe(200)
  expect((await send(['too long'])).status).toBe(400)
  expect(efforts).toEqual(['xhigh', 'high', 'high', 'high'])
})

test('INV-15 会话缓存键只发给认它的线路：OpenAI 官方与 OpenRouter 带 prompt_cache_key，Groq、Mistral、DeepSeek 不带', async () => {
  const composition = createModelRuntimeComposition({
    environment: {},
    providerScripts: { configPaths: [] },
  })
  const key = 'a'.repeat(32)
  const request: ModelTurnRequest = {
    instructions: 'spec',
    materials: [{ ref: 'view-1', origin: 'runtime-view', text: 'current view', totalChars: 12 }],
    response: { type: 'text' },
    mode: 'work',
    outputTokens: 100,
    cacheKey: key,
  }
  const bodies = new Map<string, Record<string, unknown>>()
  let provider = ''
  const originalFetch = globalThis.fetch
  // 夹具记下请求体就拒绝：只看出线的字段，不关心响应
  globalThis.fetch = (async (_input: unknown, init: { body?: unknown }) => {
    bodies.set(provider, JSON.parse(String(init.body)) as Record<string, unknown>)
    return Response.json(
      { error: { message: 'spec fixture rejects the request' } },
      { status: 400 }
    )
  }) as typeof fetch
  try {
    for (const [id, model] of [
      ['openai', 'gpt-5.5'],
      ['openrouter', 'openai/gpt-5.5'],
      ['groq', 'llama-3.3-70b-versatile'],
      ['mistral', 'mistral-large-latest'],
      ['deepseek', 'deepseek-chat'],
    ] as const) {
      provider = id
      const factory = composition.agentModelRuntime.createAgentProvider({
        provider: id,
        apiKey: 'sk-test',
        baseURL: '',
      })
      const driver = createAiSdkModelDriver({
        id,
        model: factory(model),
        limits: { contextTokens: 32_000, inputTokens: 30_000, outputTokens: 1_000 },
      })
      const deltas = []
      for await (const delta of driver.stream(request, new AbortController().signal))
        deltas.push(delta)
      expect(deltas.at(-1)).toMatchObject({ type: 'error' })
    }
  } finally {
    globalThis.fetch = originalFetch
  }
  expect([...bodies.keys()]).toEqual(['openai', 'openrouter', 'groq', 'mistral', 'deepseek'])
  expect(bodies.get('openai')?.prompt_cache_key).toBe(key)
  expect(bodies.get('openrouter')?.prompt_cache_key).toBe(key)
  for (const id of ['groq', 'mistral', 'deepseek'])
    expect(Object.hasOwn(bodies.get(id)!, 'prompt_cache_key')).toBe(false)
  for (const body of bodies.values()) expect(JSON.stringify(body)).not.toContain('velaros')
})
