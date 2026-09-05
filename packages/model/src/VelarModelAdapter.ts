import { createOpenAI } from '@ai-sdk/openai'

import { isBlank, isPlainObject, isString, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { EmbeddingRequest, LanguageModelFactory, ModelAdapterConfig } from './ModelAdapter'
import { ModelAdapter } from './ModelAdapter'
import type { ChatProviderId, ReasoningLevel, ThinkingDepth } from './ModelContracts'
import type { ModelProviderCollection } from './ModelProviderCollection'
import { applyPromptCacheProviderOptions } from './PromptCacheModelOptions'
import { mergeOpenRouterReasoning } from './ThinkingDepthModelOptions'
import {
  isVelarCloudManagedProviderId,
  type VelarCloudManagedProviderId,
  VelarCloudManagedProviderIds,
  type VelarCloudModelRuntime,
} from './VelarCloudModelRuntime'

type VelarFetchInit = Parameters<typeof fetch>[1]

function injectVelarThinkingRouting(
  init: VelarFetchInit,
  thinkingDepth?: LooseOptional<ThinkingDepth>,
  reasoningLevel?: LooseOptional<ReasoningLevel>
): VelarFetchInit {
  if (!thinkingDepth && !reasoningLevel) return init
  if (!isString(init?.body)) return init

  try {
    const body = JSON.parse(init.body)
    if (!isPlainObject(body)) return init

    return {
      ...init,
      body: JSON.stringify({
        ...body,
        reasoning: mergeOpenRouterReasoning(body.reasoning, thinkingDepth, reasoningLevel),
      }),
    }
  } catch (error) {
    // 注入失败一律保留原始请求体：宁可这一轮不带 reasoning，也不能让路由参数把请求打坏（§2.4）。
    Log.tag('VelarModelAdapter').debug('注入 Velar reasoning 路由失败，保留原始请求体', { error })
    return init
  }
}

export class VelarModelAdapter extends ModelAdapter {
  constructor(
    providers: ModelProviderCollection,
    private readonly cloudRuntime: VelarCloudModelRuntime
  ) {
    super(VelarCloudManagedProviderIds, providers)
  }

  public createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory {
    const providerId = this.requireManagedProviderId(config.provider)
    const runtime = this.cloudRuntime.require(providerId)
    const provider = createOpenAI({
      apiKey: providerId === 'velar-dev' ? 'velar-dev-managed' : 'velar-managed',
      baseURL: runtime.baseURL,
      name: providerId,
      fetch: (input, init) =>
        runtime.fetch(
          input,
          providerId === 'velar'
            ? injectVelarThinkingRouting(init, config.thinkingDepth, config.reasoningLevel)
            : init
        ),
    })
    return (modelId) => {
      if (providerId === 'velar' && isBlank(modelId))
        return applyPromptCacheProviderOptions(provider.chat('velar/auto'))
      if (isBlank(modelId)) {
        throw new AppError(
          'VALIDATION',
          'Velar Dev 模型必须由 Cloud 动态目录显式选择。'
        )
      }

      // Cloud 下发的公共模型 ID 是不透明契约，Platform 不加前缀、不拆分也不规范化。
      return applyPromptCacheProviderOptions(provider.chat(modelId))
    }
  }

  public createEmbeddingRequest(
    config: ModelAdapterConfig,
    _model: string,
    texts: string[]
  ): EmbeddingRequest {
    const providerId = this.requireManagedProviderId(config.provider)
    if (providerId === 'velar-dev') {
      throw new AppError(
        'VALIDATION',
        'Velar Dev 当前只提供聊天模型，不支持 embedding。'
      )
    }

    const runtime = this.cloudRuntime.require('velar')
    return {
      url: `${runtime.baseURL}/embeddings`,
      headers: { Authorization: 'Bearer velar-managed' },
      body: {
        model: 'velar/embedding',
        input: texts,
      },
    }
  }

  private requireManagedProviderId(providerId: ChatProviderId): VelarCloudManagedProviderId {
    if (isVelarCloudManagedProviderId(providerId)) return providerId
    throw new AppError('VALIDATION', `不是 Velar Cloud 托管 provider：${providerId}`)
  }
}

export { injectVelarThinkingRouting }
