import type {
  KnowledgeEmbeddingProviderId,
  KnowledgeFileIndexStats,
  KnowledgeIndexStatus,
  KnowledgeRecord,
  KnowledgeSourceKind,
  KnowledgeSourceKindCounts,
} from '../../types/knowledge.js'
import type {
  KnowledgeDocumentRow,
  KnowledgeFileIndexRecord,
  KnowledgeFileIndexRow,
} from '../../types/storage.js'
import { buildSearchTagsText, parseJsonField, sanitizeFtsQuery } from '../../utils/rows.js'

/**
 * 知识仓库的行映射器：数据库行与领域结构之间来回翻译，顺带把 FTS 查询清洗干净。
 *
 * 实例由 `KnowledgeRepository` 持有；它不碰数据库连接，只做纯翻译。
 */
export interface KnowledgeRowsApi {
  /** 把一个值序列化成 JSON 字段。 */
  serializeJson(value: unknown): string
  /** 把 tags 数组拼成 FTS 可索引的一行文本。 */
  buildSearchTagsText(tags: string[]): string
  /** 把 `knowledge_documents` 行翻译成知识记录。 */
  mapKnowledgeRow(row: KnowledgeDocumentRow): KnowledgeRecord
  /** 把 `knowledge_file_index` 行翻译成文件索引快照。 */
  mapKnowledgeFileIndexRow(row: KnowledgeFileIndexRow): KnowledgeFileIndexRecord
  /** 造一份全零的来源类型统计，避免诊断结果缺字段。 */
  createEmptySourceKindCounts(): KnowledgeSourceKindCounts
  /** 按来源类型统计拼出文件索引诊断。 */
  buildKnowledgeFileIndexStats(
    trackedBySourceKind: KnowledgeSourceKindCounts
  ): KnowledgeFileIndexStats
  /** 把用户查询转成安全的 SQLite FTS MATCH 表达式。 */
  sanitizeFtsQuery(query: string): string
}

/** 见 {@link KnowledgeRowsApi}。 */
export class KnowledgeRows implements KnowledgeRowsApi {
  public serializeJson(value: unknown): string {
    return JSON.stringify(value)
  }

  public buildSearchTagsText(tags: string[]): string {
    return buildSearchTagsText(tags)
  }

  public mapKnowledgeRow(row: KnowledgeDocumentRow): KnowledgeRecord {
    return {
      id: row.id,
      workspaceRoot: row.workspace_root,
      path: row.path,
      title: row.title,
      summary: row.summary,
      content: row.content,
      sourceKind: row.source_kind as KnowledgeSourceKind,
      tags: parseJsonField<string[]>(row.tags_json, []),
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

  public createEmptySourceKindCounts(): KnowledgeSourceKindCounts {
    return {
      markdown: 0,
      text: 0,
      json: 0,
      config: 0,
      code: 0,
    }
  }

  public buildKnowledgeFileIndexStats(
    trackedBySourceKind: KnowledgeSourceKindCounts
  ): KnowledgeFileIndexStats {
    return {
      trackedFiles: Object.values(trackedBySourceKind).reduce((sum, count) => sum + count, 0),
      trackedBySourceKind,
    }
  }

  public sanitizeFtsQuery(query: string): string {
    return sanitizeFtsQuery(query)
  }
}
