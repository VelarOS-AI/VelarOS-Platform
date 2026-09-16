import { first, isBlank, isEmpty, isTrue, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  KnowledgeEmbeddingConfigPort,
  KnowledgeHttpClient,
} from '../../contract/requires.js'
import type { EmbeddingRuntimeSelection } from '../../types/host.js'
import { KnowledgeTuning } from '../../utils/tuning.js'

import type { KnowledgeEmbeddingClientApi } from './KnowledgeEmbeddingClient.js'

const log = Log.tag('KnowledgeEmbeddings')

/**
 * 嵌入服务：向宿主要一份已经解析好的 provider/model，拼请求、发请求、读响应。
 *
 * 实例由知识库运行时持有；查询向量带一个进程内 LRU，切换向量服务商后旧条目自然失配。
 * 本包不读模型目录，也不读任何凭据环境约定。
 */
export interface KnowledgeEmbeddingsApi {
  /** 单条文本的向量；命中缓存就省掉一整跳远程请求。 */
  embedText(text: string): Promise<number[]>
  /** 批量生成向量；不是用户动作或回答生成链路时报 `PERMISSION`。 */
  embedTexts(texts: string[]): Promise<number[][]>
  /** 当前这一刻的 provider/model 组合，读写都按它选精确匹配的 profile。 */
  getRuntimeSelection(): EmbeddingRuntimeSelection
}

/** 带鉴权与地址信息的完整嵌入运行时配置。 */
export interface KnowledgeEmbeddingsRuntimeConfig extends EmbeddingRuntimeSelection {
  /** 调用凭据。 */
  apiKey: string
  /** 服务地址。 */
  baseURL: string
}

/** 见 {@link KnowledgeEmbeddingsApi}。 */
export class KnowledgeEmbeddings implements KnowledgeEmbeddingsApi {
  /** 单文本查询向量缓存；key 里含 provider/model，切换向量服务商后旧条目自然失配。 */
  private readonly queryEmbeddingCache = new Map<string, number[]>()

  constructor(
    private readonly embeddingApi: KnowledgeEmbeddingClientApi,
    private readonly configPort: KnowledgeEmbeddingConfigPort,
    private readonly httpClient: KnowledgeHttpClient
  ) {}

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

  public async embedTexts(texts: string[]): Promise<number[][]> {
    if (isEmpty(texts)) return []
    if (!this.isEmbeddingGenerationAllowed()) {
      throw new AppError('PERMISSION', 'Embedding 只能由用户动作或回答生成链路触发。')
    }

    // 每次生成前读一次最新配置，用户切换服务商后无需重启进程。
    const runtime = this.getEmbeddingRuntimeConfig({ requireConfigured: true })
    const request = this.embeddingApi.buildEmbeddingRequest(runtime, texts)
    // 注入式服务商可以自带 execute；普通服务商走通用 HTTP JSON 客户端。
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

  public getRuntimeSelection(): EmbeddingRuntimeSelection {
    const runtime = this.getEmbeddingRuntimeConfig()
    return {
      provider: runtime.provider,
      model: runtime.model,
    }
  }

  /** 算出查询向量缓存的 key；运行时配置不可用时按未命中处理。 */
  private buildQueryEmbeddingCacheKey(text: string): Nullable<string> {
    try {
      const runtime = this.getRuntimeSelection()
      return `${runtime.provider}|${runtime.model}|${text}`
    } catch {
      // arch-guard:silent-catch-ok runtime 配置不可用时按未命中处理，让 embedTexts 抛出真实配置错误。
      return null
    }
  }

  /** 读查询向量缓存，命中后重新入队保持 LRU 语义。 */
  private readQueryEmbeddingCache(cacheKey: string): Nullable<number[]> {
    const vector = this.queryEmbeddingCache.get(cacheKey)
    if (!vector) return null

    this.queryEmbeddingCache.delete(cacheKey)
    this.queryEmbeddingCache.set(cacheKey, vector)
    return vector
  }

  /** 写查询向量缓存，超容量时淘汰最久没用过的一条。 */
  private writeQueryEmbeddingCache(cacheKey: string, vector: number[]): void {
    if (this.queryEmbeddingCache.size >= KnowledgeTuning.embedding.queryCacheMaxEntries) {
      const oldestKey = this.queryEmbeddingCache.keys().next().value
      if (oldestKey) this.queryEmbeddingCache.delete(oldestKey)
    }
    this.queryEmbeddingCache.set(cacheKey, vector)
  }

  /** 向宿主端口要一份完整的嵌入运行时配置。 */
  private getEmbeddingRuntimeConfig(
    options: { requireConfigured?: boolean } = {}
  ): KnowledgeEmbeddingsRuntimeConfig {
    const runtime = this.configPort.resolveEmbeddingRuntime()
    const provider = runtime.provider.trim()
    const model = runtime.model.trim()
    if (isBlank(provider)) {
      throw new AppError('VALIDATION', 'Embedding 宿主没有给出 provider 身份。')
    }
    if (isBlank(model)) {
      throw new AppError('VALIDATION', 'Embedding 宿主没有解析出可用的向量模型。')
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

  /** 只有用户动作或回答生成链路进入的显式上下文才允许生成向量。 */
  private isEmbeddingGenerationAllowed(): boolean {
    return (
      isTrue(this.configPort.isManualEmbeddingAllowed?.()) ||
      isTrue(this.configPort.isAnswerEmbeddingAllowed?.())
    )
  }
}
