import { first, isBlank, isEmpty, isPresent, Log, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { KnowledgeIndexConfig } from '../../contract/constants.js'
import type {
  KnowledgeLanceDbConnection,
  KnowledgeLanceDbLoader,
  KnowledgeLanceDbModule,
  KnowledgeLanceDbTable,
  KnowledgeStoragePathProvider,
} from '../../contract/requires.js'
import type {
  KnowledgeRecord,
  KnowledgeVectorStoreStats,
} from '../../types/knowledge.js'
import type {
  EmbeddingRuntimeIdentity,
  KnowledgeChunkRecord,
  KnowledgeVectorMatch,
  KnowledgeVectorRow,
  KnowledgeVectorWriteResult,
} from '../../types/storage.js'
import {
  buildDocumentRevisionKey,
  buildEmbeddingProfileIdentity,
} from '../../utils/indexing.js'
import {
  assertVectorDimensions,
  buildKnowledgeVectorTableGlob,
  isKnowledgeVectorTable,
  readVectorDimensions,
} from '../../utils/vector-query.js'
import { buildVectorStoreStats } from '../../utils/vector-stats.js'

import type { KnowledgeVectorQueryApi } from './KnowledgeVectorQuery.js'

const log = Log.tag('KnowledgeVectors')

/**
 * 知识向量库：一个嵌入 profile 对应一张固定维度的物理表。
 *
 * 模型切换只改变下一次读写选哪张分区表，不会删除、重建或合并别的 profile 的向量；
 * 实例由知识库运行时持有，连接与表缓存都在实例上。
 */
export interface KnowledgeVectorsApi {
  /** 预热连接；启动与模型切换都不会遍历或重建向量。 */
  warmup(): Promise<void>
  /** 关闭连接并清空缓存状态。 */
  close(): void
  /** 写入当前 profile、当前内容版本的向量，只幂等替换完全相同的 revision。 */
  writeKnowledgeChunks(
    knowledge: KnowledgeRecord,
    chunks: KnowledgeChunkRecord[],
    runtime: EmbeddingRuntimeIdentity,
    indexTextHash: string
  ): Promise<KnowledgeVectorWriteResult>
  /** 删除一份文档时跨所有 profile 清理它的向量。 */
  deleteKnowledge(documentId: string, registeredTables?: string[]): Promise<void>
  /** 在一张已经选定的当前-profile 分区表里做相似度检索。 */
  searchSimilarChunks(
    queryVector: number[],
    options: {
      workspaceRoot: string
      vectorTable: string
      documentRevisionKeys: string[]
      limit: number
    }
  ): Promise<KnowledgeVectorMatch[]>
  /** 汇总所有保留 profile 表的只读诊断；不会借诊断触发重建。 */
  getStats(): Promise<KnowledgeVectorStoreStats>
}

/** 见 {@link KnowledgeVectorsApi}。 */
export class KnowledgeVectors implements KnowledgeVectorsApi {
  /** 过滤字段的标量索引，配合工作区与文档限定缩小向量检索范围。 */
  private static readonly scalarIndexes = [
    { column: 'document_id', type: 'btree' },
    { column: 'document_revision_key', type: 'btree' },
    { column: 'workspace_root', type: 'btree' },
    { column: 'path', type: 'btree' },
  ] as const

  /** LanceDB 插件模块与连接都按需加载；没装插件时保持 null。 */
  private lanceDb: Nullable<KnowledgeLanceDbModule> = null
  private connection: Nullable<KnowledgeLanceDbConnection> = null
  private readonly tables = new Map<string, KnowledgeLanceDbTable>()
  private readonly knownTableNames = new Set<string>()
  /** 初始化共享 Promise，防止并发重复连接。 */
  private initializePromise: Nullable<Promise<void>> = null
  /** 每张物理表各自串行建索引。 */
  private readonly ensureIndexesPromises = new Map<string, Promise<void>>()
  private readonly indexesReady = new Set<string>()

  constructor(
    private readonly helper: KnowledgeVectorQueryApi,
    private readonly storagePathProvider: KnowledgeStoragePathProvider,
    private readonly loadLanceDb?: KnowledgeLanceDbLoader
  ) {}

  public async warmup(): Promise<void> {
    if (!this.loadLanceDb) return
    await this.ensureInitialized()
  }

  public close(): void {
    for (const table of this.tables.values()) table.close()
    this.tables.clear()
    this.knownTableNames.clear()
    this.connection?.close()
    this.connection = null
    this.lanceDb = null
    this.initializePromise = null
    this.ensureIndexesPromises.clear()
    this.indexesReady.clear()
    log.info('knowledge vector store closed')
  }

  public async writeKnowledgeChunks(
    knowledge: KnowledgeRecord,
    chunks: KnowledgeChunkRecord[],
    runtime: EmbeddingRuntimeIdentity,
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
    if (existingTable) await assertVectorDimensions(existingTable, dimensions)

    const table = existingTable ?? (await this.createTable(profile.vectorTable, rows))
    const documentRevisionKey = buildDocumentRevisionKey(knowledge.id, indexTextHash)

    if (existingTable) {
      // 单次 merge 同时更新、补行并移除同 revision 的多余旧 chunk；失败不会先清空好数据。
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

  public async deleteKnowledge(documentId: string, registeredTables: string[] = []): Promise<void> {
    await this.ensureInitialized()
    const tableNames = new Set([
      ...registeredTables,
      ...[...this.knownTableNames].filter((name) => isKnowledgeVectorTable(name)),
    ])

    for (const tableName of tableNames) {
      const table = await this.getTable(tableName)
      if (!table) continue
      await table.delete(this.helper.buildDeleteDocumentPredicate(documentId))
    }
  }

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

    await assertVectorDimensions(table, queryVector.length)

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

  public async getStats(): Promise<KnowledgeVectorStoreStats> {
    if (!this.loadLanceDb)
      return {
        path: this.storagePathProvider.getLanceDatabasePath(),
        tableName: buildKnowledgeVectorTableGlob(),
        rowCount: 0,
        dimensions: null,
        indices: [],
      }
    await this.ensureInitialized()
    const tableNames = [...this.knownTableNames]
      .filter((name) => isKnowledgeVectorTable(name))
      .sort()

    if (isEmpty(tableNames))
      return {
        path: this.storagePathProvider.getLanceDatabasePath(),
        tableName: buildKnowledgeVectorTableGlob(),
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
        readVectorDimensions(table),
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
      tableName: buildKnowledgeVectorTableGlob(),
      rowCount,
      // 只有所有表维度一致时才报一个确定的维度。
      dimensions: dimensions.size === 1 ? (toNullable(first([...dimensions]))) : null,
      indices,
    })
  }

  /** 确保连接已经初始化；没装向量插件时报 `UNAVAILABLE`。 */
  private async ensureInitialized(): Promise<void> {
    if (this.connection) return
    if (this.initializePromise) return this.initializePromise
    if (!this.loadLanceDb) {
      throw new AppError('UNAVAILABLE', 'LanceDB 向量插件尚未安装或未启用')
    }

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

  /** 连上向量库，只登记符合当前 profile 协议的物理表。 */
  private async initialize(): Promise<void> {
    if (!this.loadLanceDb) throw new AppError('UNAVAILABLE', 'LanceDB 向量插件尚未安装或未启用')
    this.lanceDb = await this.loadLanceDb()
    this.connection = await this.lanceDb.connect(this.storagePathProvider.getLanceDatabasePath())
    const tableNames = await this.connection.tableNames()
    tableNames
      .filter((tableName) => isKnowledgeVectorTable(tableName))
      .forEach((tableName) => this.knownTableNames.add(tableName))
    log.info('knowledge vector store connected', {
      tables: tableNames.filter((name) => isKnowledgeVectorTable(name)).length,
    })
  }

  /** 按表名懒加载一张表；不存在时返回 null。 */
  private async getTable(tableName: string): Promise<Nullable<KnowledgeLanceDbTable>> {
    await this.ensureInitialized()
    const cached = this.tables.get(tableName)
    if (cached) return cached
    if (!this.knownTableNames.has(tableName) || !this.connection) return null

    const table = await this.connection.openTable(tableName)
    this.tables.set(tableName, table)
    return table
  }

  /** 用第一批向量行创建这个 profile 专属的表。 */
  private async createTable(tableName: string, rows: KnowledgeVectorRow[]): Promise<KnowledgeLanceDbTable> {
    if (!this.connection) throw new AppError('UNKNOWN', 'LanceDB 连接尚未初始化')

    const table = await this.connection.createTable(tableName, rows)
    this.knownTableNames.add(tableName)
    this.tables.set(tableName, table)
    return table
  }

  /** 串行化单张表的索引创建，失败只告警不改写调用方的成败。 */
  private async ensureIndexes(tableName: string, table: KnowledgeLanceDbTable): Promise<void> {
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

  /** 创建缺失的标量索引与向量索引。 */
  private async ensureIndexesInternal(tableName: string, table: KnowledgeLanceDbTable): Promise<void> {
    const lanceDb = this.lanceDb
    if (!lanceDb) throw new AppError('UNAVAILABLE', 'LanceDB 向量插件尚未加载')
    const indices = await table.listIndices()
    const existingColumns = new Set(indices.flatMap((index) => index.columns))

    for (const { column, type } of KnowledgeVectors.scalarIndexes) {
      if (existingColumns.has(column)) continue
      await table.createIndex(column, {
        config: type === 'btree' ? lanceDb.Index.btree() : lanceDb.Index.bitmap(),
        replace: false,
        waitTimeoutSeconds: KnowledgeIndexConfig.VECTOR_INDEX_WAIT_TIMEOUT_SECONDS,
      })
    }

    const rowCount = await table.countRows()
    if (rowCount < KnowledgeIndexConfig.VECTOR_INDEX_MIN_ROWS) return
    if (!existingColumns.has('vector')) {
      await table.createIndex('vector', {
        config: lanceDb.Index.ivfFlat({ distanceType: 'cosine' }),
        replace: false,
        waitTimeoutSeconds: KnowledgeIndexConfig.VECTOR_INDEX_WAIT_TIMEOUT_SECONDS,
      })
    }
    this.indexesReady.add(tableName)
  }
}
