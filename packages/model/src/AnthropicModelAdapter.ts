import { createAnthropic } from '@ai-sdk/anthropic'

import type { LanguageModelFactory, ModelAdapterConfig } from './ModelAdapter'
import { ModelAdapter } from './ModelAdapter'
import type { ChatProviderId } from './ModelContracts'
import type { ModelProviderCollection } from './ModelProviderCollection'
import { applyPromptCacheProviderOptions } from './PromptCacheModelOptions'
import { applyThinkingDepthProviderOptions } from './ThinkingDepthModelOptions'

/** Anthropic provider 适配器。 */
class AnthropicModelAdapter extends ModelAdapter {
  constructor(providerIds: readonly ChatProviderId[], providers: ModelProviderCollection) {
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
          config.thinkingDepth
        )
      )
  }
}

export { AnthropicModelAdapter }
