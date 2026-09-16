/**
 * model 域的不变量验收：`spec/invariants.md` 里每一条「测试」档的检验器。
 * 用例名以 INV-<编号> 开头，`check:module-ownership` 按这个前缀核对登记表与实现对得上。
 */
import { describe, expect, test } from 'bun:test'

import type { KernelModuleActivateContext } from '@velaros-ai/kernel'
import type { CapabilityToken } from '@velaros-ai/kernel/contracts'

import {
  type ChatProviderId,
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
      registered: TService,
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
        const fellBackWithinProvider = ownModels.includes(resolution.model)
          || resolution.model === foreignModel
        expect(`${manifest.id}/${foreignModel}:${keptRequested || fellBackWithinProvider}`).toBe(
          `${manifest.id}/${foreignModel}:true`,
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
    expect(first.velarCloudRuntime.hasProvider('velar')).toBe(false)
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
    expect(await invokeFailureCode('supports_provider', { provider: 'openai', extra: 1 }))
      .toBe('VALIDATION')
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
