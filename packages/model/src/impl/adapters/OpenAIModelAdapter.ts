import { createOpenAI } from '@ai-sdk/openai'

import { isBlank } from '@velaros-ai/core'
import { logRuntime } from '@velaros-ai/core/logger'

import type { ModelProviderAdapter } from '../../contract/requires'
import type {
  EmbeddingRequest,
  LanguageModelFactory,
  ModelAdapterConfig,
  OpenAIModelFetch,
  OpenAIModelFetchInit,
} from '../../types/adapters'
import type { ChatProviderId } from '../../types/model'
import type { OpenRouterRequestRouting } from '../../types/providers'
import { isOpenRouterCompatibleProvider } from '../../utils/catalog/model-selection'
import { mergeJsonRequestBody } from '../../utils/wire/fetch-shims'
import {
  mergeOpenRouterAutoRouterPlugin,
  mergeOpenRouterProviderPreferences,
  normalizeOpenRouterRouting,
  shouldInjectAutoRouterPlugin,
  shouldInjectOpenRouterReasoning,
} from '../../utils/wire/openrouter'
import { mergeOpenRouterReasoning } from '../../utils/wire/reasoning'
import type { ModelProviderCollectionApi } from '../providers/ModelProviderCollection'

import { ModelAdapter } from './ModelAdapter'
import { applyPromptCacheProviderOptions } from './PromptCacheLanguageModel'
import { applyThinkingDepthProviderOptions } from './ThinkingDepthLanguageModel'

/**
 * OpenAI / OpenRouter 模型适配器。
 *
 * 普通 OpenAI 直接创建 openai(modelId)；OpenRouter 需要额外在 fetch 中注入
 * auto-router 插件和 provider 偏好，因此单独做 routing 归一化。
 */
class OpenAIModelAdapter extends ModelAdapter implements ModelProviderAdapter {
  private readonly log = logRuntime.tag('OpenAIModelAdapter')

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

        return applyPromptCacheProviderOptions(
          applyThinkingDepthProviderOptions(
            openai(modelId),
            config.provider,
            modelId,
            config.thinkingDepth,
            config.reasoningLevel
          )
        )
      }

      const routing = normalizeOpenRouterRouting(modelId, options, config)
      const openrouter = createOpenAI({
        apiKey,
        baseURL,
        name: config.provider,
        fetch: this.createOpenRouterFetch(routing),
      })

      return applyPromptCacheProviderOptions(openrouter.chat(routing.model))
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

  /** 创建带 OpenRouter routing 注入能力的 fetch。 */
  private createOpenRouterFetch(routing: OpenRouterRequestRouting): OpenAIModelFetch {
    return async (input, init) =>
      globalThis.fetch(input, this.injectOpenRouterRouting(init, routing) || undefined)
  }

  /**
   * 向 OpenRouter 请求体注入 routing 参数。
   *
   * auto 模型 + allowedModels 会注入 auto-router 插件；
   * providerPreferences 会合并进 body.provider。
   */
  private injectOpenRouterRouting(
    init: Optional<OpenAIModelFetchInit>,
    routing: OpenRouterRequestRouting
  ): OpenAIModelFetchInit | undefined {
    const injectAutoRouter = shouldInjectAutoRouterPlugin(routing.model, routing.allowedModels)
    const injectPreferences = !!routing.providerPreferences
    const injectReasoning = shouldInjectOpenRouterReasoning(routing)

    if (!injectAutoRouter && !injectPreferences && !injectReasoning) return init

    return mergeJsonRequestBody(
      init,
      (body) => {
        const nextBody: Record<string, unknown> = { ...body }

        if (injectAutoRouter) {
          nextBody.plugins = mergeOpenRouterAutoRouterPlugin(body.plugins, routing.allowedModels)
        }

        if (routing.providerPreferences) {
          nextBody.provider = mergeOpenRouterProviderPreferences(
            body.provider,
            routing.providerPreferences
          )
        }

        if (injectReasoning) {
          nextBody.reasoning = mergeOpenRouterReasoning(
            body.reasoning,
            routing.thinkingDepth,
            routing.reasoningLevel
          )
        }

        return nextBody
      }
    )
  }
}

export { OpenAIModelAdapter }
