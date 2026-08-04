import { describe, expect, test } from 'bun:test'

import type { ChatProviderId } from '../src'
import { createModelRuntimeComposition } from '../src/node'

const ProviderId = 'test-input-modalities' as ChatProviderId

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
      { id: 'text-model', label: 'Text Model' },
      { id: 'vision-model', label: 'Vision Model', inputModalities: ['text', 'image'] }
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

describe('model input modalities', () => {
  test('normalizes provider declarations and fails unknown capability closed to text', async () => {
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

    expect(textRuntime.supportedInputModalities).toEqual(['text'])
    expect(visionRuntime.supportedInputModalities).toEqual(['text', 'image'])
  })
})
