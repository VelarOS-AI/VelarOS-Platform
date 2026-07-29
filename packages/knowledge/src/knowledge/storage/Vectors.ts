import * as lancedb from '@lancedb/lancedb'
import { DataType } from 'apache-arrow'

import { first, isBlank, isEmpty, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import { KnowledgeIndexConfig } from '../../Constants'
import {
  buildDocumentRevisionKey,
  buildEmbeddingProfileIdentity,
  buildVectorStoreStats,
} from '../../shared'
import type { KnowledgeStoragePathProvider } from '../../Types'
import type {
  KnowledgeEmbeddingProviderId,
  KnowledgeRecord,
  KnowledgeVectorStoreStats,
} from '../domain/Types'

import type { KnowledgeChunkRecord } from './RepositoryRows'
import {
  type KnowledgeVectorMatch,
  type KnowledgeVectorQuery,
  type KnowledgeVectorRow,
} from './VectorQuery'

const KNOWLEDGE_VECTOR_TABLE_PREFIX = 'knowledge_chunks_v2_'
/** 过滤字段的标量索引，配合 workspace/document 限定缩小向量搜索范围。 */
const KNOWLEDGE_VECTOR_SCALAR_INDEXES = [
  { column: 'document_id', type: 'btree' },
  { column: 'document_revision_key', type: 'btree' },
  { column: 'workspace_root', type: 'btree' },
  { column: 'path', type: 'btree' },
] as const
const log = logRuntime.tag('KnowledgeVectors')

interface KnowledgeVectorWriteResult {
  embeddingDimensions: number
  profileKey: string
  vectorTable: string
  chunkCount: number
}

/**
 * 知识向量库。
 *
 * 一个 embedding profile 对应一个固定维度的物理表。模型切换只改变下一次查询/写入
 * 选择的分区，不会删除、重建或合并其它 profile 的向量。
 */
class KnowledgeVectors {
  /** LanceDB 连接，懒加载创建。 */
  private connection: Nullable<lancedb.Connection> = null
  private readonly tables = new Map<string, lancedb.Table>()
  private readonly knownTableNames = new Set<string>()
  /** 初始化共享 Promise，防止并发重复连接。 */
  private initializePromise: Nullable<Promise<void>> = null
  /** 每个物理表独立串行建索引。 */
  private readonly ensureIndexesPromises = new Map<string, Promise<void>>()
  private readonly indexesReady = new Set<string>()

  constructor(
    private readonly helper: KnowledgeVectorQuery,
    private readonly storagePathProvider: KnowledgeStoragePathProvider
  ) {}

  /** 预热连接；模型切换和启动都不会遍历或重建向量。 */
  public async warmup(): Promise<void> {
    await this.ensureInitialized()
  }

  /** 关闭连接并清空缓存状态。 */
  public close(): void {
    for (const table of this.tables.values()) table.close()
    this.tables.clear()
    this.knownTableNames.clear()
    this.connection?.close()
    this.connection = null
    this.initializePromise = null
    this.ensureIndexesPromises.clear()
    this.indexesReady.clear()
    log.info('knowledge vector store closed')
  }

  /**
   * 写入当前 profile、当前内容版本的向量。
   *
   * 只幂等替换完全相同的 document revision；其它模型和历史内容版本原样保留。
   */
  public async writeKnowledgeChunks(
    knowledge: KnowledgeRecord,
    chunks: KnowledgeChunkRecord[],
    runtime: { provider: KnowledgeEmbeddingProviderId; model: string },
    indexTextHash: string
  ): Promise<KnowledgeVectorWriteResult> {
    await this.ensureInitialized()

    const rows = this.helper.buildChunkRows(knowledge, chunks, indexTextHash)
    const dimensions = first(rows)?.vector.length ?? 0
    if (isEmpty(rows) || dimensions <= 0) {
      throw new AppError('VALIDATION', '知识向量写入缺少有效 embedding')
    }
    if (rows.some((row) => row.vector.length !== dimensions)) {
      throw new AppError('VALIDATION', '同一知识向量批次的维度不一致')
    }

    const profile = buildEmbeddingProfileIdentity(runtime, dimensions)
    const existingTable = await this.getTable(profile.vectorTable)
    if (existingTable) await this.assertVectorDimensions(existingTable, dimensions)

    const table = existingTable ?? (await this.createTable(profile.vectorTable, rows))
    const documentRevisionKey = buildDocumentRevisionKey(knowledge.id, indexTextHash)

    if (existingTable) {
      // 单次 merge 同时更新、补行和移除同 revision 的多余旧 chunk；失败不会先清空好数据。
      await table
        .mergeInsert('chunk_id')
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .whenNotMatchedBySourceDelete({
          where: this.helper.buildRevisionFilter(documentRevisionKey),
        })
        .execute(rows)
    }
    await this.ensureIndexes(profile.vectorTable, table)

    return {
      embeddingDimensions: dimensions,
      profileKey: profile.profileKey,
      vectorTable: profile.vectorTable,
      chunkCount: rows.length,
    }
  }

  /** 记忆本体删除/隐私擦除时，跨所有 profile 清理该文档。 */
  public async deleteKnowledge(documentId: string, registeredTables: string[] = []): Promise<void> {
    await this.ensureInitialized()
    const tableNames = new Set([
      ...registeredTables,
      ...[...this.knownTableNames].filter((name) => this.isKnowledgeVectorTable(name)),
    ])

    for (const tableName of tableNames) {
      const table = await this.getTable(tableName)
      if (!table) continue
      await table.delete(this.helper.buildDeleteDocumentPredicate(documentId))
    }
  }

  /** 使用一个已经精确选定的当前-profile物理分区做相似度搜索。 */
  public async searchSimilarChunks(
    queryVector: number[],
    options: {
      workspaceRoot: string
      vectorTable: string
      documentRevisionKeys: string[]
      limit: number
    }
  ): Promise<KnowledgeVectorMatch[]> {
    const table = await this.getTable(options.vectorTable)
    if (!table) return []

    await this.assertVectorDimensions(table, queryVector.length)

    let query = table
      .vectorSearch(queryVector)
      .distanceType('cosine')
      .nprobes(KnowledgeIndexConfig.VECTOR_INDEX_PROBE_COUNT)
      .limit(options.limit)

    const where = this.helper.buildSearchWhereClause(options)
    if (!isBlank(where)) query = query.where(where)

    const rows = await query.toArray()
    return this.helper.parseSearchRows(rows)
  }

  /** 聚合所有保留 profile 表的只读诊断；不会借诊断触发重建。 */
  public async getStats(): Promise<KnowledgeVectorStoreStats> {
    await this.ensureInitialized()
    const tableNames = [...this.knownTableNames]
      .filter((name) => this.isKnowledgeVectorTable(name))
      .sort()

    if (isEmpty(tableNames))
      return {
        path: this.storagePathProvider.getLanceDatabasePath(),
        tableName: `${KNOWLEDGE_VECTOR_TABLE_PREFIX}*`,
        rowCount: 0,
        dimensions: null,
        indices: [],
      }

    let rowCount = 0
    const dimensions = new Set<number>()
    const indices: Array<{ name: string; indexType: string; columns: readonly string[] }> = []

    for (const tableName of tableNames) {
      const table = await this.getTable(tableName)
      if (!table) continue
      const [tableRowCount, tableDimensions, tableIndices] = await Promise.all([
        table.countRows(),
        this.getVectorDimensions(table),
        table.listIndices(),
      ])
      rowCount += tableRowCount
      if (isPresent(tableDimensions)) dimensions.add(tableDimensions)
      indices.push(
        ...tableIndices.map((index) => ({
          name: `${tableName}:${index.name}`,
          indexType: index.indexType,
          columns: index.columns,
        }))
      )
    }

    return buildVectorStoreStats({
      path: this.storagePathProvider.getLanceDatabasePath(),
      tableName: `${KNOWLEDGE_VECTOR_TABLE_PREFIX}*`,
      rowCount,
      dimensions: dimensions.size === 1 ? (first([...dimensions]) ?? null) : null,
      indices,
    })
  }

  /** 确保连接已初始化。 */
  private async ensureInitialized(): Promise<void> {
    if (this.connection) return
    if (this.initializePromise) return this.initializePromise

    this.initializePromise = this.initialize()
      .catch((error) => {
        this.connection = null
        this.tables.clear()
        this.knownTableNames.clear()
        throw error
      })
      .finally(() => {
        this.initializePromise = null
      })

    return this.initializePromise
  }

  /** 连接后只登记当前 profile 协议的物理表。 */
  private async initialize(): Promise<void> {
    this.connection = await lancedb.connect(this.storagePathProvider.getLanceDatabasePath())
    const tableNames = await this.connection.tableNames()
    tableNames
      .filter((tableName) => this.isKnowledgeVectorTable(tableName))
      .forEach((tableName) => this.knownTableNames.add(tableName))
    log.info('knowledge vector store connected', {
      tables: tableNames.filter((name) => this.isKnowledgeVectorTable(name)).length,
    })
  }

  private isKnowledgeVectorTable(tableName: string): boolean {
    return tableName.startsWith(KNOWLEDGE_VECTOR_TABLE_PREFIX)
  }

  /** 按表名懒加载；不存在时返回 null。 */
  private async getTable(tableName: string): Promise<Nullable<lancedb.Table>> {
    await this.ensureInitialized()
    const cached = this.tables.get(tableName)
    if (cached) return cached
    if (!this.knownTableNames.has(tableName) || !this.connection) return null

    const table = await this.connection.openTable(tableName)
    this.tables.set(tableName, table)
    return table
  }

  /** 使用第一批向量行创建 profile 专属表。 */
  private async createTable(tableName: string, rows: KnowledgeVectorRow[]): Promise<lancedb.Table> {
    if (!this.connection) throw new AppError('UNKNOWN', 'LanceDB 连接尚未初始化')

    const table = await this.connection.createTable(tableName, rows)
    this.knownTableNames.add(tableName)
    this.tables.set(tableName, table)
    return table
  }

  /** 串行化单表索引创建。 */
  private async ensureIndexes(tableName: string, table: lancedb.Table): Promise<void> {
    if (this.indexesReady.has(tableName)) return
    const pending = this.ensureIndexesPromises.get(tableName)
    if (pending) return pending

    const promise = this.ensureIndexesInternal(tableName, table)
      .catch((error) => {
        log.warn('knowledge vector index ensure failed', AppError.from(error))
      })
      .finally(() => {
        this.ensureIndexesPromises.delete(tableName)
      })
    this.ensureIndexesPromises.set(tableName, promise)
    return promise
  }

  /** 创建缺失的标量索引和向量索引。 */
  private async ensureIndexesInternal(tableName: string, table: lancedb.Table): Promise<void> {
    const indices = await table.listIndices()
    const existingColumns = new Set(indices.flatMap((index) => index.columns))

    for (const { column, type } of KNOWLEDGE_VECTOR_SCALAR_INDEXES) {
      if (existingColumns.has(column)) continue
      await table.createIndex(column, {
        config: type === 'btree' ? lancedb.Index.btree() : lancedb.Index.bitmap(),
        replace: false,
        waitTimeoutSeconds: KnowledgeIndexConfig.VECTOR_INDEX_WAIT_TIMEOUT_SECONDS,
      })
    }

    const rowCount = await table.countRows()
    if (rowCount < KnowledgeIndexConfig.VECTOR_INDEX_MIN_ROWS) return
    if (!existingColumns.has('vector')) {
      await table.createIndex('vector', {
        config: lancedb.Index.ivfFlat({ distanceType: 'cosine' }),
        replace: false,
        waitTimeoutSeconds: KnowledgeIndexConfig.VECTOR_INDEX_WAIT_TIMEOUT_SECONDS,
      })
    }
    this.indexesReady.add(tableName)
  }

  /** 校验查询/写入向量维度是否与该 profile 表 schema 匹配。 */
  private async assertVectorDimensions(table: lancedb.Table, dimensions: number): Promise<void> {
    const tableDimensions = await this.getVectorDimensions(table)
    if (!isPresent(tableDimensions) || tableDimensions === dimensions) return

    throw new AppError(
      'VALIDATION',
      `知识向量维度不匹配：现有 ${tableDimensions}，传入 ${dimensions}`
    )
  }

  /** 从 Arrow schema 读取固定长度向量维度。 */
  private async getVectorDimensions(table: lancedb.Table): Promise<Nullable<number>> {
    const schema = await table.schema()
    const vectorField = schema.fields.find((field) => field.name === 'vector')
    if (!vectorField || !DataType.isFixedSizeList(vectorField.type)) return null
    return vectorField.type.listSize
  }
}

export { KnowledgeVectors, KnowledgeVectors as KnowledgeVectorStore }
export type { KnowledgeVectorWriteResult }
