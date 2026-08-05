import type {
  KnowledgeIndexStatuses,
  KnowledgeMatchTypes,
} from '../../Constants'

/** Opaque provider identity supplied by an embedding host adapter. */
export type KnowledgeEmbeddingProviderId = string

export type KnowledgeIndexStatus =
  typeof KnowledgeIndexStatuses[keyof typeof KnowledgeIndexStatuses]
export type KnowledgeMatchType =
  typeof KnowledgeMatchTypes[keyof typeof KnowledgeMatchTypes]
export type KnowledgeSourceKind = 'markdown' | 'text' | 'json' | 'config' | 'code'

export interface KnowledgeRecord {
  id: string
  workspaceRoot: string
  path: string
  title: string
  summary: string
  content: string
  sourceKind: KnowledgeSourceKind
  tags: string[]
  indexStatus: KnowledgeIndexStatus
  indexError: string
  chunkCount: number
  indexTextHash: string
  embeddingProvider: KnowledgeEmbeddingProviderId | ''
  embeddingModel: string
  createdAt: number
  updatedAt: number
  lastAccessedAt: number
}

export interface KnowledgeUpsertInput {
  workspaceRoot: string
  path: string
  title: string
  summary?: string
  content: string
  sourceKind: KnowledgeSourceKind
  tags?: string[]
}

export interface KnowledgeSearchOptions {
  workspaceRoot: string
  limit?: number
  sourceKinds?: KnowledgeSourceKind[]
  pathHints?: string[]
  symbolHints?: string[]
  documentIds?: string[]
}

export interface KnowledgeSearchResult extends KnowledgeRecord {
  score: number
  matchType: KnowledgeMatchType
  snippet: string
}

export interface KnowledgeWorkspaceSyncOptions {
  force?: boolean
}

export interface KnowledgeWorkspaceSyncResult {
  workspaceRoot: string
  scanned: number
  upserted: number
  reindexed: number
  reindexBlocked: number
  removed: number
  skipped: number
  forced: boolean
}

export interface KnowledgeReindexOptions {
  ids?: string[]
  statuses?: KnowledgeIndexStatus[]
  limit?: number
  includeOutdated?: boolean
  sourceKinds?: KnowledgeSourceKind[]
  workspaceRoot?: string
}

export interface KnowledgeReindexFailure {
  documentId: string
  message: string
}

export interface KnowledgeReindexResult {
  requested: number
  succeeded: number
  failed: number
  failures: KnowledgeReindexFailure[]
}

export interface KnowledgeVectorIndexInfo {
  name: string
  type: string
  columns: string[]
}

export type KnowledgeSourceKindCounts = Record<KnowledgeSourceKind, number>

export interface KnowledgeFileIndexStats {
  trackedFiles: number
  trackedBySourceKind: KnowledgeSourceKindCounts
}

export interface KnowledgeVectorStoreStats {
  path: string
  tableName: string
  rowCount: number
  dimensions: Nullable<number>
  indices: KnowledgeVectorIndexInfo[]
}

export interface KnowledgeIndexRuntime {
  provider: KnowledgeEmbeddingProviderId
  model: string
  indexRuntimeKey: string
}

/** 一个工作区在本次运行里的最近同步时刻（进程内 TTL 台账的投影）。 */
export interface KnowledgeWorkspaceSyncState {
  workspaceRoot: string
  lastSyncedAt: number
}

export interface KnowledgeDiagnostics {
  /** 本次运行同步过的工作区；空 = 本次运行还没同步过任何工作区。 */
  workspaceSyncs: readonly KnowledgeWorkspaceSyncState[]
  totalDocuments: number
  pendingDocuments: number
  readyDocuments: number
  partialDocuments: number
  failedDocuments: number
  outdatedDocuments: number
  activeProfileIndexedDocuments: number
  activeProfileMissingDocuments: number
  preservedVectorIndexes: number
  embeddingProfileCount: number
  totalChunks: number
  fileIndex: KnowledgeFileIndexStats
  vectorStore: KnowledgeVectorStoreStats
  runtime: KnowledgeIndexRuntime
}
