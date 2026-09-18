/** 存储层的数据形状：SQLite 行与领域记录、向量行与命中、嵌入 profile 身份、检索候选与向量库统计。 */

import type {
  KnowledgeEmbeddingProviderId,
  KnowledgeFileIndexStats,
  KnowledgeIndexStatus,
  KnowledgeSearchResult,
  KnowledgeSourceKind,
} from './knowledge.js'

/** SQLite `knowledge_documents` 表的一行。 */
export interface KnowledgeDocumentRow {
  id: string
  workspace_root: string
  path: string
  title: string
  summary: string
  content: string
  source_kind: string
  tags_json: string
  index_status: string
  index_error: string
  chunk_count: number
  index_text_hash: string
  embedding_provider: string
  embedding_model: string
  created_at: number
  updated_at: number
  last_accessed_at: number
}

/** SQLite `knowledge_chunks` 表里的一条分块元数据；向量本身只在写入链路上流动，不落 SQLite。 */
export interface KnowledgeChunkRecord {
  id: string
  documentId: string
  chunkIndex: number
  content: string
  embedding: number[]
  embeddingModel: string
  embeddingDimensions: number
  createdAt: number
  updatedAt: number
}

/** SQLite `knowledge_vector_indexes` 里登记的一份可独立检索的向量派生物。 */
export interface KnowledgeVectorIndexRecord {
  documentId: string
  indexTextHash: string
  embeddingProvider: KnowledgeEmbeddingProviderId
  embeddingModel: string
  embeddingDimensions: number
  profileKey: string
  vectorTable: string
  chunkCount: number
  createdAt: number
  updatedAt: number
}

/** 查询当前 profile 时要访问的一个物理向量分区。 */
export interface KnowledgeVectorSearchPartition {
  embeddingDimensions: number
  vectorTable: string
  documentRevisionKeys: string[]
}

/** SQLite `knowledge_file_index` 表的一行。 */
export interface KnowledgeFileIndexRow {
  knowledge_id: string
  workspace_root: string
  path: string
  source_kind: string
  file_size: number
  modified_at: number
  content_hash: string
  index_runtime_key: string
  created_at: number
  updated_at: number
  last_seen_at: number
}

/** 文件索引快照的领域结构。 */
export interface KnowledgeFileIndexRecord {
  knowledgeId: string
  workspaceRoot: string
  path: string
  sourceKind: KnowledgeSourceKind
  fileSize: number
  modifiedAt: number
  contentHash: string
  indexRuntimeKey: string
  createdAt: number
  updatedAt: number
  lastSeenAt: number
}

/** FTS 文本搜索返回的一条候选行。 */
export interface KnowledgeTextSearchRow {
  document_id: string
  path: string
  title: string
  summary: string
  content: string
  tags: string
  rank: number
}

/** SQLite `knowledge_vector_indexes` 的原始查询行。 */
export interface KnowledgeVectorIndexRow {
  document_id: string
  index_text_hash: string
  embedding_provider: string
  embedding_model: string
  embedding_dimensions: number
  profile_key: string
  vector_table: string
  chunk_count: number
  created_at: number
  updated_at: number
}

/** LanceDB 里 profile 专属向量表的一行。 */
export interface KnowledgeVectorRow extends Record<string, unknown> {
  chunk_id: string
  document_id: string
  document_revision_key: string
  index_text_hash: string
  workspace_root: string
  path: string
  chunk_index: number
  content: string
  updated_at: number
  vector: number[]
}

/** 向量检索命中的一个知识 chunk。 */
export interface KnowledgeVectorMatch {
  documentId: string
  chunkId: string
  content: string
  distance: number
}

/** 一次向量写入的结果：写进了哪个 profile 的哪张表、多少行。 */
export interface KnowledgeVectorWriteResult {
  embeddingDimensions: number
  profileKey: string
  vectorTable: string
  chunkCount: number
}

/** 可被知识索引写入的一段文本。 */
export interface KnowledgeChunk {
  index: number
  content: string
}

/** 代码文件按符号或行段切出来的一个内容区块。 */
export interface CodeChunkSection {
  label: string
  content: string
}

/** 一次嵌入运行时的身份：provider 与 model。 */
export interface EmbeddingRuntimeIdentity {
  provider: KnowledgeEmbeddingProviderId
  model: string
}

/** 一个不可混算的向量空间：provider、model、dimensions 三者共同定义。 */
export interface EmbeddingProfileIdentity extends EmbeddingRuntimeIdentity {
  dimensions: number
  profileKey: string
  vectorTable: string
}

/** 判断一份已有索引能不能复用时要看的字段。 */
export interface IndexedRecordIdentity {
  indexStatus: KnowledgeIndexStatus
  chunkCount: number
  indexTextHash: string
  archived?: boolean
}

/** 混合评分阶段的一条候选。 */
export interface HybridCandidate {
  id: string
  score: number
  snippet: string
  matchType: string
}

/** 召回阶段产生的统一候选。 */
export interface RankedKnowledgeCandidate {
  documentId: string
  score: number
  snippet: string
  matchType: KnowledgeSearchResult['matchType']
}

/** 构建文本命中摘要要用到的字段集合。 */
export interface TextSnippetSource {
  title: string
  summary: string
  content: string
  path: string
  tags: string
}

/** LanceDB 报出来的一个索引描述。 */
export interface LanceIndexDescriptor {
  name: string
  indexType: string
  columns: readonly string[]
}

/** 汇总向量库统计的入参。 */
export interface VectorStoreStatsInput {
  path: string
  tableName: string
  rowCount: number
  dimensions: Nullable<number>
  indices: readonly LanceIndexDescriptor[]
}

/** 汇总向量库统计的出参。 */
export interface VectorStoreStatsOutput {
  path: string
  tableName: string
  rowCount: number
  dimensions: Nullable<number>
  indices: Array<{ name: string; type: string; columns: string[] }>
}

/** SQLite 侧的诊断统计（向量库与同步台账由别处合流补齐）。 */
export interface KnowledgeRelationalDiagnostics {
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
}
