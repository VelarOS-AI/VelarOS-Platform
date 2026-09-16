/**
 * 知识库根入口（`@velaros-ai/knowledge`），给 Node 宿主。
 *
 * 只出三样东西：产品面（`contract/provides.ts` 登记的接口与它们的实例）、注入面（`contract/requires.ts` 的接口），
 * 以及它们用到的数据（`types/`）与常量表（`contract/constants.ts`）。
 * 另一个入口 `./contracts` 是它的子集，只有可移植数据。
 *
 * 这一轮只做目录与合同的搬家：类与工具函数仍按老名字出包，等「入口收口」那一轮再按接口收窄。
 */

// ── 子集入口：可移植数据 ────────────────────────────────────────
export type * from './contracts.js'

// ── 合同：约定的常量表 ──────────────────────────────────────────
export {
  KnowledgeEmbeddingProfileIsolationMigration,
  KnowledgeIndexConfig,
  KnowledgeIndexStatuses,
  KnowledgeMatchTypes,
} from '../contract/constants.js'

// ── 产品面：类上方的 API 接口 ───────────────────────────────────
export type {
  KnowledgeChunkBuilderApi,
  KnowledgeContextApi,
  KnowledgeDomainApi,
  KnowledgeEmbeddingClientApi,
  KnowledgeEmbeddingsApi,
  KnowledgeIngestionApi,
  KnowledgeMaintenanceApi,
  KnowledgeMutationApi,
  KnowledgeQueryApi,
  KnowledgeQueryHelperApi,
  KnowledgeRepositoryApi,
  KnowledgeRowsApi,
  KnowledgeRuntimeApi,
  KnowledgeVectorQueryApi,
  KnowledgeVectorsApi,
  KnowledgeWorkspaceApi,
  VectorFailureMonitorApi,
  VectorFailureMonitorOptions,
} from '../contract/provides.js'

// ── 注入面：宿主要塞进来的东西 ──────────────────────────────────
export type {
  EmbeddingRequestFactory,
  KnowledgeApi,
  KnowledgeCodeIntelligenceApi,
  KnowledgeDatabaseProvider,
  KnowledgeEmbeddingConfigPort,
  KnowledgeHttpClient,
  KnowledgeIndexingPolicy,
  KnowledgeLanceDbConnection,
  KnowledgeLanceDbLoader,
  KnowledgeLanceDbModule,
  KnowledgeProjectApi,
  KnowledgeRuntimeProviders,
  KnowledgeStoragePathProvider,
  KnowledgeToolApi,
  KnowledgeToolContext,
} from '../contract/requires.js'

// ── 上面两面用到、又不在可移植文件里的数据 ──────────────────────
export type {
  KnowledgeCodeEdge,
  KnowledgeCodeFileNodeRequest,
  KnowledgeCodeNode,
  KnowledgeCodeNodeKind,
  KnowledgeCodeNodeRequest,
  KnowledgeCodeNodeSearchRequest,
  KnowledgeCodeRange,
  KnowledgeCodeRelevantContextRequest,
  KnowledgeCodeSearchResult,
  KnowledgeCodeSubgraph,
  KnowledgeCodeSymbol,
  KnowledgeCodeSymbolKind,
} from '../types/code.js'
export type {
  EmbeddingApiItem,
  EmbeddingApiResponse,
  EmbeddingRequest,
  EmbeddingRequestConfig,
  EmbeddingRuntimeSelection,
  KnowledgeEmbeddingRuntime,
  VectorFailureLogger,
} from '../types/host.js'
export type {
  KnowledgeCodeCandidateInput,
  KnowledgeCodeSyncResult,
  KnowledgeIndexedFileInspection,
  KnowledgeWorkspaceCodeCandidate,
  KnowledgeWorkspaceFileEntry,
  KnowledgeWorkspacePreparedDocument,
} from '../types/ingestion.js'
export type {
  EmbeddingProfileIdentity,
  EmbeddingRuntimeIdentity,
  HybridCandidate,
  IndexedRecordIdentity,
  KnowledgeChunk,
  KnowledgeChunkRecord,
  KnowledgeDocumentRow,
  KnowledgeFileIndexRecord,
  KnowledgeFileIndexRow,
  KnowledgeRelationalDiagnostics,
  KnowledgeTextSearchRow,
  KnowledgeVectorIndexRecord,
  KnowledgeVectorMatch,
  KnowledgeVectorRow,
  KnowledgeVectorSearchPartition,
  KnowledgeVectorWriteResult,
  LanceIndexDescriptor,
  RankedKnowledgeCandidate,
  TextSnippetSource,
  VectorStoreStatsInput,
  VectorStoreStatsOutput,
} from '../types/storage.js'
export type { KnowledgeTool } from '../types/tool.js'

