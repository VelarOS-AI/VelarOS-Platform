import { createOpenAI } from '@ai-sdk/openai'

import { isBlank, isPlainObject, isString, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ChatProviderId, ReasoningLevel, ThinkingDepth } from '../../types/ModelContracts'
import type { ModelProviderCollection } from '../providers/ModelProviderCollection'
import {
  isVelarCloudManagedProviderId,
  type VelarCloudManagedProviderId,
  VelarCloudManagedProviderIds,
  type VelarCloudModelRuntime,
} from '../providers/VelarCloudModelRuntime'

import type { EmbeddingRequest, LanguageModelFactory, ModelAdapterConfig } from './ModelAdapter'
import { ModelAdapter } from './ModelAdapter'
import { applyPromptCacheProviderOptions } from './PromptCacheModelOptions'
import { mergeOpenRouterReasoning } from './ThinkingDepthModelOptions'

type VelarFetchInit = Parameters<typeof fetch>[1]

/** embedding 失败时带进错误文案的服务端正文上限，避免把整页 HTML 抄进日志。 */
const ErrorSummaryMaxChars = 200

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

/** 取错误响应的正文做诊断；读不出来（已被消费、非文本）时不让诊断本身再抛一次。 */
async function readResponseSummary(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim()
    return isBlank(text) ? '服务端未返回正文' : text.slice(0, ErrorSummaryMaxChars)
  } catch (error) {
    Log.tag('VelarModelAdapter').debug('读取 Velar embedding 失败响应正文失败', { error })
    return '服务端未返回可读正文'
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
    const url = `${runtime.baseURL}/embeddings`
    const headers = { Authorization: 'Bearer velar-managed' }
    const body = {
      model: 'velar/embedding',
      input: texts,
    }

    return {
      url,
      headers,
      body,
      // 必须走宿主注入的 fetch：账户认证是宿主在这个 fetch 里挂的，
      // 请求头里的 `velar-managed` 只是占位（与聊天链路同一个占位），
      // 消费方自己用普通 HTTP 客户端发出去就是一条没有身份的请求。
      execute: () => this.fetchVelarEmbedding(runtime.fetch, url, headers, body),
    }
  }

  private async fetchVelarEmbedding(
    runtimeFetch: typeof fetch,
    url: string,
    headers: Record<string, string>,
    body: unknown
  ): Promise<unknown> {
    const response = await runtimeFetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new AppError(
        'NETWORK',
        `Velar embedding 请求失败（HTTP ${response.status}）：${await readResponseSummary(response)}`
      )
    }

    return response.json()
  }

  private requireManagedProviderId(providerId: ChatProviderId): VelarCloudManagedProviderId {
    if (isVelarCloudManagedProviderId(providerId)) return providerId
    throw new AppError('VALIDATION', `不是 Velar Cloud 托管 provider：${providerId}`)
  }
}

export { injectVelarThinkingRouting }
