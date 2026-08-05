import {
  KnowledgeChunkBuilder,
  KnowledgeDomain,
  KnowledgeIngestion,
  KnowledgeMaintenance,
  KnowledgeMutation,
  KnowledgeQuery,
} from './knowledge/domain'
import { KnowledgeWorkspace } from './knowledge/ingestion'
import {
  KnowledgeRepo,
  KnowledgeRows,
  KnowledgeVectorQuery,
  KnowledgeVectors,
} from './knowledge/storage'
import { EmbeddingApi, Embeddings } from './embedding'
import type { KnowledgeRuntimeProviders } from './Types'
import { VectorFailureMonitor } from './VectorFailureLog'

/**
 * 已发布的最小运行时契约。
 *
 * 该接口保留 0.3.2 的结构化兼容性；具体生命周期能力由
 * {@link DefaultKnowledgeRuntime} 提供。
 */
export interface KnowledgeRuntime {
  readonly knowledgeDomainService: KnowledgeDomain
  readonly knowledgeVectors: KnowledgeVectors
}

/**
 * 一个宿主独占的 Knowledge 对象图和资源生命周期。
 *
 * 所有 provider、存储路径与代码智能能力均通过 ports 注入；向量告警状态也只属于本实例。
 */
export class DefaultKnowledgeRuntime implements KnowledgeRuntime {
  public readonly domain: KnowledgeDomain
  public readonly vectorStore: KnowledgeVectors
  public readonly knowledgeDomainService: KnowledgeDomain
  public readonly knowledgeVectors: KnowledgeVectors

  constructor(providers: KnowledgeRuntimeProviders) {
    const repository = new KnowledgeRepo(
      new KnowledgeRows(),
      providers.databaseProvider
    )
    const embeddingService = new Embeddings(
      new EmbeddingApi(providers.embeddingRequestFactory),
      providers.embeddingConfig,
      providers.httpClient
    )
    const vectorFailures = new VectorFailureMonitor()
    this.knowledgeVectors = new KnowledgeVectors(
      new KnowledgeVectorQuery(),
      providers.storagePathProvider
    )
    this.vectorStore = this.knowledgeVectors
    const mutationService = new KnowledgeMutation(
      repository,
      embeddingService,
      this.knowledgeVectors,
      new KnowledgeChunkBuilder(),
      vectorFailures
    )
    const ingestionService = new KnowledgeIngestion(
      repository,
      new KnowledgeWorkspace(providers.codeIntelligence, providers.indexingPolicy),
      mutationService
    )
    const maintenanceService = new KnowledgeMaintenance(
      repository,
      mutationService,
      this.knowledgeVectors
    )
    this.knowledgeDomainService = new KnowledgeDomain(
      ingestionService,
      new KnowledgeQuery(
        repository,
        embeddingService,
        this.knowledgeVectors,
        vectorFailures
      ),
      maintenanceService,
      this.knowledgeVectors
    )
    this.domain = this.knowledgeDomainService
  }

  public async warmup(): Promise<void> {
    await this.knowledgeDomainService.warmup()
  }

  public close(): void {
    this.knowledgeDomainService.close()
  }
}

/**
 * 兼容的构造器入口。类型位置仍是 0.3.2 的最小契约，值位置创建默认实现。
 */
 
export const KnowledgeRuntime = DefaultKnowledgeRuntime

export function createKnowledgeRuntime(
  providers: KnowledgeRuntimeProviders
): DefaultKnowledgeRuntime {
  return new DefaultKnowledgeRuntime(providers)
}
