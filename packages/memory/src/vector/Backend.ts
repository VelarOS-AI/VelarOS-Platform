/**
 * `memory-vector` —— **市场可选的增强档，派生索引角色**（§九 9.1 / 9.2）。
 *
 * 它做且只做一件事：把权威层已经落地的条目嵌成向量，让「意思相近但用词不同」也能召回。
 * 因此它：
 * - **不是权威层**：`role = 'derived-index'`，`descriptor.verbs` 不含 `capture`——它不吃原始
 *   证据，只吃权威层 capture 之后的 `MemoryEvidenceRecord`（那里才有指针）；
 * - **不持内容副本**：索引记录只有 `{指针, 作用域, 向量}`。卸载 = `dropIndex()` = 删派生文件，
 *   权威内容一个字节没动；
 * - **不写迁移器**：换嵌入模型或升级索引 schema → 版本戳对不上 → `isStale()` 为真 → 全量重建。
 *
 * 缺席时会怎样已经由 §九 写死：recall 退回权威层的索引行匹配，**功能面不缺，只是召回变笨**。
 * 这个后端因此从不承担「没有我就不行」的角色，也没有任何调用点需要判断它在不在。
 */

import type { MemoryBackendDescriptor, MemoryBackendStats } from '../backend/Contract'
import type {
  MemoryAuthorityEnumeration,
  MemoryDerivedIndexBackend,
  MemoryDerivedIndexRebuildResult,
  MemoryDerivedIndexVersion,
} from '../backend/DerivedIndex'
import { formatMemoryDerivedIndexVersion } from '../backend/DerivedIndex'
import type {
  MemoryCaptureBatchResult,
  MemoryCaptureResult,
  MemoryEvidenceRecord,
  MemoryRecallItem,
  MemoryRecallOptions,
  MemoryScopeType,
} from '../memory-tree/Types'
import { isMemoryVisibleInScope } from '../MemoryScope'

import { type MemoryEmbedder, MemoryVectorBackendId, type MemoryVectorIndexRecord, type MemoryVectorIndexStore } from './Contract'
import { createInMemoryVectorIndexStore } from './Store'

/** 索引记录形状的版本。改了记录字段就 +1——老索引因此自动作废重建，不写迁移器。 */
export const MemoryVectorIndexSchemaVersion = 1

/** 一次嵌入调用最多送多少条：批太大撞 provider 上限，批太小把往返次数变成瓶颈。 */
const DefaultEmbedBatchSize = 64
const DefaultRecallLimit = 10
const MaxRecallLimit = 200
/** 相似度地板：低于它的命中不如不给——语义召回给一堆不相关的东西比空手更坏。 */
const DefaultMinimumSimilarity = 0.2
/** 单条送嵌入的正文上限：记忆条目本就短，超长的多半是误采集，截断好过把 token 烧在噪声上。 */
const MaxEmbeddedTextLength = 4000

export interface MemoryVectorBackendOptions {
  /** 嵌入端口（宿主注入；包内零模型假设）。 */
  readonly embedder: MemoryEmbedder
  /** 索引存储；缺省用纯内存实现（宿主须显式注入 `createFileVectorIndexStore(...)` 才有持久化）。 */
  readonly store?: MemoryVectorIndexStore
  readonly embedBatchSize?: number
  readonly minimumSimilarity?: number
}

const vectorDescriptor: MemoryBackendDescriptor & { role: 'derived-index' } = Object.freeze({
  id: MemoryVectorBackendId,
  role: 'derived-index' as const,
  displayName: 'Memory vector (semantic derived index)',
  // capture 不在列:派生索引不吃原始证据。声明缺席让 supportsMemoryBackendVerb 机械可查,
  // 不是靠读文档才知道 captureBatch 会拒收。
  verbs: Object.freeze(['recall', 'inspect', 'archive'] as const),
})

class MemoryVectorBackend implements MemoryDerivedIndexBackend {
  public readonly descriptor = vectorDescriptor
  public readonly indexVersion: MemoryDerivedIndexVersion

  private readonly store: MemoryVectorIndexStore
  private readonly embedder: MemoryEmbedder
  private readonly embedBatchSize: number
  private readonly minimumSimilarity: number

  public constructor(options: MemoryVectorBackendOptions) {
    this.embedder = options.embedder
    this.store = options.store ?? createInMemoryVectorIndexStore()
    this.embedBatchSize = Math.max(1, options.embedBatchSize ?? DefaultEmbedBatchSize)
    this.minimumSimilarity = options.minimumSimilarity ?? DefaultMinimumSimilarity
    this.indexVersion = Object.freeze({
      schema: MemoryVectorIndexSchemaVersion,
      embedding: options.embedder.identity,
    })
  }

  public isStale(): boolean {
    return this.store.readVersion() !== formatMemoryDerivedIndexVersion(this.indexVersion)
  }

  /**
   * 窄端口的 `capture`：**显式拒收，且是抛错**。
   *
   * 原始证据还没有指针（指针由权威层在落地时分配），派生索引接了也不知道该指向谁。这条路只有
   * 「把派生索引当权威后端装」才会走到——而那已经被 `resolveMemoryStoreBackend` 的角色门挡在
   * 前面；这里是第二道门。**不静默返回 `inserted: false`**：那会让「装错了后端」表现为
   * 「记忆写了但一条都没存下」，而这是最不该安静失败的一件事。
   */
  public capture(): MemoryCaptureResult {
    throw new Error(
      'memory-vector 是派生索引，不接受原始证据；双写的第二写请走 indexEvidence()。',
    )
  }

