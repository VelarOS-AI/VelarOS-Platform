/**
 * 知识库根入口（`@velaros-ai/velar/knowledge`），给 Node 宿主：代码面 `velar:knowledge` 的三个操作、知识库运行时与嵌入客户端两个工厂，
 * 产品面与注入面的接口，以及它们签名里用到的数据。类、工具函数与单元内部数据一律不出单元；
 * 另一个入口 `./knowledge/contracts` 是这里的子集，只有可移植数据。
 */

// ── 子集入口：常量表与可移植数据 ────────────────────────────────
export * from './contracts.js'

// ── 产品面：类上方的 API 接口 ───────────────────────────────────
export type {
  KnowledgeDomainApi,
  KnowledgeEmbeddingClientApi,
  KnowledgeOperationsApi,
  KnowledgeRuntimeApi,
  KnowledgeVectorsApi,
} from './contract/provides.js'

// ── 注入面：宿主与空间要塞进来的东西 ────────────────────────────
export type {
  KnowledgeCodeIntelligenceApi,
  KnowledgeDatabaseProvider,
  KnowledgeEmbeddingConfigPort,
  KnowledgeEmbeddingRequestFactory,
  KnowledgeHttpClient,
  KnowledgeIndexingPolicy,
  KnowledgeLanceDbConnection,
  KnowledgeLanceDbIndexOptions,
  KnowledgeLanceDbLoader,
  KnowledgeLanceDbMergeInsert,
  KnowledgeLanceDbModule,
  KnowledgeLanceDbSchema,
  KnowledgeLanceDbTable,
  KnowledgeLanceDbVectorQuery,
  KnowledgeOperationContext,
  KnowledgeRuntimeProviders,
  KnowledgeSpacePort,
  KnowledgeStoragePathProvider,
} from './contract/requires.js'

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
} from './types/code.js'
export type {
  EmbeddingApiItem,
  EmbeddingApiResponse,
  EmbeddingRequest,
  EmbeddingRequestConfig,
  KnowledgeEmbeddingRuntime,
} from './types/host.js'
export type {
  EmbeddingRuntimeIdentity,
  KnowledgeChunkRecord,
  KnowledgeVectorMatch,
  KnowledgeVectorRow,
  KnowledgeVectorWriteResult,
  LanceIndexDescriptor,
} from './types/storage.js'

// ── 模型面、运行时与工厂 ────────────────────────────────────────
export { knowledgeOperations } from './impl/KnowledgeOperations.js'
export { createKnowledgeRuntime } from './impl/KnowledgeRuntime.js'
export { createKnowledgeEmbeddingClient } from './impl/storage/KnowledgeEmbeddingClient.js'
