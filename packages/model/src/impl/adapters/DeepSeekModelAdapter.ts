import { createOpenAI } from '@ai-sdk/openai'

import { DefaultReasoningLevel } from '../../contract/constants.js'
import type { ModelProviderAdapter } from '../../contract/requires'
import type { LanguageModelFactory, ModelAdapterConfig } from '../../types/adapters'
import type { ChatProviderId } from '../../types/model'
import type { ModelProviderCollectionApi } from '../providers/ModelProviderCollection'

import { languageModelWrappers } from './LanguageModelWrappers'
import { ModelAdapter } from './ModelAdapter'

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
      // 思考参数写进请求体，型号不认就退档重发（见 ReasoningFallback）。
      fetch: this.reasoningFallback.chatFetch({
        provider: config.provider,
        level: config.reasoningLevel ?? DefaultReasoningLevel,
      }),
    })

    return (modelId) => languageModelWrappers.withPromptCache(deepseek.chat(modelId))
  }
}

export { DeepSeekModelAdapter }
