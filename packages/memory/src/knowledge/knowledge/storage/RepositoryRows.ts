import { isBlank } from '@velaros-ai/core'
import { logRuntime } from '@velaros-ai/core/logger'

import type {
  KnowledgeEmbeddingProviderId,
  KnowledgeFileIndexStats,
  KnowledgeIndexStatus,
  KnowledgeRecord,
  KnowledgeSourceKind,
  KnowledgeSourceKindCounts,
} from '../domain/Types'

const log = logRuntime.tag('KnowledgeRepositoryRows')

/** SQLite knowledge_documents 表行。 */
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

/** SQLite knowledge_chunks 表中的 chunk 元数据。 */
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

/** SQLite knowledge_vector_indexes 中登记的一份可独立检索的向量派生物。 */
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

/** 查询当前 profile 时需要访问的一个物理向量分区。 */
export interface KnowledgeVectorSearchPartition {
  embeddingDimensions: number
  vectorTable: string
  documentRevisionKeys: string[]
}

/** SQLite knowledge_file_index 表行。 */
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

/** 文件索引快照领域结构。 */
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

/** FTS 文本搜索候选行。 */
export interface KnowledgeTextSearchRow {
  document_id: string
  path: string
  title: string
  summary: string
  content: string
  tags: string
  rank: number
}

/**
 * 知识仓库辅助方法。
 *
 * 负责数据库行映射、JSON 容错解析、FTS 查询清洗和文件索引统计构造。
 */
export class KnowledgeRows {
  /** 序列化 JSON 字段。 */
  public serializeJson(value: unknown): string {
    return JSON.stringify(value)
  }

  /** 将 tags 数组转成 FTS 可索引文本。 */
  public buildSearchTagsText(tags: string[]): string {
    return tags
      .map((tag) => tag.trim())
      .filter((tag) => !isBlank(tag))
      .join(' ')
  }

  /** 将 knowledge_documents 行映射成 KnowledgeRecord。 */
  public mapKnowledgeRow(row: KnowledgeDocumentRow): KnowledgeRecord {
    return {
      id: row.id,
      workspaceRoot: row.workspace_root,
      path: row.path,
      title: row.title,
      summary: row.summary,
      content: row.content,
      sourceKind: row.source_kind as KnowledgeSourceKind,
      tags: this.parseJson<string[]>(row.tags_json, []),
      indexStatus: row.index_status as KnowledgeIndexStatus,
      indexError: row.index_error,
      chunkCount: row.chunk_count,
      indexTextHash: row.index_text_hash ?? '',
      embeddingProvider: (row.embedding_provider ?? '') as KnowledgeEmbeddingProviderId | '',
      embeddingModel: row.embedding_model ?? '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAccessedAt: row.last_accessed_at,
    }
  }

  /** 将 knowledge_file_index 行映射成文件索引快照。 */
  public mapKnowledgeFileIndexRow(row: KnowledgeFileIndexRow): KnowledgeFileIndexRecord {
    return {
      knowledgeId: row.knowledge_id,
      workspaceRoot: row.workspace_root,
      path: row.path,
      sourceKind: row.source_kind as KnowledgeSourceKind,
      fileSize: row.file_size,
      modifiedAt: row.modified_at,
      contentHash: row.content_hash ?? '',
      indexRuntimeKey: row.index_runtime_key ?? '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastSeenAt: row.last_seen_at,
    }
  }

  /** 创建所有来源类型的零值统计，避免诊断结果缺字段。 */
  public createEmptySourceKindCounts(): KnowledgeSourceKindCounts {
    return {
      markdown: 0,
      text: 0,
      json: 0,
      config: 0,
      code: 0,
    }
  }

  /** 构建文件索引诊断统计。 */
  public buildKnowledgeFileIndexStats(
    trackedBySourceKind: KnowledgeSourceKindCounts
  ): KnowledgeFileIndexStats {
    return {
      trackedFiles: Object.values(trackedBySourceKind).reduce((sum, count) => sum + count, 0),
      trackedBySourceKind,
    }
  }

  /** 将用户查询转为安全的 SQLite FTS MATCH 表达式。 */
  public sanitizeFtsQuery(query: string): string {
    const normalized = query.replace(/[^\p{L}\p{N}\s/_-]/gu, ' ').trim()

    if (isBlank(normalized)) return ''

    return (
      normalized
        .split(/\s+/)
        .filter((term) => !isBlank(term))
        // 每个词单独加引号并用 OR 连接，避免特殊字符影响 FTS 语法。
        .map((term) => `"${term.replaceAll('"', '""')}"`)
        .join(' OR ')
    )
  }

  /** 安全解析 JSON，坏数据时返回 fallback。 */
  private parseJson<T>(raw: string, fallback: T): T {
    if (isBlank(raw)) return fallback

    try {
      return JSON.parse(raw) as T
    } catch (error) {
      log.debug('解析 knowledge JSON 字段失败，使用 fallback', {
        error: String(error),
      })
      return fallback
    }
  }
}
