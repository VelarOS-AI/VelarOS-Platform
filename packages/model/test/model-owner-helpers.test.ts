import { describe, expect, test } from 'bun:test'

import {
  type ChatProviderId,
  filterEmbeddingModelCandidates,
  findProviderRuntimeConfig,
  getFirstConfiguredProviderRuntimeConfig,
  isModelProviderEmbeddingCapable,
  isProviderRuntimeConfigured,
  ModelProviderCollection,
  normalizeProviderRuntimeConfigs,
  resolveAutoEmbeddingSelection,
  resolveDefaultEmbeddingModelForProvider,
  selectEmbeddingModelCandidate,
} from '../src'
import { createModelRuntimeComposition } from '../src/node'

const InjectedEmbeddingProviderId = 'test-embedding-provider' as ChatProviderId

const InjectedEmbeddingProviderSource = `
module.exports = {
  manifest: {
    id: '${InjectedEmbeddingProviderId}',
    label: 'Injected Embedding Provider',
    description: 'Provider used to prove embedding helper isolation.',
    defaultBaseURL: 'https://example.test/v1',
    defaultApiKey: '',
    apiKeyOptional: true,
    baseURLConfigurable: false,
    enabledByDefault: true,
    defaultModel: 'example-chat',
    embeddingModel: 'example-embed-v1',
    models: [
      { id: 'example-chat', label: 'Example Chat' },
      { id: 'example-embed-v1', label: 'Example Embed' }
    ]
  },
  createLanguageModelFactory() {
    return function createLanguageModel() {
      return {}
    }
  },
  createEmbeddingRequest() {
    return Promise.resolve([])
  }
}
`

function createIsolatedComposition() {
  return createModelRuntimeComposition({
    providerScripts: { configPaths: [] },
  })
}

describe('Model-owned embedding selection helpers', () => {
  test('selects, filters, and falls back to Model-owned embedding models', () => {
    const { providerCollection } = createIsolatedComposition()

    expect(
      selectEmbeddingModelCandidate([
        'chat-model',
        'nomic-embed-text',
        'text-embedding-3-small',
        'text-embedding-3-large',
      ]),
    ).toBe('text-embedding-3-large')
    expect(
      filterEmbeddingModelCandidates([
        ' chat-model ',
        ' text-embedding-3-large ',
        'text-embedding-3-large',
        'bge-m3',
        '',
      ]),
    ).toEqual(['text-embedding-3-large', 'bge-m3'])
    expect(
      resolveDefaultEmbeddingModelForProvider(providerCollection, 'openai'),
    ).toBe('text-embedding-3-large')
    expect(
      resolveAutoEmbeddingSelection(providerCollection, {
        provider: 'openai',
        candidateModels: ['chat-model'],
      }),
    ).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-large',
    })
    expect(isModelProviderEmbeddingCapable(providerCollection, 'openai')).toBe(true)
    expect(isModelProviderEmbeddingCapable(providerCollection, 'anthropic')).toBe(false)
  })

  test('keeps injected embedding manifests isolated to their composition', () => {
    const first = createIsolatedComposition()
    const second = createIsolatedComposition()

    first.providerScriptRegistry.registerSource({
      source: InjectedEmbeddingProviderSource,
      scriptPath: '/tmp/velaros-model-owner-embedding-provider.cjs',
    })

    expect(
      resolveDefaultEmbeddingModelForProvider(
        first.providerCollection,
        InjectedEmbeddingProviderId,
      ),
    ).toBe('example-embed-v1')
    expect(
      isModelProviderEmbeddingCapable(
        first.providerCollection,
        InjectedEmbeddingProviderId,
      ),
    ).toBe(true)
    expect(() =>
      resolveDefaultEmbeddingModelForProvider(
        second.providerCollection,
        InjectedEmbeddingProviderId,
      ),
    ).toThrow(`未知模型 provider：${InjectedEmbeddingProviderId}`)
  })
})

describe('Model-owned provider runtime availability helpers', () => {
  test('normalizes and resolves through an explicitly injected provider collection', () => {
    const { providerCollection } = createIsolatedComposition()
    const configuredOpenAI = {
      provider: 'openai' as const,
      enabled: true,
      apiKey: '',
      baseURL: '',
      defaultModel: 'gpt-5.5',
    }
    const runtimeConfigs = [configuredOpenAI]
    const normalized = normalizeProviderRuntimeConfigs(
      providerCollection,
      runtimeConfigs,
    )

    expect(normalized.length).toBeGreaterThan(runtimeConfigs.length)
    expect(
      findProviderRuntimeConfig(providerCollection, runtimeConfigs, 'openai'),
    ).toEqual({
      ...providerCollection.getDefaultRuntimeConfig('openai'),
      ...configuredOpenAI,
    })
    expect(
      isProviderRuntimeConfigured(providerCollection, {
        runtimeConfig: configuredOpenAI,
        providerRuntimeConfigs: runtimeConfigs,
        env: { OPENAI_API_KEY: 'from-environment' },
      }),
    ).toBe(true)
    expect(
      isProviderRuntimeConfigured(providerCollection, {
        runtimeConfig: configuredOpenAI,
        providerRuntimeConfigs: runtimeConfigs,
        env: {},
      }),
    ).toBe(false)
  })

  test('finds the first configured provider without crossing the support boundary', () => {
    const { providerCollection } = createIsolatedComposition()
    const runtimeConfigs = [
      {
        provider: 'anthropic' as const,
        enabled: true,
        apiKey: 'anthropic-key',
        baseURL: '',
        defaultModel: 'claude-sonnet-4-6',
      },
      {
        provider: 'openai' as const,
        enabled: true,
        apiKey: 'openai-key',
        baseURL: '',
        defaultModel: 'gpt-5.5',
      },
    ]

    expect(
      getFirstConfiguredProviderRuntimeConfig(
        providerCollection,
        runtimeConfigs,
        {
          env: {},
          supportsProvider: (provider) => provider === 'openai',
        },
      )?.provider,
    ).toBe('openai')
  })
})

describe('portable provider environment boundary', () => {
  test('reads only environment values explicitly injected by the host', () => {
    const registry = createIsolatedComposition().providerScriptRegistry
    const previousApiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'process-global-secret'

    try {
      const portableProviders = new ModelProviderCollection(registry)
      const injectedProviders = new ModelProviderCollection(registry, {
        environment: { OPENAI_API_KEY: 'host-injected-secret' },
      })

      expect(
        portableProviders.resolveApiKey({ provider: 'openai', apiKey: '' }),
      ).toBe('')
      expect(
        injectedProviders.resolveApiKey({ provider: 'openai', apiKey: '' }),
      ).toBe('host-injected-secret')
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = previousApiKey
      }
    }
  })
})
