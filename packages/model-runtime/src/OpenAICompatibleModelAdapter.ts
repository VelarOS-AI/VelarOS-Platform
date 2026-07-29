import { createOpenAI, type OpenAIProviderSettings } from '@ai-sdk/openai'

import { isBlank, isPlainObject, isString, Log } from '@velaros-ai/core'

import { LocalModelEnvironment, OllamaProviderId } from './LocalModelEnvironment'
import type { EmbeddingRequest, LanguageModelFactory, ModelAdapterConfig } from './ModelAdapter'
import { ModelAdapter } from './ModelAdapter'
import type { ChatProviderId } from './ModelContracts'
import type { ModelProviderCollection } from './ModelProviderCollection'
import { applyPromptCacheProviderOptions } from './PromptCacheModelOptions'

type OpenAIFetch = NonNullable<OpenAIProviderSettings['fetch']>
type OpenAIFetchInit = Parameters<OpenAIFetch>[1]

/**
 * 兼容开放接口的模型供应方适配器。
 *
 * 用于直连兼容聊天补全接口的供应方；
 * 某些本地或私有供应方的密钥可选，因此需要处理空授权头。
 */
class OpenAICompatibleModelAdapter extends ModelAdapter {
  constructor(
    providerIds: readonly ChatProviderId[],
    providers: ModelProviderCollection,
    private readonly localModelEnvironment = new LocalModelEnvironment()
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

    return (modelId) => applyPromptCacheProviderOptions(compatible.chat(modelId))
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
  private createCompatibleFetch(provider: ChatProviderId, apiKey: string): OpenAIFetch | undefined {
    const shouldStripBlankAuth = isBlank(apiKey)
    const shouldInjectOllamaContext =
      provider === OllamaProviderId
      && Boolean(this.localModelEnvironment.resolveOllamaContextWindow())

    if (!shouldStripBlankAuth && !shouldInjectOllamaContext) return undefined

    return async (input, init) => {
      let nextInit = shouldStripBlankAuth ? this.stripBlankAuthorization(init) : init
      nextInit = shouldInjectOllamaContext
        ? this.injectOllamaContextOptions(input, nextInit)
        : nextInit

      return globalThis.fetch(input, nextInit || undefined)
    }
  }

  /** 移除 AI SDK 自动生成的空 Bearer 头。 */
  private stripBlankAuthorization(init: OpenAIFetchInit | undefined): OpenAIFetchInit | undefined {
    if (!init?.headers) return init

    const headers = new Headers(init.headers)
    const authorization = headers.get('Authorization') ?? ''

    if (authorization.trim() === 'Bearer') {
      headers.delete('Authorization')
    }

    return {
      ...init,
      headers,
    }
  }

  /** Ollama OpenAI endpoint accepts native `options.num_ctx`; expose it via env config. */
  private injectOllamaContextOptions(
    input: Parameters<OpenAIFetch>[0],
    init: OpenAIFetchInit | undefined
  ): OpenAIFetchInit | undefined {
    const contextWindow = this.localModelEnvironment.resolveOllamaContextWindow()
    if (!contextWindow || !this.isChatCompletionsRequest(input) || !isString(init?.body)) return init

    try {
      const body = JSON.parse(init.body)
      if (!this.isRecord(body)) return init

      const options = this.isRecord(body.options) ? body.options : {}
      return {
        ...init,
        body: JSON.stringify({
          ...body,
          options: {
            ...options,
            num_ctx: contextWindow,
          },
        }),
      }
    } catch (error) {
      Log.tag('OpenAICompatibleModelAdapter').debug('注入 Ollama 上下文窗口失败，保留原始请求体', {
        error,
      })
      return init
    }
  }

  private isChatCompletionsRequest(input: Parameters<OpenAIFetch>[0]): boolean {
    const url = input instanceof Request ? input.url : isString(input) ? input : input.toString()

    return /\/chat\/completions(?:\?|$)/u.test(url)
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return isPlainObject(value)
  }
}

export { OpenAICompatibleModelAdapter }
