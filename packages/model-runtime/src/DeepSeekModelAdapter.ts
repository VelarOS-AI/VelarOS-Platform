import { createOpenAI } from '@ai-sdk/openai'

import type { ChatProviderId } from './ModelContracts'

import type { LanguageModelFactory, ModelAdapterConfig } from './ModelAdapter'
import { ModelAdapter } from './ModelAdapter'
import type { ModelProviderCollection } from './ModelProviderCollection'
import { applyPromptCacheProviderOptions } from './PromptCacheModelOptions'

/** DeepSeek 适配器，复用 OpenAI-compatible AI SDK provider。 */
class DeepSeekModelAdapter extends ModelAdapter {
  constructor(providerIds: readonly ChatProviderId[], providers: ModelProviderCollection) {
    super(providerIds, providers)
  }

  /** 创建 DeepSeek chat model 工厂。 */
  public createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory {
    const deepseek = createOpenAI({
      apiKey: this.requireApiKey(config),
      baseURL: this.resolveBaseURL(config),
      name: 'deepseek',
    })

    return (modelId) => applyPromptCacheProviderOptions(deepseek.chat(modelId))
  }
}

export { DeepSeekModelAdapter }
