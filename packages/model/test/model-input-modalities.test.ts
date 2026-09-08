import { describe, expect, test } from 'bun:test'

import type { ChatProviderId } from '../src'
import { createModelRuntimeComposition } from '../src/node'

const ProviderId = 'test-input-modalities' as ChatProviderId
const HangingProviderId = 'test-hanging-runtime-metadata' as ChatProviderId

const ProviderSource = `
module.exports = {
  manifest: {
    id: '${ProviderId}',
    label: 'Input Modality Test',
    description: 'Input modality contract test provider.',
    defaultBaseURL: 'https://example.test/v1',
    defaultApiKey: '',
    apiKeyOptional: true,
    baseURLConfigurable: false,
    enabledByDefault: true,
    defaultModel: 'text-model',
    models: [
      { id: 'text-model', label: 'Text Model', inputModalities: ['text'] },
      { id: 'vision-model', label: 'Vision Model', inputModalities: ['text', 'image'] },
      { id: 'unknown-model', label: 'Unknown Model' }
    ]
  },
  resolveRuntimeMetadata({ model }) {
    return model === 'vision-model'
      ? { model, providerModel: model, inputModalities: ['text', 'image', 'invalid'] }
      : { model, providerModel: model }
  },
  createLanguageModelFactory() {
    return function createLanguageModel() { return {} }
  }
}
`

const HangingProviderSource = `
module.exports = {
  manifest: {
    id: '${HangingProviderId}',
    label: 'Hanging Runtime Metadata',
    description: 'Provider used to prove runtime metadata deadlines.',
    defaultBaseURL: 'https://example.test/v1',
    defaultApiKey: '',
    apiKeyOptional: true,
    baseURLConfigurable: false,
    enabledByDefault: true,
    defaultModel: 'hanging-model',
    models: [{ id: 'hanging-model', label: 'Hanging Model' }]
  },
  resolveRuntimeMetadata() {
    return new Promise(() => {})
  },
  createLanguageModelFactory() {
    return function createLanguageModel() { return {} }
  }
}
`

const HangingRuntimeContext = {
  providerRuntimeConfigs: [
    {
      provider: HangingProviderId,
      enabled: true,
      apiKey: '',
      baseURL: 'https://example.test/v1',
      defaultModel: 'hanging-model',
    },
  ],
  openRouter: { useFreeModelsForDebug: false },
}

const HangingSelection = {
  provider: HangingProviderId,
  model: 'hanging-model',
  apiKey: '',
  baseURL: 'https://example.test/v1',
}

describe('model input modalities', () => {
  test('honors explicit declarations and lets models with unknown capabilities attempt media', async () => {
    const composition = createModelRuntimeComposition({
      providerScripts: { configPaths: [] },
    })
    composition.providerScriptRegistry.registerSource({
      source: ProviderSource,
      scriptPath: '/tmp/velaros-model-input-modalities.cjs',
    })
    const runtimeContext = {
      providerRuntimeConfigs: [
        {
          provider: ProviderId,
          enabled: true,
          apiKey: '',
          baseURL: 'https://example.test/v1',
          defaultModel: 'text-model',
        },
      ],
      openRouter: { useFreeModelsForDebug: false },
    }
    const selection = (model: string) => ({
      provider: ProviderId,
      model,
      apiKey: '',
      baseURL: 'https://example.test/v1',
    })

    const textRuntime = await composition.agentModelResolver.resolve(
      selection('text-model'),
      runtimeContext
    )
    const visionRuntime = await composition.agentModelResolver.resolve(
      selection('vision-model'),
      runtimeContext
    )
    const unknownRuntime = await composition.agentModelResolver.resolve(
      selection('unknown-model'),
      runtimeContext
    )

    expect(textRuntime.supportedInputModalities).toEqual(['text'])
    expect(visionRuntime.supportedInputModalities).toEqual(['text', 'image'])
    expect(unknownRuntime.supportedInputModalities).toEqual(['text', 'image', 'audio'])
  })

  test('lets a generic OpenAI-compatible gateway attempt media for unknown models', async () => {
    const composition = createModelRuntimeComposition({
      providerScripts: { configPaths: [] },
      providerCatalog: { fetch: async () => Response.json({ data: [] }) },
    })
    const runtime = await composition.agentModelResolver.resolve(
      {
        provider: 'openai-compatible-gateway',
        model: 'gpt-5.6-sol',
        apiKey: 'test-key',
        baseURL: 'https://gateway.example.test/v1',
      },
      {
        providerRuntimeConfigs: [
          {
            provider: 'openai-compatible-gateway',
            enabled: true,
            apiKey: 'test-key',
            baseURL: 'https://gateway.example.test/v1',
            defaultModel: 'gpt-5.6-sol',
          },
        ],
        openRouter: { useFreeModelsForDebug: false },
      }
    )

    expect(runtime.supportedInputModalities).toEqual(['text', 'image', 'audio'])
  })

  test('bounds provider-script runtime metadata and continues with conservative capabilities', async () => {
    const composition = createModelRuntimeComposition({
      providerScripts: { configPaths: [], runtimeMetadataTimeoutMs: 25 },
    })
    composition.providerScriptRegistry.registerSource({
      source: HangingProviderSource,
      scriptPath: '/tmp/velaros-model-hanging-runtime-metadata.cjs',
    })

    const startedAt = Date.now()
    const runtime = await composition.agentModelResolver.resolve(
      HangingSelection,
      HangingRuntimeContext
    )

    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(runtime.supportedInputModalities).toEqual(['text', 'image', 'audio'])
    expect(runtime.fallbackReason).toContain('timed out after 25ms')
  })

  test('aborts provider-script runtime metadata immediately instead of waiting for its deadline', async () => {
    const composition = createModelRuntimeComposition({
      providerScripts: { configPaths: [], runtimeMetadataTimeoutMs: 10_000 },
    })
    composition.providerScriptRegistry.registerSource({
      source: HangingProviderSource,
      scriptPath: '/tmp/velaros-model-aborted-runtime-metadata.cjs',
    })
    const controller = new AbortController()
    const startedAt = Date.now()
    const resolution = composition.agentModelResolver.resolve(
      HangingSelection,
      HangingRuntimeContext,
      controller.signal
    )

    controller.abort(new Error('user stopped runtime metadata'))

    await expect(resolution).rejects.toThrow('user stopped runtime metadata')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })
})
