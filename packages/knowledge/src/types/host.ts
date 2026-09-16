/** 宿主注入面上流动的数据形状：嵌入运行时、嵌入请求、日志接收口。端口本身在 `contract/requires.ts`。 */

import type { KnowledgeEmbeddingProviderId } from './knowledge.js'

/** 宿主已经解析好的一次嵌入运行时配置；本包不挑模型、不读凭据环境约定。 */
export interface KnowledgeEmbeddingRuntime {
  /** 不透明的服务商身份。 */
  provider: KnowledgeEmbeddingProviderId
  /** 向量模型名。 */
  model: string
  /** 调用凭据。 */
  apiKey: string
  /** 服务地址。 */
  baseURL: string
  /** 宿主判定的可用性；为假时在发起 IO 之前就报校验错误。 */
  configured: boolean
  /** 可选的人类可读名称，用在配置错误文案里。 */
  providerLabel?: string
}

/** 实际用于生成向量的 provider/model 组合，读写都按它选精确匹配的 profile。 */
export interface EmbeddingRuntimeSelection {
  /** 不透明的服务商身份。 */
  provider: KnowledgeEmbeddingProviderId
  /** 向量模型名。 */
  model: string
}

/** 交给嵌入请求工厂的 provider 配置。 */
export interface EmbeddingRequestConfig {
  /** 不透明的服务商身份。 */
  provider: KnowledgeEmbeddingProviderId
  /** 调用凭据。 */
  apiKey: string
  /** 服务地址。 */
  baseURL: string
}

/** 一次嵌入请求：要么交给通用 HTTP 客户端发，要么由注入式 provider 自己执行。 */
export interface EmbeddingRequest {
  /** 请求地址。 */
  url: string
  /** 请求头。 */
  headers: Record<string, string>
  /** 请求体。 */
  body?: unknown
  /** 注入式 provider 自带的执行函数；给了它就不走 HTTP 客户端。 */
  execute?: () => Promise<unknown>
}

/** 归一化之后的单条嵌入响应。 */
export interface EmbeddingApiItem {
  /** 一条向量。 */
  embedding: number[]
}

/** 归一化之后的嵌入响应结构，兼容各家 provider 的原始返回。 */
export interface EmbeddingApiResponse {
  /** 按入参顺序排列的向量列表。 */
  data: EmbeddingApiItem[]
}

/** 向量故障抑制器往外写告警时用的最小日志口。 */
export interface VectorFailureLogger {
  /** 记一条告警，附带上下文。 */
  warn(message: string, payload?: unknown): void
}
