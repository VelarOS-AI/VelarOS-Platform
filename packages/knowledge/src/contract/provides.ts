/**
 * 产品面：本包交给外面的整件能力。
 *
 * 类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里只做登记与转发；
 * 这里登记的每个接口都从根入口导出。没有类的公开接口才直接声明在这里。
 */

// ── 运行时与领域门面 ────────────────────────────────────────────
export type { KnowledgeDomainApi } from '../impl/domain/KnowledgeDomain.js'
export type { KnowledgeIngestionApi } from '../impl/domain/KnowledgeIngestion.js'
export type { KnowledgeMaintenanceApi } from '../impl/domain/KnowledgeMaintenance.js'
export type { KnowledgeMutationApi } from '../impl/domain/KnowledgeMutation.js'
export type { KnowledgeQueryApi } from '../impl/domain/KnowledgeQuery.js'
export type { KnowledgeWorkspaceApi } from '../impl/domain/KnowledgeWorkspace.js'
export type { KnowledgeRuntimeApi } from '../impl/KnowledgeRuntime.js'

// ── 分块、召回拼装与评分门面 ────────────────────────────────────
export type { KnowledgeChunkBuilderApi } from '../impl/domain/KnowledgeChunkBuilder.js'
export type { KnowledgeContextApi } from '../impl/domain/KnowledgeContext.js'
export type { KnowledgeQueryHelperApi } from '../impl/domain/KnowledgeQueryHelper.js'

// ── 存储：关系仓、行映射、向量表与向量查询、嵌入 ─────────────────
export type { KnowledgeEmbeddingClientApi } from '../impl/storage/KnowledgeEmbeddingClient.js'
export type { KnowledgeEmbeddingsApi } from '../impl/storage/KnowledgeEmbeddings.js'
export type { KnowledgeRepositoryApi } from '../impl/storage/KnowledgeRepository.js'
export type { KnowledgeRowsApi } from '../impl/storage/KnowledgeRows.js'
export type { KnowledgeVectorQueryApi } from '../impl/storage/KnowledgeVectorQuery.js'
export type { KnowledgeVectorsApi } from '../impl/storage/KnowledgeVectors.js'
export type {
  VectorFailureMonitorApi,
  VectorFailureMonitorOptions,
} from '../impl/storage/VectorFailureMonitor.js'
