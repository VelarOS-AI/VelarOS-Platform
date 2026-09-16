import { isArray, isNull, isObject, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { EmbeddingRequestFactory } from '../../contract/requires.js'
import type { EmbeddingApiResponse, EmbeddingRequest } from '../../types/host.js'
import type { KnowledgeEmbeddingProviderId } from '../../types/knowledge.js'
import { isFiniteNumberArray, normalizeEmbeddingVector } from '../../utils/embedding.js'

/**
 * 嵌入协议客户端：宿主给什么服务商，它就按什么协议拼请求、按什么形状读响应。
 *
 * 实例由知识库运行时持有；桌面端的记忆向量嵌入器也直接用它，所以它随包出去。
 */
export interface KnowledgeEmbeddingClientApi {
  /** 按服务商配置与待嵌入文本拼出一条嵌入请求。 */
  buildEmbeddingRequest(
    config: {
      provider: KnowledgeEmbeddingProviderId
      apiKey: string
      baseURL: string
      model?: string
    },
    texts: string[]
  ): EmbeddingRequest
  /** 把各家服务商的原始响应归一化成 `{ data: [{ embedding }] }`；格式不对报 `NETWORK`。 */
  parseEmbeddingResponse(payload: unknown): EmbeddingApiResponse
}

/** 见 {@link KnowledgeEmbeddingClientApi}。 */
export class KnowledgeEmbeddingClient implements KnowledgeEmbeddingClientApi {
  constructor(private readonly requestFactory: EmbeddingRequestFactory) {}

  public buildEmbeddingRequest(
    config: {
      provider: KnowledgeEmbeddingProviderId
      apiKey: string
      baseURL: string
      model?: string
    },
    texts: string[]
  ): EmbeddingRequest {
    return this.requestFactory.createEmbeddingRequest(
      {
        provider: config.provider,
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      },
      config.model?.trim() ?? '',
      texts
    )
  }

  public parseEmbeddingResponse(payload: unknown): EmbeddingApiResponse {
    if (isNull(payload) || !isObject(payload)) {
      throw new AppError('NETWORK', 'Embedding 响应格式不正确')
    }

    const record = payload as { embedding?: unknown; embeddings?: unknown; data?: unknown }
    if (isPresent(record.embeddings)) {
      // 部分服务商返回 { embeddings: number[][] }。
      const embeddings = record.embeddings
      if (!isArray(embeddings)) {
        throw new AppError('NETWORK', 'Embedding 响应缺少 embeddings 数组')
      }

      return {
        data: embeddings.map((embedding) => normalizeEmbeddingVector(embedding)),
      }
    }

    if (isPresent(record.embedding)) {
      // 单条响应可能直接返回 { embedding: number[] }。
      return {
        data: [normalizeEmbeddingVector(record.embedding)],
      }
    }

    if (!isPresent(record.data)) {
      throw new AppError('NETWORK', 'Embedding 响应格式不正确')
    }

    const data = record.data
    if (!isArray(data)) {
      throw new AppError('NETWORK', 'Embedding 响应缺少 data 数组')
    }

    // OpenAI 兼容格式：{ data: [{ embedding: number[] }] }。
    const items = data.map((item) => {
      if (isNull(item) || !isObject(item)) {
        throw new AppError('NETWORK', 'Embedding 响应项格式不正确')
      }

      const embedding = (item as { embedding?: unknown }).embedding
      if (!isFiniteNumberArray(embedding)) {
        throw new AppError('NETWORK', 'Embedding 向量格式不正确')
      }

      return { embedding }
    })

    return { data: items }
  }
}
