import { createOpenAI } from '@ai-sdk/openai'

import { isBlank } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ModelErrorCodes, VelarCloudManagedProviderIds } from '../../contract/constants.js'
import type { ModelProviderAdapter } from '../../contract/requires'
import type {
  EmbeddingRequest,
  LanguageModelFactory,
  ModelAdapterConfig,
} from '../../types/adapters'
import { requireVelarCloudManagedProviderId } from '../../utils/catalog/manifests'
import { postVelarEmbedding } from '../../utils/wire/fetch-shims'
import { injectVelarThinkingRouting } from '../../utils/wire/reasoning'
import type { ModelProviderCollectionApi } from '../providers/ModelProviderCollection'
import type { VelarCloudModelRuntimeLookup } from '../providers/VelarCloudModelRuntime'

import { languageModelWrappers } from './LanguageModelWrappers'
import { ModelAdapter } from './ModelAdapter'

/** Velar Cloud 托管 provider 的适配器；聊天与 embedding 都必须走宿主注入的带认证 fetch。 */
export class VelarModelAdapter extends ModelAdapter implements ModelProviderAdapter {
  constructor(
    providers: ModelProviderCollectionApi,
    private readonly cloudRuntime: VelarCloudModelRuntimeLookup
  ) {
    super(VelarCloudManagedProviderIds, providers)
  }

  public createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory {
    const providerId = requireVelarCloudManagedProviderId(config.provider)
    const runtime = this.cloudRuntime.require(providerId)
    const provider = createOpenAI({
      apiKey: providerId === 'velar-dev' ? 'velar-dev-managed' : 'velar-managed',
      baseURL: runtime.baseURL,
      name: providerId,
      fetch: (input, init) =>
        runtime.fetch(
          input,
          providerId === 'velaros' ? injectVelarThinkingRouting(init, config.reasoningLevel) : init
        ),
    })
    return (modelId) => {
      if (providerId === 'velaros' && isBlank(modelId))
        return languageModelWrappers.withPromptCache(provider.chat('velaros/auto'))
      if (isBlank(modelId)) {
        throw new AppError('VALIDATION', 'Velar Dev 模型必须由 Cloud 动态目录显式选择。')
      }

      // Cloud 下发的公共模型 ID 是不透明契约，Platform 不加前缀、不拆分也不规范化。
      return languageModelWrappers.withPromptCache(provider.chat(modelId))
    }
  }

  public createEmbeddingRequest(
    config: ModelAdapterConfig,
    _model: string,
    texts: string[]
  ): EmbeddingRequest {
    const providerId = requireVelarCloudManagedProviderId(config.provider)
    if (providerId === 'velar-dev') {
      throw new AppError(
        ModelErrorCodes.embeddingUnsupported,
        'Velar Dev 当前只提供聊天模型，不支持 embedding。'
      )
    }

    const runtime = this.cloudRuntime.require('velaros')
    const url = `${runtime.baseURL}/embeddings`
    const headers = { Authorization: 'Bearer velar-managed' }
    const body = {
      model: 'velaros/embedding',
      input: texts,
    }

    return {
      url,
      headers,
      body,
      // 必须走宿主注入的 fetch：账户认证是宿主在这个 fetch 里挂的，
      // 请求头里的 `velar-managed` 只是占位（与聊天链路同一个占位），
      // 消费方自己用普通 HTTP 客户端发出去就是一条没有身份的请求。
      execute: () => postVelarEmbedding(runtime.fetch, url, headers, body),
    }
  }
}
