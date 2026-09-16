import type { KnowledgeRuntimeProviders } from '../contract/requires.js'

import { KnowledgeChunkBuilder } from './domain/KnowledgeChunkBuilder.js'
import type { KnowledgeDomainApi } from './domain/KnowledgeDomain.js'
import { KnowledgeDomain } from './domain/KnowledgeDomain.js'
import { KnowledgeIngestion } from './domain/KnowledgeIngestion.js'
import { KnowledgeMaintenance } from './domain/KnowledgeMaintenance.js'
import { KnowledgeMutation } from './domain/KnowledgeMutation.js'
import { KnowledgeQuery } from './domain/KnowledgeQuery.js'
import { KnowledgeWorkspace } from './domain/KnowledgeWorkspace.js'
import { KnowledgeEmbeddingClient } from './storage/KnowledgeEmbeddingClient.js'
import { KnowledgeEmbeddings } from './storage/KnowledgeEmbeddings.js'
import { KnowledgeRepository } from './storage/KnowledgeRepository.js'
import { KnowledgeRows } from './storage/KnowledgeRows.js'
import { KnowledgeVectorQuery } from './storage/KnowledgeVectorQuery.js'
import type { KnowledgeVectorsApi } from './storage/KnowledgeVectors.js'
import { KnowledgeVectors } from './storage/KnowledgeVectors.js'
import { VectorFailureMonitor } from './storage/VectorFailureMonitor.js'

/**
 * 一个宿主独占的知识库对象图与资源生命周期。
 *
 * provider、存储路径与代码智能全部经 `KnowledgeRuntimeProviders` 注入；向量告警状态也只属于这一个实例。
 * 一个数据目录或租户一份，用 `createKnowledgeRuntime` 创建。
 */
export interface KnowledgeRuntimeApi {
  /** 领域门面：同步、搜索、诊断、重建都从这里进。 */
  readonly knowledgeDomainService: KnowledgeDomainApi
  /** 向量库：宿主做存储迁移与诊断时会直接用到。 */
  readonly knowledgeVectors: KnowledgeVectorsApi
  /** 预热向量库，一般在应用启动时调用。 */
  warmup(): Promise<void>
  /** 关闭这一份运行时占用的连接。 */
  close(): void
}

/** 见 {@link KnowledgeRuntimeApi}。 */
export class KnowledgeRuntime implements KnowledgeRuntimeApi {
  public readonly knowledgeDomainService: KnowledgeDomainApi
  public readonly knowledgeVectors: KnowledgeVectorsApi

  constructor(providers: KnowledgeRuntimeProviders) {
    const repository = new KnowledgeRepository(
      new KnowledgeRows(),
      providers.databaseProvider
    )
    const embeddingService = new KnowledgeEmbeddings(
      new KnowledgeEmbeddingClient(providers.embeddingRequestFactory),
      providers.embeddingConfig,
      providers.httpClient
    )
    const vectorFailures = new VectorFailureMonitor()
    this.knowledgeVectors = new KnowledgeVectors(
      new KnowledgeVectorQuery(),
      providers.storagePathProvider,
      providers.loadLanceDb
    )
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
  }

  public async warmup(): Promise<void> {
    await this.knowledgeDomainService.warmup()
  }

  public close(): void {
    this.knowledgeDomainService.close()
  }
}

/** 按注入的端口造一份知识库运行时；一个数据目录或租户一份。 */
export function createKnowledgeRuntime(
  providers: KnowledgeRuntimeProviders
): KnowledgeRuntimeApi {
  return new KnowledgeRuntime(providers)
}
