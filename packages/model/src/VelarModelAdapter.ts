import { createOpenAI } from '@ai-sdk/openai'

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
  if (typeof init?.body !== 'string') return init

  try {
    const body = JSON.parse(init.body)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return init

    return {
      ...init,
      body: JSON.stringify({
        ...body,
        reasoning: mergeOpenRouterReasoning(body.reasoning, thinkingDepth, reasoningLevel),
      }),
    }
  } catch {
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
