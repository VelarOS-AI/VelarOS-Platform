/**
 * 知识库的可移植数据：知识库经宿主与空间端口流动的形状，以及模型面（`velar:knowledge` 的入参与回执，带 @AgentView 的那些）。
 * 只从常量表 import 类型、不带函数成员、不用 Node 专属类型，整个文件随 `./knowledge/contracts` 入口出单元。
 */

import type { KnowledgeIndexStatuses, KnowledgeMatchTypes } from '../contract/constants.js'

/** 嵌入服务商的不透明身份，由宿主的嵌入适配层给出；本单元不认识模型目录。 */
export type KnowledgeEmbeddingProviderId = string

export type KnowledgeIndexStatus =
  typeof KnowledgeIndexStatuses[keyof typeof KnowledgeIndexStatuses]
export type KnowledgeMatchType =
  typeof KnowledgeMatchTypes[keyof typeof KnowledgeMatchTypes]
/** @AgentView 知识来源类型：markdown、text（纯文本）、json、config（配置文件）、code（代码知识）。 */
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

/**
 * @AgentView
 * 同步结果：扫了多少个文件，新建或更新了多少份文档（upserted），重建了多少份的索引（reindexed，reindexBlocked 是该重建却没能重建的），
 * 删掉了多少份已经不在的，跳过了多少个没变的；forced 说这次是不是强制重扫。
 */
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

/** @AgentView 一个工作区最近一次同步的时刻（毫秒时间戳）。 */
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

// ── 模型面：velar:knowledge 的入参与回执 ────────────────────────

/**
 * @AgentView
 * 检索：query 必填。workspaceRoot 不给就是当前空间的工作区（环境报告里写着）；空间没有默认工作区时要给。
 * sourceKinds 只要这几类来源；pathHints、symbolHints 是路径与符号提示，抬高相关文件与代码的排序，各最多 20 条；
 * documentIds 把范围限定在这些文档上，最多 100 个；limit 要几条命中，默认 8，最多 50。
 */
export interface KnowledgeSearchInput {
  query: string
  workspaceRoot?: string
  sourceKinds?: KnowledgeSourceKind[]
  pathHints?: string[]
  symbolHints?: string[]
  documentIds?: string[]
  limit?: number
}

/**
 * @AgentView
 * 一条命中：content 是整份正文，snippet 是命中处的片段，score 越大越相关。
 * matchType 说怎么命中的：vector（语义）、text（全文）、hybrid（两者都中）、recent（空查询时的最近文档）。
 * indexStatus 不是 ready 的文档只做过一部分索引；indexError 只在索引出过错时出现。updatedAt 是毫秒时间戳。
 */
export interface KnowledgeHit {
  id: string
  path: string
  title: string
  summary: string
  snippet: string
  content: string
  sourceKind: KnowledgeSourceKind
  tags: string[]
  score: number
  matchType: 'vector' | 'text' | 'hybrid' | 'recent'
  indexStatus: 'pending' | 'ready' | 'partial' | 'failed'
  indexError?: string
  updatedAt: number
}

/**
 * @AgentView
 * 命中里记着的一类索引问题：怎么回事（sample 是其中一条原文）、影响了哪些文档、该怎么办（guidance）。
 * actionable 为真的要用户去处理（比如修嵌入凭据），照 guidance 告诉用户。
 */
export interface KnowledgeIndexIssue {
  kind: 'embedding-auth-invalid-issuer' | 'embedding-auth' | 'index-error'
  count: number
  sample: string
  actionable: boolean
  guidance: string
  affectedDocumentIds: string[]
}

/**
 * @AgentView
 * 检索结果：results 按相关度排好。autoSync 只在这次零命中、自动为这个工作区补过一次增量索引并重搜过时出现——
 * 它出现而 count 仍为 0，就是这个工作区里真没有，不要再 sync 重试。
 */
export interface KnowledgeFound {
  workspaceRoot: string
  count: number
  results: KnowledgeHit[]
  indexIssues: KnowledgeIndexIssue[]
  autoSync?: { scanned: number; indexed: number }
}

/** @AgentView 同步：两项都可以不给（写 sync({})）；workspaceRoot 同检索，force 为真就跳过短时节流、马上重扫。 */
export interface KnowledgeSyncInput {
  workspaceRoot?: string
  force?: boolean
}

/**
 * @AgentView
 * 索引健康：文档总数与各索引状态的数量；outdated 是内容策略变了、该重新同步的。
 * activeProfile 两项是当前嵌入模型（embedding）已经覆盖、还没覆盖的文档数——没覆盖的只能走全文检索。
 * trackedFiles 是在跟踪的文件数，vectorRows 是向量行数；workspaces 是本次运行同步过的工作区。
 */
export interface KnowledgeHealth {
  totalDocuments: number
  readyDocuments: number
  pendingDocuments: number
  partialDocuments: number
  failedDocuments: number
  outdatedDocuments: number
  activeProfileIndexedDocuments: number
  activeProfileMissingDocuments: number
  totalChunks: number
  trackedFiles: number
  vectorRows: number
  embedding: { provider: string; model: string }
  workspaces: KnowledgeWorkspaceSyncState[]
}
