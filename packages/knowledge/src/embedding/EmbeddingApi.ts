import { isArray, isFiniteNumber,isNull, isObject, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { KnowledgeEmbeddingProviderId } from '../knowledge/domain/Types'
import type { EmbeddingRequest, EmbeddingRequestFactory } from '../Types'

/** 统一后的单条 embedding 响应。 */
interface EmbeddingApiItem {
  embedding: number[]
}

/** 统一后的 embedding 响应结构，兼容不同 provider 原始返回。 */
interface EmbeddingApiResponse {
  data: EmbeddingApiItem[]
}

/**
 * Embedding API 辅助方法。
 *
 * 构造 provider adapter 的 embedding 请求，并把 OpenAI/注入式 provider/单向量等响应格式
 * 归一化成 { data: [{ embedding }] }，供上层服务统一处理。
 */
export class EmbeddingApi {
  constructor(private readonly requestFactory: EmbeddingRequestFactory) {}

  /** 根据 provider 配置和文本列表创建 embedding 请求。 */
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

  /** 解析并校验 provider embedding 响应。 */
  public parseEmbeddingResponse(payload: unknown): EmbeddingApiResponse {
    if (isNull(payload) || !isObject(payload)) {
      throw new AppError('NETWORK', 'Embedding 响应格式不正确')
    }

    const record = payload as { embedding?: unknown; embeddings?: unknown; data?: unknown }
    if (isPresent(record.embeddings)) {
      // 部分 provider 返回 { embeddings: number[][] }。
      const embeddings = record.embeddings
      if (!isArray(embeddings)) {
        throw new AppError('NETWORK', 'Embedding 响应缺少 embeddings 数组')
      }

      return {
        data: embeddings.map((embedding) => this.normalizeEmbedding(embedding)),
      }
    }

    if (isPresent(record.embedding)) {
      // 单条 embedding 响应可能直接返回 { embedding: number[] }。
      return {
        data: [this.normalizeEmbedding(record.embedding)],
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
      if (!this.isNumberArray(embedding)) {
        throw new AppError('NETWORK', 'Embedding 向量格式不正确')
      }

      return { embedding }
    })

    return { data: items }
  }

  /** 校验单个向量并包装成统一结构。 */
  private normalizeEmbedding(embedding: unknown): EmbeddingApiItem {
    if (!this.isNumberArray(embedding)) {
      throw new AppError('NETWORK', 'Embedding 向量格式不正确')
    }

    return { embedding }
  }

  /** 确保向量是有限数字数组，避免 NaN/Infinity 写入 LanceDB。 */
  private isNumberArray(value: unknown): value is number[] {
    return (isArray(value) &&
      value.every((item) => isFiniteNumber(item))
    )
  }
}
