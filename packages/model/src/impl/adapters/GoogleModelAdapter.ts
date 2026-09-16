import { createGoogleGenerativeAI } from '@ai-sdk/google'

import type { ModelProviderAdapter } from '../../contract/requires'
import type { LanguageModelFactory, ModelAdapterConfig } from '../../types/adapters'
import type { ChatProviderId } from '../../types/model'
import type { ModelProviderCollectionApi } from '../providers/ModelProviderCollection'

import { languageModelWrappers } from './LanguageModelWrappers'
import { ModelAdapter } from './ModelAdapter'

/** Google Generative AI provider 适配器。 */
class GoogleModelAdapter extends ModelAdapter implements ModelProviderAdapter {
  constructor(providerIds: readonly ChatProviderId[], providers: ModelProviderCollectionApi) {
    super(providerIds, providers)
  }

  /** 创建 Google AI SDK LanguageModel 工厂。 */
  public createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory {
    const google = createGoogleGenerativeAI({
      apiKey: this.requireApiKey(config),
      baseURL: this.resolveBaseURL(config),
    })

    return (modelId) =>
      languageModelWrappers.withPromptCache(
        languageModelWrappers.withThinkingDepth(
          google(modelId),
          config.provider,
          modelId,
          config.thinkingDepth,
          config.reasoningLevel
        )
      )
  }
}

export { GoogleModelAdapter }
