import { isBlank, isEmpty, Log, unique } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'

import { KnowledgeIndexStatuses } from '../../contract/constants.js'
import type { EmbeddingRuntimeSelection } from '../../types/host.js'
import type { KnowledgeUpsertInput } from '../../types/ingestion.js'
import type { KnowledgeIndexRuntime, KnowledgeRecord } from '../../types/knowledge.js'
import type { KnowledgeChunk } from '../../types/storage.js'
import {
  buildIndexTextHash,
  buildKnowledgeDocumentId,
  canReuseReadyContentIndex,
} from '../../utils/indexing.js'
import type { KnowledgeEmbeddingsApi } from '../storage/KnowledgeEmbeddings.js'
import type { KnowledgeRepositoryApi } from '../storage/KnowledgeRepository.js'
import type { KnowledgeVectorsApi } from '../storage/KnowledgeVectors.js'
import type { VectorFailureMonitorApi } from '../storage/VectorFailureMonitor.js'
import { VectorFailureMonitor } from '../storage/VectorFailureMonitor.js'

import type { KnowledgeChunkBuilderApi } from './KnowledgeChunkBuilder.js'

const log = Log.tag('KnowledgeMutation')

/**
 * 知识写入服务：校验文档、生成分块、调嵌入、同步 SQLite 与 LanceDB。
 *
 * 这一层只处理单篇文档；工作区扫描与候选选择归 `KnowledgeIngestion`。
 * 向量侧失败会标成 PARTIAL 并保留文本检索，不会把整次写入判成失败。
 */
export interface KnowledgeMutationApi {
  /** 当前索引运行时，用来判断已有索引是不是过期了。 */
  getCurrentIndexRuntime(): KnowledgeIndexRuntime
  /** 新建或更新一份知识文档；内容没变就复用已有索引。 */
  upsertKnowledge(input: KnowledgeUpsertInput): Promise<KnowledgeRecord>
  /** 对一份已有文档重新建立分块、向量与索引状态。 */
  reindexKnowledge(documentId: string): Promise<KnowledgeRecord>
  /** 删除一份知识文档，连同它跨所有 profile 的向量。 */
  deleteKnowledge(documentId: string): Promise<void>
}

/** 见 {@link KnowledgeMutationApi}。 */
export class KnowledgeMutation implements KnowledgeMutationApi {
  constructor(
    private readonly repository: KnowledgeRepositoryApi,
    private readonly embeddingService: KnowledgeEmbeddingsApi,
    private readonly vectorStore: KnowledgeVectorsApi,
    private readonly chunkBuilder: KnowledgeChunkBuilderApi,
    private readonly vectorFailures: VectorFailureMonitorApi = new VectorFailureMonitor()
  ) {}

  public getCurrentIndexRuntime(): KnowledgeIndexRuntime {
    const embeddingRuntime = this.embeddingService.getRuntimeSelection()
    return {
      ...embeddingRuntime,
      indexRuntimeKey: this.chunkBuilder.getIndexRuntimeKey(),
    }
  }

  public async upsertKnowledge(input: KnowledgeUpsertInput): Promise<KnowledgeRecord> {
    if (isBlank(input.workspaceRoot) || isBlank(input.path)) {
      throw new AppError('VALIDATION', '知识文档必须包含 workspaceRoot 和 path')
    }
    if (isBlank(input.title) || isBlank(input.content)) {
      throw new AppError('VALIDATION', '知识文档标题和内容不能为空')
    }

    const now = Date.now()
    const existing = this.repository.findKnowledgeByWorkspaceAndPath(
      input.workspaceRoot,
      input.path
    )
    // 同一 workspaceRoot + path 对应同一份文档 id，重复同步时才能做成 upsert。
    const knowledgeId = existing?.id ?? buildKnowledgeDocumentId(input.workspaceRoot, input.path)
    const embeddingRuntime = this.embeddingService.getRuntimeSelection()

    const record: KnowledgeRecord = {
      id: knowledgeId,
      workspaceRoot: input.workspaceRoot,
      path: input.path,
      title: input.title.trim(),
      summary: input.summary?.trim() ?? '',
      content: input.content.trim(),
      sourceKind: input.sourceKind,
      tags: unique((input.tags ?? [])
        .map((tag) => tag.trim())
        .filter((tag) => !isBlank(tag))),
      indexStatus: KnowledgeIndexStatuses.PENDING,
      indexError: '',
      chunkCount: existing?.chunkCount ?? 0,
      indexTextHash: existing?.indexTextHash ?? '',
      embeddingProvider: existing?.embeddingProvider ?? '',
      embeddingModel: existing?.embeddingModel ?? '',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastAccessedAt: existing?.lastAccessedAt ?? now,
    }

    const chunks = this.chunkBuilder.build(record)
    const indexTextHash = buildIndexTextHash(
      this.chunkBuilder.buildIndexSource(record, chunks)
    )

    if (existing && canReuseReadyContentIndex(existing, indexTextHash)) {
      // 内容与分块都没变就直接复用；嵌入 profile 切换不能把这里变成隐式重建入口。
      this.repository.upsertKnowledge({
        ...record,
        indexStatus: existing.indexStatus,
        indexError: '',
        chunkCount: existing.chunkCount,
        indexTextHash,
        embeddingProvider: existing.embeddingProvider,
        embeddingModel: existing.embeddingModel,
      })
      return this.getKnowledgeOrThrow(knowledgeId)
    }

    return this.indexKnowledgeRecord(record, {
      chunks,
      indexTextHash,
      embeddingRuntime,
      updateTimestamp: now,
    })
  }

