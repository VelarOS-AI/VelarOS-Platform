/**
 * 叠加编排 —— **权威层恒在，派生层可摘**（mod-architecture-blueprint §九 9.2）。
 *
 * - **capture 双写**：权威层先落地，派生层再消费落地结果。派生写失败**只记诊断，绝不冒泡**
 *   ——派生物可重建，为了一个索引回滚用户刚说的话是本末倒置；
 * - **recall 并联**：语义命中拿到的是**指针**，回权威层 `getItem` 取全文。索引因此永远只持
 *   指针与向量，「删索引」不会变成删内容。
 *
 * 叠加**不产生第三个后端身份**：组合体的 `descriptor.id` 就是权威层的 id。这套记忆是谁，
 * 由权威层决定；派生层装没装只是快慢之别。
 *
 * 指针空间由权威层定义：权威层 `getItem` 认不出的指针即**孤儿**，当场从结果里剔除并异步清理。
 */

import { isEmpty, isFunction } from '@velaros-ai/core'

import type {
  MemoryAuthorityEnumeration,
  MemoryDerivedIndexBackend,
  MemoryStoreBackend,
} from '../../contract/requires'
import type { MemoryDerivedIndexFailure } from '../../types/backends'
import type {
  MemoryBackendCaptureBatchOptions,
  MemoryBackendDescriptor,
  MemoryBackendStats,
  MemoryCaptureBatchResult,
  MemoryCaptureResult,
  MemoryDerivedIndexRebuildResult,
  MemoryDreamRunOptions,
  MemoryDreamRunResult,
  MemoryEvidenceEligibilityResult,
  MemoryEvidenceEligibilityState,
  MemoryEvidenceInput,
  MemoryForgetResult,
  MemoryRecallItem,
  MemoryRecallOptions,
  MemorySourceEligibilityResult,
} from '../../types/memory'
import {
  interleaveById,
  isMemoryRecallItemExcluded,
  resolveAuthorityEnumeration,
  supportsMemoryBackendVerb,
} from '../../utils/backends'
import { MemoryTuning } from '../../utils/tuning'

/** 叠加体对外的整件能力：窄端口全部动词，外加派生索引的诊断与重建口。 */
export interface LayeredMemoryStoreBackend extends MemoryStoreBackend {
  /** 在册的派生索引自述，供宿主诊断面展示。 */
  readonly derivedDescriptors: readonly MemoryBackendDescriptor[]
  /** 有没有派生索引过期（换了嵌入模型 / 索引 schema 升级 / 从没建过）。 */
  hasStaleDerivedIndex(): boolean
  /**
   * 全量重建所有派生索引。
   *
   * 没有枚举源时**明确失败**而不是重建出一份残缺索引：残缺的索引比没有索引更坏，因为它看起来
   * 在工作。
   */
  rebuildDerivedIndexes(): Promise<readonly MemoryDerivedIndexRebuildResult[]>
  /** 卸载派生索引：删光派生数据，权威内容零丢失（签名上就够不着权威层）。 */
  dropDerivedIndexes(): Promise<void>
}

/** 一个叠加体要什么。 */
export interface LayeredMemoryStoreBackendOptions {
  /** 权威层后端：记忆内容的唯一真相。 */
  readonly authority: MemoryStoreBackend
  /** 派生索引，可以零个（= 纯权威层，与没有叠加编排时逐字等价）。 */
  readonly derived?: readonly MemoryDerivedIndexBackend[]
  /** 派生层失败汇报口；不传即静默丢弃（失败绝不影响权威路径的返回值）。 */
  readonly onDerivedFailure?: (failure: MemoryDerivedIndexFailure) => void
  /**
   * 并联时向语义层多要几倍候选。多要是因为语义命中要经权威层回捞，
   * 孤儿会在回捞时掉队，只要 `limit` 个会让最终结果偏少。缺省取可调参数表。
   */
  readonly derivedCandidateFactor?: number
  /** 权威层全量枚举源；缺省从权威后端结构上探测（`memory-files` 自带）。 */
  readonly authoritySource?: MemoryAuthorityEnumeration
}

/** 把一个权威层与若干派生索引叠成一个后端；实例由 `createLayeredMemoryStoreBackend` 造。 */
export class LayeredMemoryStore implements LayeredMemoryStoreBackend {
  public readonly descriptor: MemoryBackendDescriptor

  public readonly derivedDescriptors: readonly MemoryBackendDescriptor[]

  /** 归档：权威层声明并实现了 `archive` 才挂，声明与实现必须一致。 */
  public archive?: (id: string) => Promise<MemoryForgetResult>

