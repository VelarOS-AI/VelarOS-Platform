/**
 * `memory-vector` —— **市场可选的增强档，派生索引角色**（§九 9.1 / 9.2）。
 *
 * 它做且只做一件事：把权威层已经落地的条目嵌成向量，让「意思相近但用词不同」也能召回。
 * 因此它：
 * - **不是权威层**：`role = 'derived-index'`，`descriptor.verbs` 不含 `capture`——它不吃原始
 *   证据，只吃权威层 capture 之后的记录（那里才有指针）；
 * - **不持内容副本**：索引记录只有 `{指针, 作用域, 向量}`。卸载 = `dropIndex()` = 删派生文件，
 *   权威内容一个字节没动；
 * - **不写迁移器**：换嵌入模型或升级索引 schema → 版本戳对不上 → `isStale()` 为真 → 全量重建。
 *
 * 缺席时会怎样已经由 §九 写死：recall 退回权威层的索引行匹配，**功能面不缺，只是召回变笨**。
 */

import { isEmpty } from '@velaros-ai/core'

import { MemoryVectorBackendId, MemoryVectorIndex } from '../../contract/constants'
import type {
  MemoryAuthorityEnumeration,
  MemoryDerivedIndexBackend,
  MemoryEmbedder,
  MemoryVectorIndexStore,
} from '../../contract/requires'
import type {
  MemoryBackendDescriptor,
  MemoryBackendStats,
  MemoryCaptureBatchResult,
  MemoryCaptureResult,
  MemoryDerivedIndexRebuildResult,
  MemoryDerivedIndexVersion,
  MemoryEvidenceRecord,
  MemoryForgetResult,
  MemoryRecallItem,
  MemoryRecallOptions,
  MemoryVectorIndexRecord,
} from '../../types/memory'
import type { PendingIndexEntry } from '../../types/vector'
import { formatMemoryDerivedIndexVersion } from '../../utils/backends'
import { MemoryTuning } from '../../utils/tuning'
import {
  buildIndexText,
  dot,
  matchesVectorScope,
  normalizeVector,
  stringifyValue,
  toAsyncIterable,
  toPointerItem,
} from '../../utils/vector'

import { createInMemoryVectorIndexStore } from './InMemoryVectorIndexStore'

/** 一个向量派生索引后端要什么。 */
export interface MemoryVectorBackendOptions {
  /** 嵌入端口（宿主注入；包内零模型假设）。 */
  readonly embedder: MemoryEmbedder
  /** 索引存储；缺省用纯内存实现（宿主须显式注入 `createFileVectorIndexStore(...)` 才有持久化）。 */
  readonly store?: MemoryVectorIndexStore
  /** 一次嵌入调用最多送多少条；缺省取可调参数表。 */
  readonly embedBatchSize?: number
  /** 相似度地板；低于它的命中直接丢掉。缺省取可调参数表。 */
  readonly minimumSimilarity?: number
}

/** 语义派生索引后端；实例由 `createMemoryVectorBackend` 造，一个实例管一份索引。 */
export class MemoryVectorBackend implements MemoryDerivedIndexBackend {
  /** 派生索引的自述：不声明 capture，机械可查「这个后端不吃原始证据」。 */
  private static readonly Descriptor: MemoryBackendDescriptor & { readonly role: 'derived-index' } = Object.freeze({
    id: MemoryVectorBackendId,
    role: 'derived-index' as const,
    displayName: '记忆向量索引（语义派生索引）',
    verbs: Object.freeze(['recall', 'inspect', 'archive'] as const),
  })

  /** 装错后端时的拒收说明：两条 capture 路径同一句话。 */
  private static readonly RejectCaptureMessage =
    'memory-vector 是派生索引，不接受原始证据；双写的第二写请走 indexEvidence()。'

  public readonly descriptor = MemoryVectorBackend.Descriptor

  public readonly indexVersion: MemoryDerivedIndexVersion

  private readonly store: MemoryVectorIndexStore

  private readonly embedder: MemoryEmbedder

  private readonly embedBatchSize: number

  private readonly minimumSimilarity: number

  public constructor(options: MemoryVectorBackendOptions) {
    this.embedder = options.embedder
    this.store = options.store ?? createInMemoryVectorIndexStore()
    this.embedBatchSize = Math.max(1, options.embedBatchSize ?? MemoryTuning.vector.embedBatchSize)
    this.minimumSimilarity = options.minimumSimilarity ?? MemoryTuning.vector.minimumSimilarity
    this.indexVersion = Object.freeze({
      schema: MemoryVectorIndex.schemaVersion,
      embedding: options.embedder.identity,
    })
  }

  public isStale(): boolean {
    return this.store.readVersion() !== formatMemoryDerivedIndexVersion(this.indexVersion)
  }

  /**
   * 窄端口的 `capture`：**显式拒收，且是抛错**。
   *
   * 原始证据还没有指针（指针由权威层在落地时分配），派生索引接了也不知道该指向谁。
   * **不静默返回 `inserted: false`**：那会让「装错了后端」表现为「记忆写了但一条都没存下」。
   */
  public capture(): MemoryCaptureResult {
    throw new Error(MemoryVectorBackend.RejectCaptureMessage)
  }

  public captureBatch(): MemoryCaptureBatchResult {
    throw new Error(MemoryVectorBackend.RejectCaptureMessage)
  }