  public async reindexKnowledge(documentId: string): Promise<KnowledgeRecord> {
    const existing = this.getKnowledgeOrThrow(documentId)
    const chunks = this.chunkBuilder.build(existing)
    const indexTextHash = buildIndexTextHash(this.chunkBuilder.buildIndexSource(existing, chunks))
    const embeddingRuntime = this.embeddingService.getRuntimeSelection()
    // 只有这个显式入口允许重新请求当前 profile；模型配置切换本身不会调用它。
    return this.indexKnowledgeRecord(
      {
        ...existing,
        indexStatus: KnowledgeIndexStatuses.PENDING,
        indexError: '',
      },
      {
        chunks,
        indexTextHash,
        embeddingRuntime,
        updateTimestamp: existing.updatedAt,
      }
    )
  }

  public async deleteKnowledge(documentId: string): Promise<void> {
    this.getKnowledgeOrThrow(documentId)
    const vectorTables = this.repository.listVectorTablesForDocument(documentId)
    await this.vectorStore.deleteKnowledge(documentId, vectorTables)
    this.repository.deleteKnowledge(documentId)
  }

  /**
   * 写入一次知识索引。
   *
   * 先保存文档与 FTS，让文本检索立刻可用；随后只写当前 profile、当前内容版本的向量。
   * 向量侧失败时标 PARTIAL，保留文本检索与错误信息。
   */
  private async indexKnowledgeRecord(
    record: KnowledgeRecord,
    options: {
      chunks: KnowledgeChunk[]
      indexTextHash: string
      embeddingRuntime: EmbeddingRuntimeSelection
      updateTimestamp: number
    }
  ): Promise<KnowledgeRecord> {
    this.repository.upsertKnowledge({
      ...record,
      indexTextHash: options.indexTextHash,
      embeddingProvider: options.embeddingRuntime.provider,
      embeddingModel: options.embeddingRuntime.model,
    })

    if (isEmpty(options.chunks)) {
      // 当前内容没有可索引的分块；历史内容与旧 profile 的向量保留，但 revision 对不上因而不可见。
      this.repository.replaceChunks(record.id, [])

      this.repository.updateIndexState(
        record.id,
        KnowledgeIndexStatuses.FAILED,
        '内容过短，无法建立索引',
        0,
        options.updateTimestamp
      )
      return this.getKnowledgeOrThrow(record.id)
    }

    const embeddingResult = await Result.wrap(async () =>
      this.embeddingService.embedTexts(options.chunks.map((chunk) => chunk.content))
    )

    const chunkTimestamp = Date.now()
    // 即使嵌入失败也写入分块元数据；后续重建索引能看到分块结果与失败状态。
    const indexedChunks = options.chunks.map((chunk, index) => {
      const embedding = embeddingResult.ok ? (embeddingResult.data[index] ?? []) : []
      return {
        id: `${record.id}:${chunk.index}`,
        documentId: record.id,
        chunkIndex: chunk.index,
        content: chunk.content,
        embedding,
        embeddingModel: isEmpty(embedding) ? '' : options.embeddingRuntime.model,
        embeddingDimensions: embedding.length,
        createdAt: chunkTimestamp,
        updatedAt: chunkTimestamp,
      }
    })

    this.repository.replaceChunks(record.id, indexedChunks)

    if (!embeddingResult.ok) {
      const error = AppError.fromJSON(embeddingResult.error)
      this.repository.updateIndexState(
        record.id,
        KnowledgeIndexStatuses.PARTIAL,
        error.message,
        indexedChunks.length,
        options.updateTimestamp
      )
      this.vectorFailures.warnOnce(
        log,
        'knowledge-mutation',
        'knowledge indexed without complete vector sync',
        error,
        {
          knowledgeId: record.id,
        }
      )
      return this.getKnowledgeOrThrow(record.id)
    }

    // 新 profile / 新 revision 旁路写入；只会幂等替换完全相同的 revision。
    const vectorWriteResult = await Result.wrap(async () =>
      this.vectorStore.writeKnowledgeChunks(
        record,
        indexedChunks,
        options.embeddingRuntime,
        options.indexTextHash
      )
    )

    if (vectorWriteResult.ok) {
      this.repository.upsertVectorIndex({
        documentId: record.id,
        indexTextHash: options.indexTextHash,
        embeddingProvider: options.embeddingRuntime.provider,
        embeddingModel: options.embeddingRuntime.model,
        embeddingDimensions: vectorWriteResult.data.embeddingDimensions,
        profileKey: vectorWriteResult.data.profileKey,
        vectorTable: vectorWriteResult.data.vectorTable,
        chunkCount: vectorWriteResult.data.chunkCount,
        createdAt: chunkTimestamp,
        updatedAt: chunkTimestamp,
      })
      this.repository.updateIndexState(
        record.id,
        KnowledgeIndexStatuses.READY,
        '',
        indexedChunks.length,
        options.updateTimestamp
      )
    } else {
      const error = AppError.fromJSON(vectorWriteResult.error)
      this.repository.updateIndexState(
        record.id,
        KnowledgeIndexStatuses.PARTIAL,
        error.message,
        indexedChunks.length,
        options.updateTimestamp
      )
      this.vectorFailures.warnOnce(
        log,
        'knowledge-mutation',
        'knowledge indexed without complete vector sync',
        error,
        {
          knowledgeId: record.id,
        }
      )
    }

    return this.getKnowledgeOrThrow(record.id)
  }

  /** 读一份知识文档，不存在就抛业务错误。 */
  private getKnowledgeOrThrow(id: string): KnowledgeRecord {
    const knowledge = this.repository.findKnowledgeById(id)
    if (!knowledge) {
      throw new AppError('NOT_FOUND', `未找到知识文档：${id}`)
    }
    return knowledge
  }
}