  /** 整理：权威层声明并实现了 `dream` 才挂。 */
  public dream?: (options: MemoryDreamRunOptions) => MemoryDreamRunResult | Promise<MemoryDreamRunResult>

  /** 按来源改证据可用性：权威层有这个方法才挂。 */
  public governSourceEligibility?: (
    sourceId: string,
    state: MemoryEvidenceEligibilityState,
  ) => MemorySourceEligibilityResult | Promise<MemorySourceEligibilityResult>

  /** 按单条证据改可用性：权威层有这个方法才挂。 */
  public governEvidenceEligibility?: (
    evidenceId: string,
    state: MemoryEvidenceEligibilityState,
  ) => MemoryEvidenceEligibilityResult | Promise<MemoryEvidenceEligibilityResult>

  private readonly authority: MemoryStoreBackend

  private readonly derived: readonly MemoryDerivedIndexBackend[]

  private readonly candidateFactor: number

  private readonly authoritySource?: MemoryAuthorityEnumeration

  private readonly onDerivedFailure?: (failure: MemoryDerivedIndexFailure) => void

  public constructor(options: LayeredMemoryStoreBackendOptions) {
    this.authority = options.authority
    this.derived = options.derived ?? []
    this.authoritySource = options.authoritySource
    this.onDerivedFailure = options.onDerivedFailure
    this.candidateFactor = Math.max(
      1,
      options.derivedCandidateFactor ?? MemoryTuning.layered.derivedCandidateFactor,
    )
    this.descriptor = Object.freeze({
      ...this.authority.descriptor,
      displayName: isEmpty(this.derived)
        ? this.authority.descriptor.displayName
        : `${this.authority.descriptor.displayName} + ${this.derived.length} 个派生索引`,
    })
    this.derivedDescriptors = Object.freeze(this.derived.map((index) => index.descriptor))

    // 可选动词按权威层的能力**条件挂载**：声明与实现必须一致，挂一个「内部再判一次能力」的
    // 空壳会让「没装就没有」退化成「装了但不干活」。
    if (supportsMemoryBackendVerb(this.authority, 'archive')) {
      this.archive = async (id: string): Promise<MemoryForgetResult> => {
        const result = await this.authority.archive!(id)
        await this.removePointers([id])
        return result
      }
    }
    if (supportsMemoryBackendVerb(this.authority, 'dream')) {
      this.dream = (dreamOptions) => this.authority.dream!(dreamOptions)
    }
    if (isFunction(this.authority.governSourceEligibility)) {
      this.governSourceEligibility = (sourceId, state) =>
        this.authority.governSourceEligibility!(sourceId, state)
    }
    if (isFunction(this.authority.governEvidenceEligibility)) {
      this.governEvidenceEligibility = (evidenceId, state) =>
        this.authority.governEvidenceEligibility!(evidenceId, state)
    }
  }

  public async capture(input: MemoryEvidenceInput): Promise<MemoryCaptureResult> {
    const result = await this.authority.capture(input)
    await this.indexEvidence({ evidence: [result.evidence], insertedCount: 0, treeVersion: 0 })
    return result
  }

  public async captureBatch(
    inputs: readonly MemoryEvidenceInput[],
    captureOptions?: MemoryBackendCaptureBatchOptions,
  ): Promise<MemoryCaptureBatchResult> {
    // 权威层先落地。它抛错就是真抛错——权威写入失败不该被派生层的存在改写语义。
    const result = await this.authority.captureBatch(inputs, captureOptions)
    await this.indexEvidence(result)
    return result
  }

  public async recall(
    query: string,
    recallOptions: MemoryRecallOptions = {},
  ): Promise<MemoryRecallItem[]> {
    const limit = Math.max(1, recallOptions.limit ?? MemoryTuning.layered.defaultRecallLimit)
    const lexical = await this.authority.recall(query, recallOptions)
    if (isEmpty(this.derived)) return lexical

    const { items: semantic, orphanIds } = await this.recallSemantic(query, recallOptions, limit)
    // 孤儿清理不挡召回：剔出结果后异步清，失败也只是诊断。
    void this.removePointers(orphanIds)

    return interleaveById(lexical, semantic, limit)
  }

  public getItem(id: string) {
    return this.authority.getItem(id)
  }

