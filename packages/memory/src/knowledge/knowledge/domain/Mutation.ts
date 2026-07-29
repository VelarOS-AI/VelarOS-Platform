import { createHash } from 'node:crypto'

import { isBlank, isEmpty, unique } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import { Result } from '@velaros-ai/core/result'

import { KnowledgeIndexStatuses } from '../../Constants'
import type { EmbeddingRuntimeSelection, Embeddings } from '../../embedding'
import { buildIndexTextHash, canReuseReadyContentIndex } from '../../shared'
import { VectorFailureMonitor } from '../../VectorFailureLog'
import type { KnowledgeRepo } from '../storage'
import type { KnowledgeVectors } from '../storage'

import type { KnowledgeChunk, KnowledgeChunkBuilder } from './Chunks'
import type { KnowledgeIndexRuntime, KnowledgeRecord, KnowledgeUpsertInput } from './Types'

const log = logRuntime.tag('KnowledgeMutation')

/**
 * 知识写入服务。
 *
 * 负责校验知识文档、生成 chunk、调用 embedding、同步 SQLite 和 LanceDB。
 * 这层只处理单篇文档，工作区扫描和候选选择由 KnowledgeIngestion 负责。
 */
export class KnowledgeMutation {
  constructor(
    private readonly repository: KnowledgeRepo,
    private readonly embeddingService: Embeddings,
    private readonly vectorStore: KnowledgeVectors,
    private readonly chunkBuilder: KnowledgeChunkBuilder,
    private readonly vectorFailures = new VectorFailureMonitor()
  ) {}

  /** 当前索引运行时，用来判断已有知识索引是否过期。 */
  public getCurrentIndexRuntime(): KnowledgeIndexRuntime {
    const embeddingRuntime = this.embeddingService.getRuntimeSelection()
    return {
      ...embeddingRuntime,
      indexRuntimeKey: this.chunkBuilder.getIndexRuntimeKey(),
    }
  }

  /**
   * 新建或更新知识文档。
   *
   * 执行流程：校验输入 -> 生成稳定 id -> 规范字段 -> 分块/hash -> 尝试复用索引 -> 必要时重建。
   */
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
    // 同一 workspaceRoot + path 对应同一知识文档 id，便于重复同步时做 upsert。
    const knowledgeId = existing?.id ?? this.buildKnowledgeId(input.workspaceRoot, input.path)
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

    if (existing && this.canReuseExistingIndex(existing, indexTextHash)) {
      // 内容与分块没变时直接复用；embedding profile 切换不能把这里变成隐式重建入口。
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

  /** 对已有知识文档重新建立 chunk/embedding/向量索引。 */
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

  /**
   * 写入知识索引。
   *
   * 先保存文档和 FTS，让文本搜索可用；随后只写当前 profile/current revision 向量。
   * 向量侧失败时标记 PARTIAL，保留文本搜索和错误信息。
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
      // 当前内容没有可索引 chunk；历史内容/profile 向量保留但因 revision 不匹配不可见。
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
    // 即使 embedding 失败，也写入 chunk 元数据；后续重建索引可以看到分块结果和失败状态。
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

    // 新 profile/revision 旁路写入；只会幂等替换完全相同的 revision。
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
      const errorPayload = !vectorWriteResult.ok
        ? vectorWriteResult.error
        : { code: 'UNKNOWN' as const, message: '知识向量索引状态未知' }
      const error = AppError.fromJSON(errorPayload)
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

  /** 删除知识文档及其向量索引。 */
  public async deleteKnowledge(documentId: string): Promise<void> {
    this.getKnowledgeOrThrow(documentId)
    const vectorTables = this.repository.listVectorTablesForDocument(documentId)
    await this.vectorStore.deleteKnowledge(documentId, vectorTables)
    this.repository.deleteKnowledge(documentId)
  }

  /** 根据工作区和路径生成稳定 id。 */
  private buildKnowledgeId(workspaceRoot: string, path: string): string {
    return createHash('sha1').update(`${workspaceRoot}::${path}`).digest('hex')
  }

  /** 判断现有 ready 索引是否仍适用于当前内容；profile 切换不是内容变化。 */
  private canReuseExistingIndex(
    existing: KnowledgeRecord,
    indexTextHash: string
  ): boolean {
    return canReuseReadyContentIndex(existing, indexTextHash)
  }

  /** 读取知识文档，不存在时抛业务错误。 */
  private getKnowledgeOrThrow(id: string): KnowledgeRecord {
    const knowledge = this.repository.findKnowledgeById(id)
    if (!knowledge) {
      throw new AppError('NOT_FOUND', `未找到知识文档：${id}`)
    }
    return knowledge
  }
}
