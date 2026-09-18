/**
 * 知识库根入口（`@velaros-ai/knowledge`），给 Node 宿主。
 *
 * 只出三样东西：产品面（`contract/provides.ts` 登记的接口与按接口标注的工厂）、注入面
 * （`contract/requires.ts` 的接口），以及它们签名里用到的数据与常量表。
 * 类、工具函数与包内数据一律不出包；另一个入口 `./contracts` 是这里的子集，只有可移植数据。
 */

// ── 子集入口：可移植数据 ────────────────────────────────────────
export type * from './contracts.js'

// ── 合同：约定的常量表 ──────────────────────────────────────────
export {
  KnowledgeEmbeddingProfileIsolationMigration,
  KnowledgeIndexConfig,
  KnowledgeIndexStatuses,
  KnowledgeMatchTypes,
  KnowledgeSourceKinds,
} from './contract/constants.js'

// ── 产品面：类上方的 API 接口 ───────────────────────────────────
export type {
  KnowledgeDomainApi,
  KnowledgeEmbeddingClientApi,
  KnowledgeRuntimeApi,
  KnowledgeVectorsApi,
} from './contract/provides.js'

// ── 注入面：宿主要塞进来的东西 ──────────────────────────────────
export type {
  KnowledgeCodeIntelligenceApi,
  KnowledgeDatabaseProvider,
  KnowledgeEmbeddingConfigPort,
  KnowledgeEmbeddingRequestFactory,
  KnowledgeHttpClient,
  KnowledgeIndexingPolicy,
  KnowledgeLanceDbConnection,
  KnowledgeLanceDbLoader,
  KnowledgeLanceDbModule,
  KnowledgeRuntimeProviders,
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
  KnowledgeVectorWriteResult,
} from './types/storage.js'

// ── 运行时与工厂 ────────────────────────────────────────────────
export { createKnowledgeRuntime } from './impl/KnowledgeRuntime.js'
export { createKnowledgeEmbeddingClient } from './impl/storage/KnowledgeEmbeddingClient.js'
