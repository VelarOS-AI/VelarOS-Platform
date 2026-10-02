import { createAnthropic } from '@ai-sdk/anthropic'

import type { ModelProviderAdapter } from '../../contract/requires'
import type { LanguageModelFactory, ModelAdapterConfig } from '../../types/adapters'
import type { ChatProviderId } from '../../types/model'
import { ModelPromptCacheProtocolLimits } from '../../utils/tuning'
import type { ModelProviderCollectionApi } from '../providers/ModelProviderCollection'

import { languageModelWrappers } from './LanguageModelWrappers'
import { ModelAdapter } from './ModelAdapter'

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
      languageModelWrappers.withPromptCache(
        languageModelWrappers.withReasoning(
          anthropic(modelId),
          config.provider,
          modelId,
          config.reasoningLevel,
          this.reasoningFallback
        ),
        {
          sessionKey: false,
          anthropicBreakpointLimit: ModelPromptCacheProtocolLimits.anthropicBreakpoints,
        }
      )
  }
}

export { AnthropicModelAdapter }