// ── 工具集合 ────────────────────────────────────────────────────
export { knowledgeTools } from '../impl/KnowledgeTools.js'

// ── 运行时与工厂 ────────────────────────────────────────────────
export {
  createKnowledgeRuntime,
  KnowledgeRuntime as DefaultKnowledgeRuntime,
  KnowledgeRuntime,
} from '../impl/KnowledgeRuntime.js'

// ── 领域实现（收口轮改成按接口收窄，这一轮保持老名字出包）───────
export {
  KnowledgeChunkBuilder,
  KnowledgeChunkBuilder as KnowledgeChunks,
} from '../impl/domain/KnowledgeChunkBuilder.js'
export {
  KnowledgeContext as AgentKnowledgeHelper,
  KnowledgeContext,
} from '../impl/domain/KnowledgeContext.js'
export { KnowledgeDomain } from '../impl/domain/KnowledgeDomain.js'
export { KnowledgeIngestion } from '../impl/domain/KnowledgeIngestion.js'
export { KnowledgeMaintenance } from '../impl/domain/KnowledgeMaintenance.js'
export { KnowledgeMutation } from '../impl/domain/KnowledgeMutation.js'
export { KnowledgeQuery } from '../impl/domain/KnowledgeQuery.js'
export { KnowledgeQueryHelper } from '../impl/domain/KnowledgeQueryHelper.js'
export {
  KnowledgeWorkspace,
  KnowledgeWorkspace as KnowledgeWorkspaceStore,
} from '../impl/domain/KnowledgeWorkspace.js'

// ── 存储实现（同上）─────────────────────────────────────────────
export {
  KnowledgeEmbeddingClient as EmbeddingApi,
  KnowledgeEmbeddingClient as EmbeddingApiHelper,
} from '../impl/storage/KnowledgeEmbeddingClient.js'
export {
  KnowledgeEmbeddings as Embeddings,
  KnowledgeEmbeddings as EmbeddingService,
} from '../impl/storage/KnowledgeEmbeddings.js'
export {
  KnowledgeRepository as KnowledgeRepo,
  KnowledgeRepository,
} from '../impl/storage/KnowledgeRepository.js'
export {
  KnowledgeRows as KnowledgeRepositoryHelper,
  KnowledgeRows,
} from '../impl/storage/KnowledgeRows.js'
export {
  KnowledgeVectorQuery as KnowledgeVectorHelper,
  KnowledgeVectorQuery,
} from '../impl/storage/KnowledgeVectorQuery.js'
export {
  KnowledgeVectors,
  KnowledgeVectors as KnowledgeVectorStore,
} from '../impl/storage/KnowledgeVectors.js'
export {
  VectorFailureLogWindowMs,
  VectorFailureMonitor,
} from '../impl/storage/VectorFailureMonitor.js'

// ── 工具函数（同上）─────────────────────────────────────────────
export {
  createImportTargetCandidates,
  extractImports,
  extractSymbols,
  getCodeExtensions,
  isCodeFile,
  isLikelyTextFile,
  scorePathMatch,
} from '../utils/code.js'
export {
  buildDocumentRevisionKey,
  buildEmbeddingProfileIdentity,
  buildIndexTextHash,
  canReuseReadyContentIndex,
} from '../utils/indexing.js'
export { mergeHybridCandidates } from '../utils/query.js'
export { buildVectorStoreStats } from '../utils/vector-stats.js'
