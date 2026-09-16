import { createOpenAI } from '@ai-sdk/openai'

import type { ModelProviderAdapter } from '../../contract/requires'
import type { LanguageModelFactory, ModelAdapterConfig } from '../../types/adapters'
import type { ChatProviderId } from '../../types/model'
import type { ModelProviderCollectionApi } from '../providers/ModelProviderCollection'

import { ModelAdapter } from './ModelAdapter'
import { applyPromptCacheProviderOptions } from './PromptCacheLanguageModel'

/** DeepSeek 适配器，复用 OpenAI-compatible AI SDK provider。 */
class DeepSeekModelAdapter extends ModelAdapter implements ModelProviderAdapter {
  constructor(providerIds: readonly ChatProviderId[], providers: ModelProviderCollectionApi) {
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
