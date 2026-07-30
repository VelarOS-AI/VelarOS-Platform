import { createOpenAI } from '@ai-sdk/openai'

import { isPlainObject, isString, Log } from '@velaros-ai/core'

import type { ChatProviderId, ReasoningLevel, ThinkingDepth } from './ModelContracts'

import type { EmbeddingRequest, LanguageModelFactory, ModelAdapterConfig } from './ModelAdapter'
import { ModelAdapter } from './ModelAdapter'
import type { ModelProviderCollection } from './ModelProviderCollection'
import { applyPromptCacheProviderOptions } from './PromptCacheModelOptions'
import { mergeOpenRouterReasoning } from './ThinkingDepthModelOptions'
import type { VelarCloudModelRuntime } from './VelarCloudModelRuntime'

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
    super(['velar'] satisfies readonly ChatProviderId[], providers)
  }

  public createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory {
    const runtime = this.cloudRuntime.require()
    const provider = createOpenAI({
      apiKey: 'velar-managed',
      baseURL: runtime.baseURL,
      name: 'velar',
      fetch: (input, init) =>
        runtime.fetch(
          input,
          injectVelarThinkingRouting(init, config.thinkingDepth, config.reasoningLevel)
        ),
    })
    return (modelId) => applyPromptCacheProviderOptions(provider.chat(modelId || 'velar/auto'))
  }

  public createEmbeddingRequest(
    _config: ModelAdapterConfig,
    _model: string,
    texts: string[]
  ): EmbeddingRequest {
    const runtime = this.cloudRuntime.require()
    return {
      url: `${runtime.baseURL}/embeddings`,
      headers: { Authorization: 'Bearer velar-managed' },
      body: {
        model: 'velar/embedding',
        input: texts,
      },
    }
  }
}

export { injectVelarThinkingRouting }
