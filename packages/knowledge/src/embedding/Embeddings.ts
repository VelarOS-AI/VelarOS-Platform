import { first, isBlank,isEmpty, isTrue } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import type { KnowledgeEmbeddingProviderId } from '../knowledge/domain/Types'
import type {
  KnowledgeEmbeddingConfigPort,
  KnowledgeHttpClient,
} from '../Types'

import type { EmbeddingApi } from './EmbeddingApi'

const log = logRuntime.tag('Embeddings')
/** 查询向量 LRU 容量：128 条 × ~1536 维 float ≈ 1.5MB，覆盖召回/去重的高频重复查询。 */
const QueryEmbeddingCacheMaxEntries = 128

/** 实际用于生成 embedding 的 provider/model 组合。 */
interface EmbeddingRuntimeSelection {
  provider: KnowledgeEmbeddingProviderId
  model: string
}

/** 带鉴权和地址信息的完整 embedding runtime 配置。 */
interface EmbeddingRuntimeConfig extends EmbeddingRuntimeSelection {
  apiKey: string
  baseURL: string
}

/**
 * Embedding 服务。
 *
 * 消费宿主已解析的 embedding provider/model runtime，构造 provider 适配请求，
 * 并解析不同 provider 返回的 embedding 响应。本包不读取模型目录或凭证环境约定。
 */
class Embeddings {
  /** 单文本查询向量缓存；key 含 provider/model，切换向量供应商后旧条目自然失配。 */
  private readonly queryEmbeddingCache = new Map<string, number[]>()

  constructor(
    private readonly embeddingApi: EmbeddingApi,
    private readonly configPort: KnowledgeEmbeddingConfigPort,
    private readonly httpClient: KnowledgeHttpClient
  ) {}

  /** 单文本 embedding 快捷入口。搜索查询高频重复，命中缓存可省掉整跳远程请求。 */
  public async embedText(text: string): Promise<number[]> {
    const cacheKey = this.buildQueryEmbeddingCacheKey(text)
    const cachedVector = cacheKey ? this.readQueryEmbeddingCache(cacheKey) : null
    if (cachedVector) return cachedVector

    const vectors = await this.embedTexts([text])
    const vector = first(vectors)
    if (!vector) throw new AppError('NETWORK', 'Embedding 响应为空')
    if (cacheKey) this.writeQueryEmbeddingCache(cacheKey, vector)
    return vector
  }

  private buildQueryEmbeddingCacheKey(text: string): Nullable<string> {
    try {
      const runtime = this.getRuntimeSelection()
      return `${runtime.provider}|${runtime.model}|${text}`
    } catch {
      // arch-guard:silent-catch-ok runtime 配置不可用时按未命中处理，让 embedTexts 抛出真实配置错误。
      return null
    }
  }

  private readQueryEmbeddingCache(cacheKey: string): Nullable<number[]> {
    const vector = this.queryEmbeddingCache.get(cacheKey)
    if (!vector) return null

    // 命中后重新入队，保持 LRU 语义。
    this.queryEmbeddingCache.delete(cacheKey)
    this.queryEmbeddingCache.set(cacheKey, vector)
    return vector
  }

  private writeQueryEmbeddingCache(cacheKey: string, vector: number[]): void {
    if (this.queryEmbeddingCache.size >= QueryEmbeddingCacheMaxEntries) {
      const oldestKey = this.queryEmbeddingCache.keys().next().value
      if (oldestKey) this.queryEmbeddingCache.delete(oldestKey)
    }
    this.queryEmbeddingCache.set(cacheKey, vector)
  }

  /** 批量生成 embedding。 */
  public async embedTexts(texts: string[]): Promise<number[][]> {
    if (isEmpty(texts)) return []
    if (!this.isEmbeddingGenerationAllowed()) {
      throw new AppError('PERMISSION', 'Embedding 只能由用户动作或回答生成链路触发。')
    }

    // 每次生成前读取最新配置，用户切换 provider 后无需重启进程。
    const runtime = this.getEmbeddingRuntimeConfig({ requireConfigured: true })
    const request = this.embeddingApi.buildEmbeddingRequest(runtime, texts)
    // 注入式 provider 可以提供自定义 execute；普通 provider 走通用 HTTP JSON 客户端。
    const payload = request.execute
      ? await request.execute()
      : await this.httpClient.postJson<unknown>(request.url, {
          errorContext: 'Embedding',
          headers: request.headers,
          body: request.body,
        })
    const parsedPayload = this.embeddingApi.parseEmbeddingResponse(payload)
    const vectors = parsedPayload.data.map((item) => item.embedding)
    log.debug('embedding generated', {
      count: vectors.length,
      dimensions: first(vectors)?.length ?? 0,
    })
    return vectors
  }

  /** 返回当前 embedding runtime，用于选择精确匹配的读写 profile。 */
  public getRuntimeSelection(): EmbeddingRuntimeSelection {
    const runtime = this.getEmbeddingRuntimeConfig()
    return {
      provider: runtime.provider,
      model: runtime.model,
    }
  }

  /** 解析完整 embedding runtime 配置。 */
  private getEmbeddingRuntimeConfig(
    options: { requireConfigured?: boolean } = {}
  ): EmbeddingRuntimeConfig {
    const runtime = this.configPort.resolveEmbeddingRuntime()
    const provider = runtime.provider.trim()
    const model = runtime.model.trim()
    if (isBlank(provider)) {
      throw new AppError('VALIDATION', 'Embedding host 未提供 provider identity。')
    }
    if (isBlank(model)) {
      throw new AppError('VALIDATION', 'Embedding host 未解析可用的向量模型。')
    }
    if (options.requireConfigured && !runtime.configured) {
      throw new AppError(
        'VALIDATION',
        `${runtime.providerLabel?.trim() || provider} 运行配置不可用，无法生成向量。`
      )
    }

    return {
      provider,
      model,
      apiKey: runtime.apiKey,
      baseURL: runtime.baseURL,
    }
  }

  /** 只有用户动作或回答生成链路进入的显式上下文才允许生成 embedding。 */
  private isEmbeddingGenerationAllowed(): boolean {
    return (
      isTrue(this.configPort.isManualEmbeddingAllowed?.()) ||
      isTrue(this.configPort.isAnswerEmbeddingAllowed?.())
    )
  }
}

export { Embeddings, Embeddings as EmbeddingService }
export type { EmbeddingRuntimeSelection }
