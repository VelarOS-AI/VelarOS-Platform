/**
 * 可在浏览器中安全使用的知识数据传输对象与宿主契约。
 *
 * 本入口只导出类型；`SQLite`、`LanceDB`、摄入、工具和运行时实现仍由包根入口提供。
 */
export type {
  KnowledgeDiagnostics,
  KnowledgeEmbeddingProviderId,
  KnowledgeFileIndexStats,
  KnowledgeIndexRuntime,
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
  KnowledgeVectorIndexInfo,
  KnowledgeVectorStoreStats,
  KnowledgeWorkspaceSyncOptions,
  KnowledgeWorkspaceSyncResult,
  KnowledgeWorkspaceSyncState,
} from './knowledge/domain/Types.js'
