import { compact, isBlank,isEmpty } from '@velaros-ai/core'

import { KnowledgeIndexStatuses } from '../../Constants'
import { buildDocumentRevisionKey } from '../../shared'
import type { KnowledgeDatabaseProvider } from '../../Types'
import type {
  KnowledgeDiagnostics,
  KnowledgeEmbeddingProviderId,
  KnowledgeIndexRuntime,
  KnowledgeIndexStatus,
  KnowledgeRecord,
  KnowledgeReindexOptions,
  KnowledgeSearchOptions,
  KnowledgeSourceKind,
} from '../domain/Types'

import {
  type KnowledgeChunkRecord,
  type KnowledgeDocumentRow,
  type KnowledgeFileIndexRecord,
  type KnowledgeFileIndexRow,
  type KnowledgeRows,
  type KnowledgeTextSearchRow,
  type KnowledgeVectorIndexRecord,
  type KnowledgeVectorSearchPartition,
} from './RepositoryRows'

/** knowledge_search_fts 的 bm25 列权重：路径/标题/摘要/正文/标签分别承担不同召回信号。 */
const KNOWLEDGE_TEXT_BM25_COLUMN_WEIGHTS = [0, 5, 10, 6, 1.5, 4] as const
const KNOWN_KNOWLEDGE_SOURCE_KINDS = new Set<string>(['markdown', 'text', 'json', 'config', 'code'])

interface KnowledgeVectorIndexRow {
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

/**
 * 知识 SQLite 仓库。
 *
 * 保存知识文档、chunk 元数据、文件索引快照和 FTS 文本索引；
 * 真实向量数据由 KnowledgeVectors 保存到 LanceDB。
 */
class KnowledgeRepo {
  constructor(
    private readonly helper: KnowledgeRows,
    private readonly databaseProvider: KnowledgeDatabaseProvider
  ) {}

  /** 获取主 SQLite 连接。 */
  private get db(): ReturnType<KnowledgeDatabaseProvider> {
    return this.databaseProvider()
  }

  /** 同步事务执行器，保证文档、FTS、chunk 表成组更新。 */
  private runInTransaction(fn: () => void): void {
    this.db.transaction(fn)()
  }

