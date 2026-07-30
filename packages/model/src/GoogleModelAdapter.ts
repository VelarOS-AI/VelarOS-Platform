import { createGoogleGenerativeAI } from '@ai-sdk/google'

import type { LanguageModelFactory, ModelAdapterConfig } from './ModelAdapter'
import { ModelAdapter } from './ModelAdapter'
import type { ChatProviderId } from './ModelContracts'
import type { ModelProviderCollection } from './ModelProviderCollection'
import { applyPromptCacheProviderOptions } from './PromptCacheModelOptions'
import { applyThinkingDepthProviderOptions } from './ThinkingDepthModelOptions'

/** Google Generative AI provider 适配器。 */
class GoogleModelAdapter extends ModelAdapter {
  constructor(providerIds: readonly ChatProviderId[], providers: ModelProviderCollection) {
    super(providerIds, providers)
  }

  /** 创建 Google AI SDK LanguageModel 工厂。 */
  public createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory {
    const google = createGoogleGenerativeAI({
      apiKey: this.requireApiKey(config),
      baseURL: this.resolveBaseURL(config),
    })

    return (modelId) =>
      applyPromptCacheProviderOptions(
        applyThinkingDepthProviderOptions(
          google(modelId),
          config.provider,
          modelId,
          config.thinkingDepth
        )
      )
  }
}

export { GoogleModelAdapter }
