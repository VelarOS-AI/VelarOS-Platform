import { structureToolDescriptionsForCategory } from '@velaros-ai/agent/tool-contract'

import { knowledgeTools as rawKnowledgeTools } from './tools/knowledge/Knowledge.tool'

export { KnowledgeIndexConfig, KnowledgeIndexStatuses, KnowledgeMatchTypes } from './Constants'
export { EmbeddingApi, EmbeddingApi as EmbeddingApiHelper } from './embedding/EmbeddingApi'
export type { EmbeddingRuntimeSelection } from './embedding/Embeddings'
export { Embeddings, Embeddings as EmbeddingService } from './embedding/Embeddings'
export type { KnowledgeChunk } from './knowledge/domain/Chunks'
export {
  KnowledgeChunkBuilder,
  KnowledgeChunkBuilder as KnowledgeChunks,
} from './knowledge/domain/Chunks'
export {
  createImportTargetCandidates,
  extractImports,
  extractSymbols,
  getCodeExtensions,
  isCodeFile,
  isLikelyTextFile,
  scorePathMatch,
} from './knowledge/domain/CodeHelper'
export { KnowledgeMaintenance } from './knowledge/domain/Maintenance'
export { KnowledgeMutation } from './knowledge/domain/Mutation'
export { KnowledgeQuery } from './knowledge/domain/Query'
export type { RankedKnowledgeCandidate } from './knowledge/domain/QueryHelper'
export { KnowledgeQueryHelper } from './knowledge/domain/QueryHelper'
export { KnowledgeDomain } from './knowledge/domain/Service'
export type {
  KnowledgeDiagnostics,
  KnowledgeEmbeddingProviderId,
  KnowledgeFileIndexStats,
  KnowledgeIndexStatus,
  KnowledgeMatchType,
  KnowledgeRecord,
  KnowledgeReindexFailure,
  KnowledgeReindexOptions,
  KnowledgeReindexResult,
  KnowledgeSearchOptions,
  KnowledgeSearchResult,
  KnowledgeSourceKind,
  KnowledgeSourceKindCounts,
  KnowledgeUpsertInput,
  KnowledgeVectorStoreStats,
  KnowledgeWorkspaceSyncOptions,
  KnowledgeWorkspaceSyncResult,
  KnowledgeWorkspaceSyncState,
} from './knowledge/domain/Types'
export { KnowledgeIngestion } from './knowledge/ingestion/Ingestion'
export type {
  KnowledgeIndexedFileInspection,
  KnowledgeWorkspaceCodeCandidate,
  KnowledgeWorkspaceFileEntry,
  KnowledgeWorkspacePreparedDocument,
} from './knowledge/ingestion/WorkspaceStore'
export {
  KnowledgeWorkspace,
  KnowledgeWorkspace as KnowledgeWorkspaceStore,
} from './knowledge/ingestion/WorkspaceStore'
export {
  KnowledgeEmbeddingProfileIsolationMigration,
} from './knowledge/storage/EmbeddingProfileIsolationMigration'
export { KnowledgeRepo, KnowledgeRepo as KnowledgeRepository } from './knowledge/storage/Repository'
export type {
  KnowledgeChunkRecord,
  KnowledgeDocumentRow,
  KnowledgeFileIndexRecord,
  KnowledgeFileIndexRow,
  KnowledgeTextSearchRow,
  KnowledgeVectorIndexRecord,
  KnowledgeVectorSearchPartition,
} from './knowledge/storage/RepositoryRows'
export {
  KnowledgeRows as KnowledgeRepositoryHelper,
  KnowledgeRows,
} from './knowledge/storage/RepositoryRows'
export {
  KnowledgeVectorQuery as KnowledgeVectorHelper,
  KnowledgeVectorQuery,
} from './knowledge/storage/VectorQuery'
export type { KnowledgeVectorWriteResult } from './knowledge/storage/Vectors'
export {
  KnowledgeVectors,
  KnowledgeVectors as KnowledgeVectorStore,
} from './knowledge/storage/Vectors'
export { AgentKnowledgeHelper, KnowledgeContext } from './KnowledgeContext'
export { createKnowledgeRuntime, DefaultKnowledgeRuntime, KnowledgeRuntime } from './Runtime'
export type {
  EmbeddingProfileIdentity,
  EmbeddingRuntimeIdentity,
  IndexedRecordIdentity,
} from './shared/indexing/Indexing'
export {
  buildDocumentRevisionKey,
  buildEmbeddingProfileIdentity,
  buildIndexTextHash,
  canReuseReadyContentIndex,
} from './shared/indexing/Indexing'
export type { HybridCandidate } from './shared/query/HybridQuery'
export { mergeHybridCandidates } from './shared/query/HybridQuery'
export type {
  LanceIndexDescriptor,
  VectorStoreStatsInput,
  VectorStoreStatsOutput,
} from './shared/vector/VectorStats'
export { buildVectorStoreStats } from './shared/vector/VectorStats'
export type {
  EmbeddingRequest,
  EmbeddingRequestConfig,
  EmbeddingRequestFactory,
  KnowledgeApi,
  KnowledgeCodeIntelligenceApi,
  KnowledgeCodeSymbol,
  KnowledgeCodeSymbolKind,
  KnowledgeDatabaseProvider,
  KnowledgeEmbeddingConfigPort,
  KnowledgeEmbeddingRuntime,
  KnowledgeHttpClient,
  KnowledgeIndexingPolicy,
  KnowledgeLanceDbConnection,
  KnowledgeLanceDbLoader,
  KnowledgeLanceDbModule,
  KnowledgeProjectApi,
  KnowledgeRuntimeProviders,
  KnowledgeStoragePathProvider,
  KnowledgeTool,
  KnowledgeToolContext,
} from './Types'
export type { VectorFailureLogger, VectorFailureMonitorOptions } from './VectorFailureLog'
export { VectorFailureLogWindowMs, VectorFailureMonitor } from './VectorFailureLog'

export const knowledgeTools: typeof rawKnowledgeTools = structureToolDescriptionsForCategory(
  rawKnowledgeTools,
  'knowledge'
)