  /** 新建或更新知识文档，并刷新全文搜索索引。 */
  public upsertKnowledge(record: KnowledgeRecord): void {
    const statement = this.db.prepare(`
      INSERT INTO knowledge_documents (
        id, workspace_root, path, title, summary, content, source_kind, tags_json,
        index_status, index_error, chunk_count, index_text_hash, embedding_provider,
        embedding_model, created_at, updated_at, last_accessed_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        workspace_root = excluded.workspace_root,
        path = excluded.path,
        title = excluded.title,
        summary = excluded.summary,
        content = excluded.content,
        source_kind = excluded.source_kind,
        tags_json = excluded.tags_json,
        index_status = excluded.index_status,
        index_error = excluded.index_error,
        chunk_count = excluded.chunk_count,
        index_text_hash = excluded.index_text_hash,
        embedding_provider = excluded.embedding_provider,
        embedding_model = excluded.embedding_model,
        updated_at = excluded.updated_at,
        last_accessed_at = excluded.last_accessed_at
    `)

    const deleteSearchDocument = this.db.prepare(`
      DELETE FROM knowledge_search_fts
      WHERE document_id = ?
    `)
    const insertSearchDocument = this.db.prepare(`
      INSERT INTO knowledge_search_fts (
        document_id, path, title, summary, content, tags
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)

    this.runInTransaction(() => {
      // knowledge_documents 是文档事实来源；FTS 索引稍后用相同记录刷新。
      statement.run(
        record.id,
        record.workspaceRoot,
        record.path,
        record.title,
        record.summary,
        record.content,
        record.sourceKind,
        this.helper.serializeJson(record.tags),
        record.indexStatus,
        record.indexError,
        record.chunkCount,
        record.indexTextHash,
        record.embeddingProvider,
        record.embeddingModel,
        record.createdAt,
        record.updatedAt,
        record.lastAccessedAt
      )

      // SQLite FTS 不自动跟随主表更新，因此每次 upsert 都显式替换文档索引。
      deleteSearchDocument.run(record.id)
      insertSearchDocument.run(
        record.id,
        record.path,
        record.title,
        record.summary,
        record.content,
        this.helper.buildSearchTagsText(record.tags)
      )
    })
  }

  /** 写入或刷新文件索引快照。 */
  public upsertFileIndex(record: KnowledgeFileIndexRecord): void {
    this.db
      .prepare(
        `
      INSERT INTO knowledge_file_index (
        knowledge_id, workspace_root, path, source_kind, file_size, modified_at,
        content_hash, index_runtime_key, created_at, updated_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(knowledge_id) DO UPDATE SET
        workspace_root = excluded.workspace_root,
        path = excluded.path,
        source_kind = excluded.source_kind,
        file_size = excluded.file_size,
        modified_at = excluded.modified_at,
        content_hash = excluded.content_hash,
        index_runtime_key = excluded.index_runtime_key,
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at
    `
      )
      .run(
        record.knowledgeId,
        record.workspaceRoot,
        record.path,
        record.sourceKind,
        record.fileSize,
        record.modifiedAt,
        record.contentHash,
        record.indexRuntimeKey,
        record.createdAt,
        record.updatedAt,
        record.lastSeenAt
      )
  }

  /** 按 id 查询知识文档。 */
  public findKnowledgeById(id: string): Nullable<KnowledgeRecord> {
    const row = this.db
      .prepare('SELECT * FROM knowledge_documents WHERE id = ? LIMIT 1')
      .get(id) as KnowledgeDocumentRow | undefined

    return row ? this.helper.mapKnowledgeRow(row) : null
  }

  /** 按工作区和相对路径查询知识文档。 */
  public findKnowledgeByWorkspaceAndPath(workspaceRoot: string, path: string): Nullable<KnowledgeRecord> {
    const row = this.db
      .prepare(
        `
        SELECT * FROM knowledge_documents
        WHERE workspace_root = ? AND path = ?
        LIMIT 1
      `
      )
      .get(workspaceRoot, path) as KnowledgeDocumentRow | undefined

    return row ? this.helper.mapKnowledgeRow(row) : null
  }

  /** 按工作区和路径查询文件索引快照。 */
  public findFileIndexByWorkspaceAndPath(
    workspaceRoot: string,
    path: string
  ): Nullable<KnowledgeFileIndexRecord> {
    const row = this.db
      .prepare(
        `
        SELECT * FROM knowledge_file_index
        WHERE workspace_root = ? AND path = ?
        LIMIT 1
      `
      )
      .get(workspaceRoot, path) as KnowledgeFileIndexRow | undefined

    return row ? this.helper.mapKnowledgeFileIndexRow(row) : null
  }

  /** 批量查询知识文档，并按入参 id 顺序返回。 */
  public findKnowledgeByIds(ids: string[]): KnowledgeRecord[] {
    if (isEmpty(ids)) return []

    // SQL IN 不保证返回顺序，查询后用 Map 重新对齐调用方的候选排序。
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db
      .prepare(`SELECT * FROM knowledge_documents WHERE id IN (${placeholders})`)
      .all(...ids) as KnowledgeDocumentRow[]

    const rowMap = new Map(rows.map((row) => [row.id, this.helper.mapKnowledgeRow(row)]))
    return compact(ids.map((id) => rowMap.get(id)))
  }

  /** 列出某个工作区下指定来源类型的知识文档。 */
  public listKnowledgeByWorkspaceRoot(
    workspaceRoot: string,
    sourceKinds?: KnowledgeSourceKind[]
  ): KnowledgeRecord[] {
    const filters = ['workspace_root = ?']
    const params: unknown[] = [workspaceRoot]

    if (sourceKinds && !isEmpty(sourceKinds)) {
      filters.push(`source_kind IN (${sourceKinds.map(() => '?').join(', ')})`)
      params.push(...sourceKinds)
    }

    const rows = this.db
      .prepare(
        `
      SELECT * FROM knowledge_documents
      WHERE ${filters.join(' AND ')}
      ORDER BY path ASC
    `
      )
      .all(...params) as KnowledgeDocumentRow[]

    return rows.map((row) => this.helper.mapKnowledgeRow(row))
  }

  /** 列出某个工作区下的文件索引快照。 */
  public listFileIndexByWorkspaceRoot(
    workspaceRoot: string,
    sourceKinds?: KnowledgeSourceKind[]
  ): KnowledgeFileIndexRecord[] {
    const filters = ['workspace_root = ?']
    const params: unknown[] = [workspaceRoot]

    if (sourceKinds && !isEmpty(sourceKinds)) {
      filters.push(`source_kind IN (${sourceKinds.map(() => '?').join(', ')})`)
      params.push(...sourceKinds)
    }

    const rows = this.db
      .prepare(
        `
      SELECT * FROM knowledge_file_index
      WHERE ${filters.join(' AND ')}
      ORDER BY path ASC
    `
      )
      .all(...params) as KnowledgeFileIndexRow[]

    return rows.map((row) => this.helper.mapKnowledgeFileIndexRow(row))
  }

  /** 查询需要重建索引的知识文档。 */
  public listKnowledgeForReindex(
    options: KnowledgeReindexOptions,
    runtime: Nullable<KnowledgeIndexRuntime> = null
  ): KnowledgeRecord[] {
    const filters: string[] = []
    const params: unknown[] = []

    if (options.ids && !isEmpty(options.ids)) {
      filters.push(`d.id IN (${options.ids.map(() => '?').join(', ')})`)
      params.push(...options.ids)
    }

    if (options.workspaceRoot && !isBlank(options.workspaceRoot)) {
      filters.push('d.workspace_root = ?')
      params.push(options.workspaceRoot)
    }

    if (options.sourceKinds && !isEmpty(options.sourceKinds)) {
      filters.push(`d.source_kind IN (${options.sourceKinds.map(() => '?').join(', ')})`)
      params.push(...options.sourceKinds)
    }

    const candidateFilters: string[] = []
    if (options.statuses && !isEmpty(options.statuses)) {
      candidateFilters.push(`d.index_status IN (${options.statuses.map(() => '?').join(', ')})`)
      params.push(...options.statuses)
    }

    if ((!!options.includeOutdated) && runtime) {
      // 手动修复可补当前 profile 缺失的向量；模型切换本身不会自动调用这里。
      candidateFilters.push(
        `
        (
          d.index_text_hash = ''
          OR fi.knowledge_id IS NULL
          OR fi.index_runtime_key <> ?
          OR NOT EXISTS (
            SELECT 1
            FROM knowledge_vector_indexes vi
            WHERE vi.document_id = d.id
              AND vi.index_text_hash = d.index_text_hash
              AND vi.embedding_provider = ?
              AND vi.embedding_model = ?
          )
        )
      `.trim()
      )
      params.push(runtime.indexRuntimeKey, runtime.provider, runtime.model)
    }

    if (!isEmpty(candidateFilters)) {
      filters.push(`(${candidateFilters.join(' OR ')})`)
    }

    const sql = `
      SELECT d.*
      FROM knowledge_documents d
      LEFT JOIN knowledge_file_index fi ON fi.knowledge_id = d.id
      ${!isEmpty(filters) ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY d.updated_at DESC
      LIMIT ?
    `
    const rows = this.db
      .prepare(sql)
      .all(...params, options.limit ?? 50) as KnowledgeDocumentRow[]

    return rows.map((row) => this.helper.mapKnowledgeRow(row))
  }

  /** 删除知识文档、FTS 文档和 chunk 元数据。 */
  public deleteKnowledge(id: string): void {
    this.runInTransaction(() => {
      this.db.prepare('DELETE FROM knowledge_search_fts WHERE document_id = ?').run(id)
      this.db.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?').run(id)
      this.db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(id)
    })
  }

  /** 替换 SQLite 中的 chunk 元数据。 */
  public replaceChunks(documentId: string, chunks: KnowledgeChunkRecord[]): void {
    this.runInTransaction(() => {
      // chunk 是一次索引构建的快照，重建时整组替换以避免残留旧分块。
      this.db.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?').run(documentId)

      const insertChunk = this.db.prepare(`
        INSERT INTO knowledge_chunks (
          id, document_id, chunk_index, content, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)

      for (const chunk of chunks) {
        insertChunk.run(
          chunk.id,
          chunk.documentId,
          chunk.chunkIndex,
          chunk.content,
          chunk.createdAt,
          chunk.updatedAt
        )
      }
    })
  }

  /** 登记一份已成功写入的 profile/content-revision 向量派生物。 */
  public upsertVectorIndex(record: KnowledgeVectorIndexRecord): void {
    this.db
      .prepare(
        `
        INSERT INTO knowledge_vector_indexes (
          document_id, index_text_hash, embedding_provider, embedding_model,
          embedding_dimensions, profile_key, vector_table, chunk_count,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(
          document_id,
          index_text_hash,
          embedding_provider,
          embedding_model,
          embedding_dimensions,
          vector_table
        ) DO UPDATE SET
          profile_key = excluded.profile_key,
          chunk_count = excluded.chunk_count,
          updated_at = excluded.updated_at
      `
      )
      .run(
        record.documentId,
        record.indexTextHash,
        record.embeddingProvider,
        record.embeddingModel,
        record.embeddingDimensions,
        record.profileKey,
        record.vectorTable,
        record.chunkCount,
        record.createdAt,
        record.updatedAt
      )
  }

  /** 隐私删除前列出该文档曾写入的所有物理 profile 表。 */
  public listVectorTablesForDocument(documentId: string): string[] {
    const rows = this.db
      .prepare(
        `
        SELECT DISTINCT vector_table
        FROM knowledge_vector_indexes
        WHERE document_id = ?
      `
      )
      .all(documentId) as Array<{ vector_table: string }>

    return rows.map((row) => row.vector_table).filter((value) => !isBlank(value))
  }

  /** 更新索引状态、错误信息和 chunk 数。 */
  public updateIndexState(
    documentId: string,
    status: KnowledgeIndexStatus,
    errorMessage: string,
    chunkCount: number,
    updatedAt: number
  ): void {
    this.db
      .prepare(
        `
        UPDATE knowledge_documents
        SET index_status = ?, index_error = ?, chunk_count = ?, updated_at = ?
        WHERE id = ?
      `
      )
      .run(status, errorMessage, chunkCount, updatedAt, documentId)
  }

  /**
   * 当前 provider/model 的向量物理分区。
   *
   * 必须同时匹配文档当前 index_text_hash；其它模型与旧内容版本在向量通道中不可见。
   */
  public listVectorSearchPartitions(
    workspaceRoot: string,
    runtime: { provider: KnowledgeEmbeddingProviderId; model: string },
    options: Pick<KnowledgeSearchOptions, 'sourceKinds' | 'documentIds'>,
    limit: number
  ): KnowledgeVectorSearchPartition[] {
    const filters = [
      'd.workspace_root = ?',
      'vi.index_text_hash = d.index_text_hash',
      'vi.embedding_provider = ?',
      'vi.embedding_model = ?',
    ]
    const params: unknown[] = [workspaceRoot, runtime.provider, runtime.model]

    if (options.sourceKinds && !isEmpty(options.sourceKinds)) {
      filters.push(`d.source_kind IN (${options.sourceKinds.map(() => '?').join(', ')})`)
      params.push(...options.sourceKinds)
    }

    if (options.documentIds && !isEmpty(options.documentIds)) {
      // 代码搜索会先同步候选文档，再用 documentIds 缩小向量搜索范围。
      filters.push(`d.id IN (${options.documentIds.map(() => '?').join(', ')})`)
      params.push(...options.documentIds)
    }

    const rows = this.db
      .prepare(
        `
        SELECT vi.*
        FROM knowledge_vector_indexes vi
        JOIN knowledge_documents d ON d.id = vi.document_id
        WHERE ${filters.join(' AND ')}
        ORDER BY d.updated_at DESC, vi.updated_at DESC
        LIMIT ?
      `
      )
      .all(...params, limit) as KnowledgeVectorIndexRow[]

    const partitions = new Map<string, KnowledgeVectorSearchPartition>()
    for (const row of rows) {
      const partitionKey = [
        row.vector_table,
        row.embedding_dimensions,
      ].join('::')
      const partition = partitions.get(partitionKey) ?? {
        embeddingDimensions: row.embedding_dimensions,
        vectorTable: row.vector_table,
        documentRevisionKeys: [],
      }
      partition.documentRevisionKeys.push(
        buildDocumentRevisionKey(row.document_id, row.index_text_hash)
      )
      partitions.set(partitionKey, partition)
    }

    return [...partitions.values()]
  }

  /** 使用 SQLite FTS 搜索文本候选。 */
  public searchText(
    query: string,
    options: KnowledgeSearchOptions,
    limit: number
  ): KnowledgeTextSearchRow[] {
    // FTS MATCH 语法敏感，helper 会把用户输入转成安全 OR 查询。
    const ftsQuery = this.helper.sanitizeFtsQuery(query)
    if (isBlank(ftsQuery)) return []

    const filters = ['d.workspace_root = ?']
    const params: unknown[] = [options.workspaceRoot]

    if (options.sourceKinds && !isEmpty(options.sourceKinds)) {
      filters.push(`d.source_kind IN (${options.sourceKinds.map(() => '?').join(', ')})`)
      params.push(...options.sourceKinds)
    }

    if (options.documentIds && !isEmpty(options.documentIds)) {
      filters.push(`d.id IN (${options.documentIds.map(() => '?').join(', ')})`)
      params.push(...options.documentIds)
    }

    return this.db
      .prepare(
        `
      SELECT
        d.id AS document_id,
        d.path,
        d.title,
        d.summary,
        d.content,
        knowledge_search_fts.tags,
        bm25(knowledge_search_fts, ${KNOWLEDGE_TEXT_BM25_COLUMN_WEIGHTS.join(', ')}) AS rank
      FROM knowledge_search_fts
      JOIN knowledge_documents d ON d.id = knowledge_search_fts.document_id
      WHERE ${filters.join(' AND ')}
        AND knowledge_search_fts MATCH ?
      ORDER BY rank ASC, d.updated_at DESC
      LIMIT ?
    `
      )
      .all(...params, ftsQuery, limit) as KnowledgeTextSearchRow[]
  }

  /** 更新知识文档访问时间。 */
  public touchKnowledge(ids: string[], timestamp: number): void {
    if (isEmpty(ids)) return

    const placeholders = ids.map(() => '?').join(', ')
    this.db
      .prepare(
        `
      UPDATE knowledge_documents
      SET last_accessed_at = ?
      WHERE id IN (${placeholders})
    `
      )
      .run(timestamp, ...ids)
  }

  /** 获取 SQLite 侧诊断统计。 */
  public getDiagnosticsBase(
    runtime: KnowledgeIndexRuntime
  ): Omit<KnowledgeDiagnostics, 'runtime' | 'vectorStore'> {
    // 向量库统计由 KnowledgeVectors 单独提供，这里只统计关系型表和文件索引。
    const statusCounts = this.getIndexStatusCounts()
    const trackedBySourceKind = this.getFileIndexSourceKindCounts()

    return {
      totalDocuments: this.countKnowledgeDocuments(),
      pendingDocuments: statusCounts[KnowledgeIndexStatuses.PENDING] ?? 0,
      readyDocuments: statusCounts[KnowledgeIndexStatuses.READY] ?? 0,
      partialDocuments: statusCounts[KnowledgeIndexStatuses.PARTIAL] ?? 0,
      failedDocuments: statusCounts[KnowledgeIndexStatuses.FAILED] ?? 0,
      outdatedDocuments: this.countOutdatedDocuments(runtime.indexRuntimeKey),
      activeProfileIndexedDocuments: this.countActiveProfileDocuments(runtime, true),
      activeProfileMissingDocuments: this.countActiveProfileDocuments(runtime, false),
      preservedVectorIndexes: this.countVectorIndexes(),
      embeddingProfileCount: this.countEmbeddingProfiles(),
      totalChunks: this.countChunks(),
      fileIndex: this.helper.buildKnowledgeFileIndexStats(trackedBySourceKind),
    }
  }

  /** 统计知识文档数量。 */
  private countKnowledgeDocuments(whereClause?: string, ...params: unknown[]): number {
    const sql = whereClause
      ? `SELECT COUNT(*) AS count FROM knowledge_documents WHERE ${whereClause}`
      : 'SELECT COUNT(*) AS count FROM knowledge_documents'
    const row = this.db.prepare(sql).get(...params) as { count: number } | undefined
    return row?.count ?? 0
  }

  /** 统计 chunk 数量。 */
  private countChunks(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks').get() as
      LooseOptional<{ count: number }>

    return row?.count ?? 0
  }

  /** 按索引状态统计文档数。 */
  private getIndexStatusCounts(): Record<KnowledgeIndexStatus, number> {
    const rows = this.db
      .prepare(
        `
      SELECT index_status, COUNT(*) AS count
      FROM knowledge_documents
      GROUP BY index_status
    `
      )
      .all() as Array<{ index_status: KnowledgeIndexStatus; count: number }>

    const counts: Record<KnowledgeIndexStatus, number> = {
      [KnowledgeIndexStatuses.PENDING]: 0,
      [KnowledgeIndexStatuses.READY]: 0,
      [KnowledgeIndexStatuses.PARTIAL]: 0,
      [KnowledgeIndexStatuses.FAILED]: 0,
    }

    for (const row of rows) {
      counts[row.index_status] = row.count
    }

    return counts
  }

  /** 按 sourceKind 统计文件索引快照数量。 */
  private getFileIndexSourceKindCounts() {
    const rows = this.db
      .prepare(
        `
      SELECT source_kind, COUNT(*) AS count
      FROM knowledge_file_index
      GROUP BY source_kind
    `
      )
      .all() as Array<{ source_kind: string; count: number }>

    const counts = this.helper.createEmptySourceKindCounts()
    for (const row of rows) {
      const sourceKind = row.source_kind
      if (KNOWN_KNOWLEDGE_SOURCE_KINDS.has(sourceKind)) {
        counts[sourceKind as KnowledgeSourceKind] = row.count
      }
    }

    return counts
  }

  /** 统计已经 ready 但索引 runtime 或 hash 过期的文档数。 */
  private countOutdatedDocuments(currentIndexRuntimeKey: string): number {
    const row = this.db
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM knowledge_documents d
      LEFT JOIN knowledge_file_index fi ON fi.knowledge_id = d.id
      WHERE d.index_status = ?
        AND (
          d.index_text_hash = ''
          OR fi.knowledge_id IS NULL
          OR fi.index_runtime_key <> ?
        )
    `
      )
      .get(KnowledgeIndexStatuses.READY, currentIndexRuntimeKey) as { count: number } | undefined

    return row?.count ?? 0
  }

  /** 当前 profile 的覆盖率是诊断信息，不代表其它 profile 已过期。 */
  private countActiveProfileDocuments(runtime: KnowledgeIndexRuntime, indexed: boolean): number {
    const existence = indexed ? 'EXISTS' : 'NOT EXISTS'
    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM knowledge_documents d
        WHERE d.index_text_hash <> ''
          AND ${existence} (
            SELECT 1
            FROM knowledge_vector_indexes vi
            WHERE vi.document_id = d.id
              AND vi.index_text_hash = d.index_text_hash
              AND vi.embedding_provider = ?
              AND vi.embedding_model = ?
          )
      `
      )
      .get(runtime.provider, runtime.model) as { count: number } | undefined

    return row?.count ?? 0
  }

  private countVectorIndexes(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM knowledge_vector_indexes').get() as
      | { count: number }
      | undefined
    return row?.count ?? 0
  }

  private countEmbeddingProfiles(): number {
    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM (
          SELECT DISTINCT embedding_provider, embedding_model, embedding_dimensions
          FROM knowledge_vector_indexes
        )
      `
      )
      .get() as { count: number } | undefined
    return row?.count ?? 0
  }
}


export { KnowledgeRepo, KnowledgeRepo as KnowledgeRepository }
