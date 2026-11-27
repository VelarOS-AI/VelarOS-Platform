import { describe, expect, test } from 'bun:test'

import type { ChatProviderId, ModelRuntimeCompositionApi } from '../src/index'
import { createModelRequestClient, createModelRuntimeComposition } from '../src/index'

const IsolatedProviderId = 'test-isolated-provider' as ChatProviderId

const IsolatedProviderSource = `
module.exports = {
  manifest: {
    id: '${IsolatedProviderId}',
    label: 'Isolated Provider',
    description: 'Provider used to prove composition isolation.',
    defaultBaseURL: '',
    defaultApiKey: '',
    apiKeyOptional: true,
    baseURLConfigurable: false,
    enabledByDefault: true,
    defaultModel: 'isolation-model',
    models: [{ id: 'isolation-model', label: 'Isolation Model' }]
  },
  createLanguageModelFactory() {
    return function createLanguageModel() {
      return {}
    }
  }
}
`

describe('model runtime composition', () => {
  test('owns isolated provider, adapter, resolver, and agent runtime instances', () => {
    const first = createModelRuntimeComposition({
      providerScripts: { configPaths: [] },
    })
    const second = createModelRuntimeComposition({
      providerScripts: { configPaths: [] },
    })

    expect(Object.isFrozen(first)).toBe(true)
    expect(typeof first.providerCollection.listPresets).toBe('function')
    expect(first).not.toBe(second)
    expect(first.providerScriptRegistry).not.toBe(second.providerScriptRegistry)
    expect(first.providerCollection).not.toBe(second.providerCollection)
    expect(first.velarCloudRuntime).not.toBe(second.velarCloudRuntime)
    expect(first.modelAdapterRegistry).not.toBe(second.modelAdapterRegistry)
    expect(first.agentModelResolver).not.toBe(second.agentModelResolver)
    expect(first.agentModelRuntime).not.toBe(second.agentModelRuntime)

    first.providerScriptRegistry.registerSource({
      source: IsolatedProviderSource,
      scriptPath: '/tmp/velaros-model-isolated-provider.cjs',
    })

    expect(first.providerScriptRegistry.supportsProvider(IsolatedProviderId)).toBe(true)
    expect(second.providerScriptRegistry.supportsProvider(IsolatedProviderId)).toBe(false)
    expect(first.providerCollection.requireOperationalManifest(IsolatedProviderId).id).toBe(
      IsolatedProviderId
    )
    expect(() => second.providerCollection.requireOperationalManifest(IsolatedProviderId)).toThrow(
      `未知模型 provider：${IsolatedProviderId}`
    )
    expect(first.modelAdapterRegistry.supportsProvider(IsolatedProviderId)).toBe(true)
    expect(second.modelAdapterRegistry.supportsProvider(IsolatedProviderId)).toBe(false)

    expect(
      first.agentModelRuntime.createAgentProvider({
        provider: IsolatedProviderId,
        apiKey: '',
        baseURL: '',
      })
    ).toBeInstanceOf(Function)
    expect(() =>
      second.agentModelRuntime.createAgentProvider({
        provider: IsolatedProviderId,
        apiKey: '',
        baseURL: '',
      })
    ).toThrow(`未找到 provider 适配器：${IsolatedProviderId}`)
  })

  test('工厂交出的对象图是冻结的接口面，成员按接口取到的就是同一份实例', () => {
    const concrete = createModelRuntimeComposition({
      providerScripts: { configPaths: [] },
    })
    const composition: ModelRuntimeCompositionApi = concrete

    // 冻结只保护对象图引用不被替换；每个子运行时仍按自身 API 管理状态。
    expect(Object.isFrozen(concrete)).toBe(true)
    expect(typeof concrete.providerCollection.listPresets).toBe('function')
    expect(composition.providerCollection).toBe(concrete.providerCollection)
    expect(composition.velarCloudRuntime).toBe(concrete.velarCloudRuntime)
    expect(composition.providerModelCatalogService).toBe(concrete.providerModelCatalogService)
  })

  test('requires explicit provider selection instead of using a global default', () => {
    const composition = createModelRuntimeComposition({
      providerScripts: { configPaths: [] },
    })

    expect(() =>
      composition.agentModelRuntime.createAgentProvider({
        apiKey: '',
        baseURL: '',
      })
    ).toThrow('模型 selection.provider 必须显式提供。')
  })

  test('routes inference, validation and model discovery by provider on the same gateway', async () => {
    const calls: string[] = []
    const request = { baseURL: 'https://gateway.example/v1', apiKey: 'test-key' }
    const response = { data: [{ id: 'gpt-5.4' }] }
    const logFetch = (route: string): typeof globalThis.fetch =>
      Object.assign(
        async (input: Parameters<typeof globalThis.fetch>[0]): Promise<Response> => {
          calls.push(`${route} ${String(input)}`)
          if (String(input).endsWith('/models')) return Response.json(response)
          return Response.json({ error: { message: 'test stop' } }, { status: 400 })
        },
        { preconnect: globalThis.fetch.preconnect }
      )
    const responsesFetch = logFetch('responses')
    const composition = createModelRuntimeComposition({
      providerScripts: { configPaths: [] },
      fetch: logFetch('default'),
      providerCatalog: { fetch: logFetch('catalog') },
      fetchForProvider: (provider) =>
        provider === 'openai-responses' ? responsesFetch : undefined,
    })
    const client = createModelRequestClient()
    for (const provider of ['openai-responses', 'openai-compatible-gateway'] as const) {
      const selection = { ...request, provider }
      expect(
        await composition.providerModelCatalogService.validateProviderRuntime(selection)
      ).toEqual({
        ok: true,
        message: null,
      })
      const catalog = await composition.providerModelCatalogService.listProviderModels(selection)
      expect(catalog.models.map((model) => model.id)).toEqual(['gpt-5.4'])
      const model = composition.agentModelRuntime.createAgentProvider(selection)('gpt-5.4')
      await expect(
        client.generateText({ endpoint: 'test.scoped-fetch', model, prompt: 'ping' })
      ).rejects.toThrow('test stop')
    }
    expect(calls).toEqual([
      'responses https://gateway.example/v1/models',
      'responses https://gateway.example/v1/models',
      'responses https://gateway.example/v1/responses',
      'catalog https://gateway.example/v1/models',
      'catalog https://gateway.example/v1/models',
      'default https://gateway.example/v1/chat/completions',
    ])
  })

  test('requires an explicitly injected model runtime context', async () => {
    const composition = createModelRuntimeComposition({
      providerScripts: { configPaths: [] },
    })

    await expect(
      composition.agentModelRuntime.resolveRoleRuntime({
        provider: 'openai',
        model: 'gpt-5.5',
        apiKey: 'test-key',
        baseURL: '',
      })
    ).rejects.toThrow('Model Runtime context 必须显式提供。')
  })

  test('never crosses provider boundaries when the selected provider is unavailable', async () => {
    const composition = createModelRuntimeComposition({
      providerScripts: { configPaths: [] },
    })

    await expect(
      composition.agentModelRuntime.resolveRoleRuntime(
        {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          apiKey: '',
          baseURL: '',
        },
        {
          providerRuntimeConfigs: [
            {
              provider: 'anthropic',
              enabled: false,
              apiKey: '',
              baseURL: '',
              defaultModel: 'claude-sonnet-4-6',
            },
            {
              provider: 'openai',
              enabled: true,
              apiKey: 'configured-but-must-not-be-used',
              baseURL: 'https://api.openai.com/v1',
              defaultModel: 'gpt-5.5',
            },
          ],
          openRouter: { useFreeModelsForDebug: false },
        }
      )
    ).rejects.toThrow('当前 provider anthropic 不可用')
  })
})
