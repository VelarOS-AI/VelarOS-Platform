import { createOpenAI } from '@ai-sdk/openai'

import { isBlank } from '@velaros-ai/core'

import { OllamaProviderId } from '../../contract/constants.js'
import type { ModelProviderAdapter } from '../../contract/requires'
import type {
  EmbeddingRequest,
  LanguageModelFactory,
  ModelAdapterConfig,
  OpenAIModelFetch,
  OpenAIModelFetchInit,
} from '../../types/adapters'
import type { ChatProviderId } from '../../types/model'
import {
  injectOllamaContextWindow,
  isChatCompletionsRequest,
  stripBlankAuthorization,
} from '../../utils/wire/fetch-shims'
import type { LocalModelEnvironmentApi } from '../providers/LocalModelEnvironment'
import { LocalModelEnvironment } from '../providers/LocalModelEnvironment'
import type { ModelProviderCollectionApi } from '../providers/ModelProviderCollection'

import { languageModelWrappers } from './LanguageModelWrappers'
import { ModelAdapter } from './ModelAdapter'

/**
 * 兼容开放接口的模型供应方适配器。
 *
 * 用于直连兼容聊天补全接口的供应方；
 * 某些本地或私有供应方的密钥可选，因此需要处理空授权头。
 */
class OpenAICompatibleModelAdapter extends ModelAdapter implements ModelProviderAdapter {
  constructor(
    providerIds: readonly ChatProviderId[],
    providers: ModelProviderCollectionApi,
    private readonly localModelEnvironment: LocalModelEnvironmentApi = new LocalModelEnvironment()
  ) {
    super(providerIds, providers)
  }

  /** 创建兼容 provider 的 chat model 工厂。 */
  public createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory {
    const apiKey = this.requireApiKey(config)
    const compatible = createOpenAI({
      apiKey,
      baseURL: this.resolveBaseURL(config),
      name: config.provider,
      fetch: this.createCompatibleFetch(config.provider, apiKey),
    })

    return (modelId) => languageModelWrappers.withPromptCache(compatible.chat(modelId))
  }

  /** 兼容 OpenAI embeddings endpoint 的 embedding 请求。 */
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

  /** 本地 OpenAI-compatible provider 需要在 SDK 请求前做少量 body/header 兼容。 */
  private createCompatibleFetch(
    provider: ChatProviderId,
    apiKey: string
  ): OpenAIModelFetch | undefined {
    const shouldStripBlankAuth = isBlank(apiKey)
    const shouldInjectOllamaContext =
      provider === OllamaProviderId &&
      Boolean(this.localModelEnvironment.resolveOllamaContextWindow())

    if (!shouldStripBlankAuth && !shouldInjectOllamaContext) return undefined

    return async (input, init) => {
      let nextInit = shouldStripBlankAuth ? stripBlankAuthorization(init) : init
      nextInit = shouldInjectOllamaContext
        ? this.injectOllamaContextOptions(input, nextInit)
        : nextInit

      return globalThis.fetch(input, nextInit || undefined)
    }
  }

  /** Ollama 的 OpenAI endpoint 认原生的 `options.num_ctx`，经环境变量配出来。 */
  private injectOllamaContextOptions(
    input: Parameters<OpenAIModelFetch>[0],
    init: Optional<OpenAIModelFetchInit>
  ): OpenAIModelFetchInit | undefined {
    const contextWindow = this.localModelEnvironment.resolveOllamaContextWindow()
    if (!contextWindow || !isChatCompletionsRequest(input)) return init

    return injectOllamaContextWindow(init, contextWindow)
  }
}

export { OpenAICompatibleModelAdapter }
