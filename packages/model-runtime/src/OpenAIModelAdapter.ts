import { createOpenAI, type OpenAIProviderSettings } from '@ai-sdk/openai'

import { isArray,isBlank, isEmpty, isPlainObject, isString } from '@velaros-ai/core'
import { logRuntime } from '@velaros-ai/core/logger'

import {
  isOpenRouterCompatibleProvider,
  OpenRouterAutoModelId,
  OpenRouterFreeModelId,
} from './ModelCatalog'
import type {
  ChatProviderId,
  ModelRequestOptions,
  OpenRouterProviderRoutingPreferences,
} from './ModelContracts'

import type { EmbeddingRequest, LanguageModelFactory, ModelAdapterConfig } from './ModelAdapter'
import { ModelAdapter } from './ModelAdapter'
import type { ModelProviderCollection } from './ModelProviderCollection'
import { applyPromptCacheProviderOptions } from './PromptCacheModelOptions'
import {
  applyThinkingDepthProviderOptions,
  mergeOpenRouterReasoning,
} from './ThinkingDepthModelOptions'

type OpenAIFetch = NonNullable<OpenAIProviderSettings['fetch']>
type OpenAIFetchInit = Parameters<OpenAIFetch>[1]

interface NormalizedOpenRouterRouting {
  model: string
  allowedModels: string[]
  providerPreferences?: OpenRouterProviderRoutingPreferences
  useFreeModelsForDebug: boolean
  thinkingDepth: ModelAdapterConfig['thinkingDepth']
}

const OPENROUTER_REASONING_MODEL_MATCHERS = [
  /claude-(?:opus|sonnet|haiku)-(?:latest|4(?:[.-]\d+)?)/i,
  /claude-(?:4(?:[.-]\d+)?)-(?:opus|sonnet|haiku)/i,
  /claude-(?:3[.-]7-sonnet|sonnet-3[.-]7)/i,
  /gemini-(?:2\.5|3(?:[.-]|$))/i,
  /(?:^|\/)o[34](?:-|$)/i,
  /gpt-[45]|gpt-oss/i,
  /reasoner|reasoning|thinking/i,
]

/**
 * OpenAI / OpenRouter 模型适配器。
 *
 * 普通 OpenAI 直接创建 openai(modelId)；OpenRouter 需要额外在 fetch 中注入
 * auto-router 插件和 provider 偏好，因此单独做 routing 归一化。
 */
class OpenAIModelAdapter extends ModelAdapter {
  private readonly log = logRuntime.tag('OpenAIModelAdapter')

  constructor(providerIds: readonly ChatProviderId[], providers: ModelProviderCollection) {
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
            config.thinkingDepth
          )
        )
      }

      const routing = this.normalizeOpenRouterRouting(modelId, options, config.thinkingDepth)
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

  /** 归一化 OpenRouter 路由配置。 */
  private normalizeOpenRouterRouting(
    modelId: string,
    options: ModelRequestOptions | undefined,
    thinkingDepth: ModelAdapterConfig['thinkingDepth']
  ): NormalizedOpenRouterRouting {
    const routing = options?.openRouter
    const useFreeModelsForDebug = !!routing?.useFreeModelsForDebug

    if (useFreeModelsForDebug) return {
        model: OpenRouterFreeModelId,
        allowedModels: [],
        useFreeModelsForDebug,
        thinkingDepth,
      }

    return {
      model: modelId.trim() || OpenRouterAutoModelId,
      allowedModels: this.normalizeAllowedModels(routing?.allowedModels ?? []),
      providerPreferences: routing?.providerPreferences,
      useFreeModelsForDebug,
      thinkingDepth,
    }
  }

  /** 创建带 OpenRouter routing 注入能力的 fetch。 */
  private createOpenRouterFetch(routing: NormalizedOpenRouterRouting): OpenAIFetch {
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
    init: OpenAIFetchInit | undefined,
    routing: NormalizedOpenRouterRouting
  ): OpenAIFetchInit | undefined {
    const shouldInjectAutoRouterPlugin =
      routing.model === OpenRouterAutoModelId && !isEmpty(routing.allowedModels)
    const shouldInjectProviderPreferences = !!routing.providerPreferences
    const shouldInjectReasoning = this.shouldInjectOpenRouterReasoning(routing)

    if (!shouldInjectAutoRouterPlugin && !shouldInjectProviderPreferences && !shouldInjectReasoning) return init

    const rawBody = init?.body
    if (!isString(rawBody)) return init

    try {
      const body = JSON.parse(rawBody)
      if (!isPlainObject(body)) return init
      const nextBody: Record<string, unknown> = { ...body }

      if (shouldInjectAutoRouterPlugin) {
        nextBody.plugins = this.mergeOpenRouterAutoRouterPlugin(body.plugins, routing.allowedModels)
      }

      if (routing.providerPreferences) {
        nextBody.provider = this.mergeOpenRouterProviderPreferences(
          body.provider,
          routing.providerPreferences
        )
      }

      if (shouldInjectReasoning) {
        nextBody.reasoning = mergeOpenRouterReasoning(body.reasoning, routing.thinkingDepth)
      }

      return {
        ...init,
        body: JSON.stringify(nextBody),
      }
    } catch (error) {
      this.log.debug('注入 OpenRouter 路由请求体失败，保留原始初始化参数', {
        error,
      })
      return init
    }
  }

  /** 合并 OpenRouter auto-router 插件，并移除旧的 auto-router 避免重复。 */
  private mergeOpenRouterAutoRouterPlugin(
    plugins: unknown,
    allowedModels: string[]
  ): Array<Record<string, unknown>> {
    const existingPlugins = isArray(plugins)
      ? plugins.filter(
          (plugin): plugin is Record<string, unknown> =>
            isPlainObject(plugin) && (plugin).id !== 'auto-router'
        )
      : []

    return [
      ...existingPlugins,
      {
        id: 'auto-router',
        allowed_models: allowedModels,
      },
    ]
  }

  /** 合并 OpenRouter provider preferences。 */
  private mergeOpenRouterProviderPreferences(
    provider: unknown,
    providerPreferences: OpenRouterProviderRoutingPreferences
  ): Record<string, unknown> {
    const existingProvider = isPlainObject(provider)
        ? (provider)
        : {}

    return {
      ...existingProvider,
      ...providerPreferences,
    }
  }

  /** 仅在 OpenRouter 支持或可能自动路由到 reasoning 模型时注入运行策略。 */
  private shouldInjectOpenRouterReasoning(routing: NormalizedOpenRouterRouting): boolean {
    if (!routing.thinkingDepth || routing.useFreeModelsForDebug) return false

    if (routing.model === OpenRouterAutoModelId) return (
        isEmpty(routing.allowedModels) ||
        routing.allowedModels.some((model) => this.matchesReasoningModel(model))
      )

    return this.matchesReasoningModel(routing.model)
  }

  private matchesReasoningModel(model: string): boolean {
    return OPENROUTER_REASONING_MODEL_MATCHERS.some((matcher) => matcher.test(model))
  }

  /** 过滤空模型、auto/free 特殊模型并去重。 */
  private normalizeAllowedModels(models: string[]): string[] {
    const seen = new Set<string>()
    const normalized: string[] = []

    models.forEach((model) => {
      const trimmed = model.trim()
      if (
        isBlank(trimmed) ||
        trimmed === OpenRouterAutoModelId ||
        trimmed === OpenRouterFreeModelId ||
        seen.has(trimmed)
      ) return

      seen.add(trimmed)
      normalized.push(trimmed)
    })

    return normalized
  }
}

export { OpenAIModelAdapter }
