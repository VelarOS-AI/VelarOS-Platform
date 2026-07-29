import { describe, expect, test } from 'bun:test'

import {
  type ChatProviderId,
} from '../src'
import {
  createModelRuntimeComposition,
  DefaultModelRuntimeComposition,
  ModelRuntimeComposition,
} from '../src/node'

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
    expect(first).toBeInstanceOf(DefaultModelRuntimeComposition)
    expect(first).not.toBe(second)
    expect(first.providerScriptRegistry).not.toBe(second.providerScriptRegistry)
    expect(first.providerCollection).not.toBe(second.providerCollection)
    expect(first.velarCloudRuntime).not.toBe(second.velarCloudRuntime)
    expect(first.modelAdapterRegistry).not.toBe(second.modelAdapterRegistry)
    expect(first.agentModelResolver).not.toBe(second.agentModelResolver)
    expect(first.agentModelRuntime).not.toBe(second.agentModelRuntime)

    first.providerScriptRegistry.registerSource({
      source: IsolatedProviderSource,
      scriptPath: '/tmp/velaros-model-runtime-isolated-provider.cjs',
    })

    expect(first.providerScriptRegistry.supportsProvider(IsolatedProviderId)).toBe(true)
    expect(second.providerScriptRegistry.supportsProvider(IsolatedProviderId)).toBe(false)
    expect(first.providerCollection.requireOperationalManifest(IsolatedProviderId).id).toBe(
      IsolatedProviderId
    )
    expect(() =>
      second.providerCollection.requireOperationalManifest(IsolatedProviderId)
    ).toThrow(`未知模型 provider：${IsolatedProviderId}`)
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

  test('keeps the public interface and constructor value compatible', () => {
    const concrete = new ModelRuntimeComposition({
      providerScripts: { configPaths: [] },
    })
    const composition: ModelRuntimeComposition = {
      providerScriptRegistry: concrete.providerScriptRegistry,
      localModelEnvironment: concrete.localModelEnvironment,
      providerCollection: concrete.providerCollection,
      velarCloudRuntime: concrete.velarCloudRuntime,
      modelAdapterRegistry: concrete.modelAdapterRegistry,
      agentModelResolver: concrete.agentModelResolver,
      agentModelRuntime: concrete.agentModelRuntime,
    }

    expect(concrete).toBeInstanceOf(DefaultModelRuntimeComposition)
    expect(Object.isFrozen(concrete)).toBe(false)
    expect(composition.providerCollection).toBe(concrete.providerCollection)
    expect(composition.velarCloudRuntime).toBe(concrete.velarCloudRuntime)
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