  public async indexEvidence(records: readonly MemoryEvidenceRecord[]): Promise<number> {
    const pending = records
      .map((record) => ({
        id: record.id,
        scopeType: record.scopeType,
        scopeId: record.scopeId,
        updatedAt: record.occurredAt || record.createdAt || 0,
        text: buildIndexText(record.title, '', record.content),
      }))
      .filter((entry) => !isEmpty(entry.id) && !isEmpty(entry.text))
    return this.embedAndUpsert(pending)
  }

  public async rebuild(
    source: MemoryAuthorityEnumeration,
  ): Promise<MemoryDerivedIndexRebuildResult> {
    const before = this.store.list().length
    // 先清空后灌入：孤儿因此自然消失，不需要一套「比对权威层再删」的对账逻辑。
    this.store.clear()

    let indexedCount = 0
    let batch: PendingIndexEntry[] = []
    for await (const item of toAsyncIterable(source.listAll())) {
      batch.push({
        id: item.id,
        scopeType: item.scopeType,
        scopeId: item.scopeId,
        updatedAt: item.updatedAt,
        text: buildIndexText(item.title, item.summary, stringifyValue(item.value)),
      })
      if (batch.length >= this.embedBatchSize) {
        indexedCount += await this.embedAndUpsert(batch)
        batch = []
      }
    }
    indexedCount += await this.embedAndUpsert(batch)

    const version = formatMemoryDerivedIndexVersion(this.indexVersion)
    this.store.writeVersion(version)
    return {
      indexedCount,
      removedOrphanCount: Math.max(0, before - indexedCount),
      version,
    }
  }

  public async recall(
    query: string,
    options: MemoryRecallOptions = {},
  ): Promise<MemoryRecallItem[]> {
    const trimmed = (query ?? '').trim()
    if (isEmpty(trimmed)) return []

    const records = this.store.list().filter((record) => matchesVectorScope(record, options))
    if (isEmpty(records)) return []

    const [embedded] = await this.embedder.embed([trimmed])
    const queryVector = normalizeVector(embedded ?? [])
    if (queryVector.length === 0) return []

    const limit = Math.max(
      1,
      Math.min(options.limit ?? MemoryTuning.vector.defaultRecallLimit, MemoryTuning.vector.maxRecallLimit),
    )
    const scored: Array<{ record: MemoryVectorIndexRecord, score: number }> = []
    for (const record of records) {
      const score = dot(queryVector, record.vector)
      if (score >= this.minimumSimilarity) scored.push({ record, score })
    }
    scored.sort((left, right) => right.score - left.score || right.record.updatedAt - left.record.updatedAt)

    return scored.slice(0, limit).map(({ record, score }) => toPointerItem(record, score))
  }

  /** 派生索引没有内容，`getItem` 只能诚实地回 null——全文永远从权威层来。 */
  public getItem(): Nullable<MemoryRecallItem> {
    return null
  }

  public inspect(): MemoryBackendStats {
    const records = this.store.list()
    return {
      backendId: MemoryVectorBackendId,
      itemCount: records.length,
      pendingCount: 0,
      version: MemoryVectorIndex.schemaVersion,
      details: {
        embedding: this.embedder.identity,
        dimensions: this.embedder.dimensions,
        stale: this.isStale() ? 'yes' : 'no',
      },
    }
  }

  /** `archive` = 剔一个指针。派生层不持内容，「归档」在这里就只是让指针不再参与语义召回。 */
  public archive(id: string): MemoryForgetResult {
    const removed = this.store.remove([id])
    return { claimId: id, affectedEvidenceIds: removed > 0 ? [id] : [], treeVersion: 0 }
  }

  public async removePointers(ids: readonly string[]): Promise<number> {
    return this.store.remove(ids)
  }

  public async dropIndex(): Promise<void> {
    this.store.clear()
  }

  /** 分批嵌入并写进索引；返回实际写入条数。 */
  private async embedAndUpsert(entries: readonly PendingIndexEntry[]): Promise<number> {
    if (entries.length === 0) return 0

    let written = 0
    for (let offset = 0; offset < entries.length; offset += this.embedBatchSize) {
      const slice = entries.slice(offset, offset + this.embedBatchSize)
      const vectors = await this.embedder.embed(slice.map((entry) => entry.text))
      if (vectors.length !== slice.length) {
        throw new Error(
          `嵌入端口返回 ${vectors.length} 条向量，与入参 ${slice.length} 条不符：顺序对应是端口契约。`,
        )
      }
      const records: MemoryVectorIndexRecord[] = []
      for (const [index, entry] of slice.entries()) {
        const vector = normalizeVector(vectors[index])
        if (vector.length === 0) continue
        records.push({
          id: entry.id,
          scopeType: entry.scopeType,
          scopeId: entry.scopeId,
          updatedAt: entry.updatedAt,
          vector,
        })
      }
      this.store.upsert(records)
      written += records.length
    }
    return written
  }
}

/**
 * 构造一个 `memory-vector` 派生索引后端。
 *
 * 嵌入与存储全部注入：包内零模型、零原生模块、零宿主假设。
 */
export function createMemoryVectorBackend(
  options: MemoryVectorBackendOptions,
): MemoryDerivedIndexBackend {
  return new MemoryVectorBackend(options)
}