  public captureBatch(): MemoryCaptureBatchResult {
    throw new Error(
      'memory-vector 是派生索引，不接受原始证据；双写的第二写请走 indexEvidence()。',
    )
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
      .filter((entry) => entry.id.length > 0 && entry.text.length > 0)
    return this.embedAndUpsert(pending)
  }

  public async rebuild(
    source: MemoryAuthorityEnumeration,
  ): Promise<MemoryDerivedIndexRebuildResult> {
    const before = this.store.list().length
    // 先清空后灌入:孤儿因此自然消失,不需要一套「比对权威层再删」的对账逻辑。
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
    if (trimmed.length === 0) return []

    const records = this.store.list().filter((record) => matchesScope(record, options))
    if (records.length === 0) return []

    const [embedded] = await this.embedder.embed([trimmed])
    const queryVector = normalize(embedded ?? [])
    if (queryVector.length === 0) return []

    const limit = Math.max(1, Math.min(options.limit ?? DefaultRecallLimit, MaxRecallLimit))
    const scored: Array<{ record: MemoryVectorIndexRecord; score: number }> = []
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
      version: MemoryVectorIndexSchemaVersion,
      details: {
        embedding: this.embedder.identity,
        dimensions: this.embedder.dimensions,
        stale: this.isStale() ? 'yes' : 'no',
      },
    }
  }

  /** `archive` = 剔一个指针。派生层不持内容，「归档」在这里就只是让指针不再参与语义召回。 */
  public archive(id: string) {
    const removed = this.store.remove([id])
    return { claimId: id, affectedEvidenceIds: removed > 0 ? [id] : [], treeVersion: 0 }
  }

  public async removePointers(ids: readonly string[]): Promise<number> {
    return this.store.remove(ids)
  }

  public async dropIndex(): Promise<void> {
    this.store.clear()
  }

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
        const vector = normalize(vectors[index])
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

interface PendingIndexEntry {
  id: string
  scopeType: MemoryScopeType
  scopeId: string
  updatedAt: number
  text: string
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

function buildIndexText(title: string, summary: string, body: string): string {
  return [title, summary, body]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join('\n')
    .slice(0, MaxEmbeddedTextLength)
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    // arch-guard:silent-catch-ok 任意元数据无法序列化时使用空文本，向量正文仍可继续索引。
    return ''
  }
}

/**
 * 作用域过滤 —— 与权威层**同一个函数**，不是「同一套语义」的口头承诺。
 *
 * 语义召回如果不认作用域，就会把别的项目的记忆捞进来；这是**隔离**问题，不是相关性问题，
 * 所以它在打分之前就发生。派生索引横跨历史上索引过的每一个项目，因此这里的判据只要比
 * 权威层松一点，泄漏面就是全库——曾经的 `scopeId.endsWith(workspaceRoot)` 正是这样一格。
 */
function matchesScope(record: MemoryVectorIndexRecord, options: MemoryRecallOptions): boolean {
  return isMemoryVisibleInScope(record, {
    scopeId: options.scopeId,
    workspaceRoot: options.workspaceRoot,
    includeGlobal: options.includeGlobal,
  })
}

/**
 * 指针条目：只有 id / 作用域 / 相似度，**没有内容**。
 *
 * 编排层拿它回权威层 `getItem` 取全文。直接把这个东西当召回结果给用户是错的——那正是
 * 「索引持了内容副本」的反面失败：什么都没有。
 */
function toPointerItem(record: MemoryVectorIndexRecord, score: number): MemoryRecallItem {
  return {
    id: record.id,
    claimId: record.id,
    conceptId: record.id,
    conceptType: 'entity',
    predicate: 'memory',
    title: '',
    summary: '',
    value: null,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    confidence: score,
    salience: score,
    activation: 1,
    updatedAt: record.updatedAt,
    snapshotVersion: 0,
    retrievalReason: 'deep',
    evidenceIds: [record.id],
    sourceTypes: [],
    path: [],
  }
}

function normalize(values: readonly number[]): Float32Array {
  let sum = 0
  for (const value of values) sum += value * value
  const magnitude = Math.sqrt(sum)
  if (!Number.isFinite(magnitude) || magnitude === 0) return new Float32Array(0)

  const normalized = new Float32Array(values.length)
  for (let index = 0; index < values.length; index += 1) {
    normalized[index] = values[index] / magnitude
  }
  return normalized
}

/** 两个已归一化向量的点积 = 余弦相似度。维度不符按最短的算（换模型的索引本就该重建）。 */
function dot(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length)
  let sum = 0
  for (let index = 0; index < length; index += 1) sum += left[index] * right[index]
  return sum
}

async function* toAsyncIterable<T>(
  source: AsyncIterable<T> | Iterable<T>,
): AsyncIterable<T> {
  if (Symbol.asyncIterator in source) {
    yield* source as AsyncIterable<T>
    return
  }
  yield* source as Iterable<T>
}