  public async inspect(): Promise<MemoryBackendStats> {
    const stats = await this.authority.inspect()
    if (isEmpty(this.derived)) return stats

    const details: Record<string, number | string> = { ...stats.details }
    for (const index of this.derived) {
      const indexStats = await this.bestEffort(index.descriptor.id, 'recall', async () => index.inspect())
      // 读不到（这一层刚好出错）时写一个不可能的条数，诊断面一眼看得出这格没答上来。
      details[`derived:${index.descriptor.id}`] = indexStats ? indexStats.itemCount : -1
      details[`derived:${index.descriptor.id}:stale`] = index.isStale() ? 'yes' : 'no'
    }
    return { ...stats, details }
  }

  public hasStaleDerivedIndex(): boolean {
    return this.derived.some((index) => index.isStale())
  }

  public async rebuildDerivedIndexes(): Promise<readonly MemoryDerivedIndexRebuildResult[]> {
    if (isEmpty(this.derived)) return []
    const source = this.authoritySource ?? resolveAuthorityEnumeration(this.authority)
    if (!source) {
      throw new Error(
        `权威后端 ${this.authority.descriptor.id} 不提供全量枚举，派生索引无法重建；`
        + '请注入 authoritySource（残缺索引比没有索引更坏）。',
      )
    }
    const results: MemoryDerivedIndexRebuildResult[] = []
    for (const index of this.derived) {
      const result = await this.bestEffort(index.descriptor.id, 'rebuild', () => index.rebuild(source))
      if (result) results.push(result)
    }
    return results
  }

  public async dropDerivedIndexes(): Promise<void> {
    for (const index of this.derived) {
      await this.bestEffort(index.descriptor.id, 'rebuild', () => index.dropIndex())
    }
  }

  /** 派生层的每一次触达都套这层：**失败只报不抛**，权威路径的返回值不受任何影响。 */
  private async bestEffort<T>(
    backendId: string,
    stage: MemoryDerivedIndexFailure['stage'],
    run: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await run()
    // @arch-guard:suspend code-style/require-error-logging 理由：派生索引失败经 onDerivedFailure 结构化诊断端口上报，且权威路径契约要求不抛出。
    } catch (error) {
      this.onDerivedFailure?.({ backendId, stage, error })
      return undefined
    }
  }

  /** 双写的第二写：把权威层落地的结果喂给每个派生索引。 */
  private async indexEvidence(result: MemoryCaptureBatchResult): Promise<void> {
    if (isEmpty(this.derived) || isEmpty(result.evidence)) return
    for (const index of this.derived) {
      await this.bestEffort(index.descriptor.id, 'index', () => index.indexEvidence(result.evidence))
    }
  }

  /** 把一批指针从每个派生索引里剔掉（孤儿清理与归档共用）。 */
  private async removePointers(ids: readonly string[]): Promise<void> {
    if (isEmpty(ids)) return
    for (const index of this.derived) {
      await this.bestEffort(index.descriptor.id, 'prune', () => index.removePointers(ids))
    }
  }

  /** 并联的语义通道：向派生索引要指针，回权威层取全文，认不出的指针记成孤儿。 */
  private async recallSemantic(
    query: string,
    recallOptions: MemoryRecallOptions,
    limit: number,
  ): Promise<{ items: MemoryRecallItem[], orphanIds: string[] }> {
    const candidateLimit = Math.min(
      limit * this.candidateFactor,
      MemoryTuning.layered.maxDerivedCandidates,
    )
    const items: MemoryRecallItem[] = []
    const orphanIds: string[] = []
    const seen = new Set<string>()

    for (const index of this.derived) {
      const pointers = await this.bestEffort(index.descriptor.id, 'recall', async () =>
        index.recall(query, { ...recallOptions, limit: candidateLimit }))
      for (const pointer of pointers ?? []) {
        if (seen.has(pointer.id)) continue
        seen.add(pointer.id)
        // 回权威层取全文：索引只持指针，内容永远从权威层来。
        const full = await this.authority.getItem(pointer.id)
        if (!full) {
          orphanIds.push(pointer.id)
          continue
        }
        // 过滤与词法通道走同一个判据：否则重建派生索引之后归档条目会回到普通召回，
        // `categories` 也形同虚设。
        if (isMemoryRecallItemExcluded(full, recallOptions)) continue
        // 检索理由如实标成 semantic（语义层命中），内容逐字来自权威层。
        items.push({ ...full, retrievalReason: 'semantic' })
      }
    }
    return { items, orphanIds }
  }
}

/** 造一个叠加体：权威层恒在，派生层可摘。 */
export function createLayeredMemoryStoreBackend(
  options: LayeredMemoryStoreBackendOptions,
): LayeredMemoryStoreBackend {
  return new LayeredMemoryStore(options)
}
