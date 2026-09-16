import { createAnthropic } from '@ai-sdk/anthropic'

import type { ModelProviderAdapter } from '../../contract/requires'
import type { LanguageModelFactory, ModelAdapterConfig } from '../../types/adapters'
import type { ChatProviderId } from '../../types/model'
import type { ModelProviderCollectionApi } from '../providers/ModelProviderCollection'

import { ModelAdapter } from './ModelAdapter'
import { applyPromptCacheProviderOptions } from './PromptCacheLanguageModel'
import { applyThinkingDepthProviderOptions } from './ThinkingDepthLanguageModel'

/** Anthropic provider 适配器。 */
class AnthropicModelAdapter extends ModelAdapter implements ModelProviderAdapter {
  constructor(providerIds: readonly ChatProviderId[], providers: ModelProviderCollectionApi) {
    super(providerIds, providers)
  }

  /** 创建 Anthropic AI SDK LanguageModel 工厂。 */
  public createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory {
    const anthropic = createAnthropic({
      apiKey: this.requireApiKey(config),
      baseURL: this.resolveBaseURL(config),
    })

    return (modelId) =>
      applyPromptCacheProviderOptions(
        applyThinkingDepthProviderOptions(
          anthropic(modelId),
          config.provider,
          modelId,
          config.thinkingDepth,
          config.reasoningLevel
        )
      )
  }
}

export { AnthropicModelAdapter }
