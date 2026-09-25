import { createOpenAI } from '@ai-sdk/openai'

import { isBlank } from '@velaros-ai/core'

import type { ModelProviderAdapter } from '../../contract/requires'
import type {
  EmbeddingRequest,
  LanguageModelFactory,
  ModelAdapterConfig,
} from '../../types/adapters'
import type { ChatProviderId } from '../../types/model'
import { isOpenRouterCompatibleProvider } from '../../utils/catalog/model-selection'
import { createOpenRouterFetch, normalizeOpenRouterRouting } from '../../utils/wire/openrouter'
import type { ModelProviderCollectionApi } from '../providers/ModelProviderCollection'

import { languageModelWrappers } from './LanguageModelWrappers'
import { ModelAdapter } from './ModelAdapter'

/**
 * OpenAI / OpenRouter 模型适配器。
 *
 * 普通 OpenAI 直接创建 openai(modelId)；OpenRouter 需要额外在 fetch 中注入
 * auto-router 插件和 provider 偏好，因此单独做 routing 归一化。
 */
class OpenAIModelAdapter extends ModelAdapter implements ModelProviderAdapter {
  constructor(providerIds: readonly ChatProviderId[], providers: ModelProviderCollectionApi) {
    super(providerIds, providers)
  }

  /** 创建 AI SDK LanguageModel 工厂。 */
  public createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory {
    const apiKey = this.requireApiKey(config)
    const baseURL = this.resolveBaseURL(config)

    return (modelId, options) => {
      if (!isOpenRouterCompatibleProvider(config.provider)) {
        const openai = createOpenAI({
          apiKey,
          baseURL,
        })

        return languageModelWrappers.withPromptCache(
          languageModelWrappers.withReasoning(
            openai(modelId),
            config.provider,
            modelId,
            config.reasoningLevel
          )
        )
      }

      const routing = normalizeOpenRouterRouting(modelId, options, config)
      const openrouter = createOpenAI({
        apiKey,
        baseURL,
        name: config.provider,
        fetch: createOpenRouterFetch(routing),
      })

      return languageModelWrappers.withPromptCache(openrouter.chat(routing.model))
    }
  }

  /** OpenAI/OpenRouter embedding 请求。 */
  public createEmbeddingRequest(
    config: ModelAdapterConfig,
    model: string,
    texts: string[]
  ): EmbeddingRequest {
    const apiKey = this.requireApiKey(config)
    return {
      url: `${this.resolveBaseURL(config)}/embeddings`,
      headers: isBlank(apiKey) ? {} : { Authorization: `Bearer ${apiKey}` },
      body: {
        model,
        input: texts,
      },
    }
  }
}

export { OpenAIModelAdapter }
