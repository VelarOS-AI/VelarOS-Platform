/**
 * 叠加编排 —— **权威层恒在，派生层可摘**（mod-architecture-blueprint §九 9.2）。
 *
 * - **capture 双写**：权威层先落地，派生层再消费落地结果。派生写失败**只记诊断，绝不冒泡**
 *   ——派生物可重建，为了一个索引回滚用户刚说的话是本末倒置；
 * - **recall 并联**：语义命中拿到的是**指针**，回权威层 `getItem` 取全文。索引因此永远只持
 *   指针与向量，「删索引」不会变成删内容。
 *
 * 叠加**不产生第三个后端身份**：组合体的 `descriptor.id` 就是权威层的 id。这套记忆是谁，
 * 由权威层决定；派生层装没装只是快慢之别（§九 9.1「缺席时 recall 退回文件索引，功能面不缺」）。
 *
 * 指针空间由权威层定义：权威层 `getItem` 认不出的指针即**孤儿**，当场从结果里剔除并异步清理。
 * 这一条同时覆盖了「权威层删了这条」与「派生层的指针来自别的 id 空间」两种情况——后者不值得
 * 写第二套逻辑，让它退化成「派生层零贡献」正是缺席时的既定行为。
 */

import { isEmpty, isFunction } from '@velaros-ai/core'

import type {
  MemoryCaptureBatchResult,
  MemoryCaptureResult,
  MemoryEvidenceEligibilityResult,
  MemoryEvidenceEligibilityState,
  MemoryEvidenceInput,
  MemoryForgetResult,
  MemoryRecallItem,
  MemoryRecallOptions,
  MemorySourceEligibilityResult,
} from '../memory-tree/Types'

import type {
  MemoryBackendCaptureBatchOptions,
  MemoryBackendDescriptor,
  MemoryBackendStats,
  MemoryStoreBackend,
} from './Contract'
import { supportsMemoryBackendVerb } from './Contract'
import {
  type MemoryAuthorityEnumeration,
  type MemoryDerivedIndexBackend,
  type MemoryDerivedIndexRebuildResult,
  resolveAuthorityEnumeration,
} from './DerivedIndex'

/** 派生层出问题时的诊断事件。**永远只是诊断**——没有一条会改变权威层的返回值。 */
export interface MemoryDerivedIndexFailure {
  readonly backendId: string
  readonly stage: 'index' | 'recall' | 'prune' | 'archive' | 'rebuild'
  readonly error: unknown
}

export interface LayeredMemoryStoreBackendOptions {
  readonly authority: MemoryStoreBackend
  /** 派生索引，可以零个（= 纯权威层，与没有叠加编排时逐字等价）。 */
  readonly derived?: readonly MemoryDerivedIndexBackend[]
  /** 派生层失败汇报口；不传即静默丢弃（失败绝不影响权威路径的返回值）。 */
  readonly onDerivedFailure?: (failure: MemoryDerivedIndexFailure) => void
  /**
   * 并联时向语义层多要几倍候选（默认 3）。多要是因为语义命中要经权威层回捞，
   * 孤儿会在回捞时掉队，只要 `limit` 个会让最终结果偏少。
   */
  readonly derivedCandidateFactor?: number
  /** 权威层全量枚举源；缺省从权威后端结构上探测（`memory-files` 自带）。 */
  readonly authoritySource?: MemoryAuthorityEnumeration
}

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

const DefaultDerivedCandidateFactor = 3
const MaxDerivedCandidates = 200
const DefaultRecallLimit = 10

export function createLayeredMemoryStoreBackend(
  options: LayeredMemoryStoreBackendOptions,
): LayeredMemoryStoreBackend {
  const { authority } = options
  const derived = options.derived ?? []
  const candidateFactor = Math.max(1, options.derivedCandidateFactor ?? DefaultDerivedCandidateFactor)

  const report = (failure: MemoryDerivedIndexFailure): void => {
    options.onDerivedFailure?.(failure)
  }

  /** 派生层的每一次触达都套这层：**失败只报不抛**，权威路径的返回值不受任何影响。 */
  const bestEffort = async <T>(
    backendId: string,
    stage: MemoryDerivedIndexFailure['stage'],
    run: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await run()
    // @arch-guard:suspend code-style/require-error-logging 理由：派生索引失败经 onDerivedFailure 结构化诊断端口上报，且权威路径契约要求不抛出。
    } catch (error) {
      report({ backendId, stage, error })
      return undefined
    }
  }

  const indexEvidence = async (result: MemoryCaptureBatchResult): Promise<void> => {
    if (isEmpty(derived) || isEmpty(result.evidence)) return
    for (const index of derived) {
      await bestEffort(index.descriptor.id, 'index', () => index.indexEvidence(result.evidence))
    }
  }

  const removePointers = async (ids: readonly string[]): Promise<void> => {
    if (isEmpty(ids)) return
    for (const index of derived) {
      await bestEffort(index.descriptor.id, 'prune', () => index.removePointers(ids))
    }
  }

  const recallSemantic = async (
    query: string,
    options_: MemoryRecallOptions,
    limit: number,
  ): Promise<{ items: MemoryRecallItem[]; orphanIds: string[] }> => {
    const candidateLimit = Math.min(limit * candidateFactor, MaxDerivedCandidates)
    const items: MemoryRecallItem[] = []
    const orphanIds: string[] = []
    const seen = new Set<string>()

    for (const index of derived) {
      const pointers = await bestEffort(index.descriptor.id, 'recall', async () =>
        index.recall(query, { ...options_, limit: candidateLimit }))
      for (const pointer of pointers ?? []) {
        if (seen.has(pointer.id)) continue
        seen.add(pointer.id)
        // 回权威层取全文:索引只持指针,内容永远从权威层来。
        const full = await authority.getItem(pointer.id)
        if (!full) {
          orphanIds.push(pointer.id)
          continue
        }
        if (
          recallOptionsExcludeItem(full, options_)
        ) continue
        // 检索理由如实标成 deep(语义层),但内容逐字来自权威层。
        items.push({ ...full, retrievalReason: 'deep' })
      }
    }
    return { items, orphanIds }
  }

  const layeredDescriptor: MemoryBackendDescriptor = Object.freeze({
    ...authority.descriptor,
    displayName: derived.length === 0
      ? authority.descriptor.displayName
      : `${authority.descriptor.displayName} + ${derived.length} derived index`,
  })

  const backend: LayeredMemoryStoreBackend = {
    descriptor: layeredDescriptor,

    derivedDescriptors: Object.freeze(derived.map((index) => index.descriptor)),

    async capture(input: MemoryEvidenceInput): Promise<MemoryCaptureResult> {
      const result = await authority.capture(input)
      await indexEvidence({ evidence: [result.evidence], insertedCount: 0, treeVersion: 0 })
      return result
    },

    async captureBatch(
      inputs: readonly MemoryEvidenceInput[],
      captureOptions?: MemoryBackendCaptureBatchOptions,
    ): Promise<MemoryCaptureBatchResult> {
      // 权威层先落地。它抛错就是真抛错——权威写入失败不该被派生层的存在改写语义。
      const result = await authority.captureBatch(inputs, captureOptions)
      await indexEvidence(result)
      return result
    },

    async recall(query: string, recallOptions: MemoryRecallOptions = {}): Promise<MemoryRecallItem[]> {
      const limit = Math.max(1, recallOptions.limit ?? DefaultRecallLimit)
      const lexical = await authority.recall(query, recallOptions)
      if (derived.length === 0) return lexical

      const { items: semantic, orphanIds } = await recallSemantic(query, recallOptions, limit)
      // 孤儿清理不挡召回:剔出结果后异步清,失败也只是诊断。
      void removePointers(orphanIds)

      return interleaveById(lexical, semantic, limit)
    },

    getItem(id: string) {
      return authority.getItem(id)
    },

    async inspect(): Promise<MemoryBackendStats> {
      const stats = await authority.inspect()
      if (derived.length === 0) return stats

      const details: Record<string, number | string> = { ...stats.details }
      for (const index of derived) {
        const indexStats = await bestEffort(index.descriptor.id, 'recall', async () =>
          index.inspect())
        details[`derived:${index.descriptor.id}`] = indexStats?.itemCount ?? -1
        details[`derived:${index.descriptor.id}:stale`] = index.isStale() ? 'yes' : 'no'
      }
      return { ...stats, details }
    },

    hasStaleDerivedIndex(): boolean {
      return derived.some((index) => index.isStale())
    },

    async rebuildDerivedIndexes(): Promise<readonly MemoryDerivedIndexRebuildResult[]> {
      if (derived.length === 0) return []
      const source = options.authoritySource ?? resolveAuthorityEnumeration(authority)
      if (!source) {
        throw new Error(
          `权威后端 ${authority.descriptor.id} 不提供全量枚举，派生索引无法重建；`
          + '请注入 authoritySource（残缺索引比没有索引更坏）。',
        )
      }
      const results: MemoryDerivedIndexRebuildResult[] = []
      for (const index of derived) {
        const result = await bestEffort(index.descriptor.id, 'rebuild', () => index.rebuild(source))
        if (result) results.push(result)
      }
      return results
    },

    async dropDerivedIndexes(): Promise<void> {
      for (const index of derived) {
        await bestEffort(index.descriptor.id, 'rebuild', () => index.dropIndex())
      }
    },
  }

  // 可选动词按权威层的能力**条件挂载**:声明与实现必须一致(`supportsMemoryBackendVerb` 的判据),
  // 挂一个「内部再判一次能力」的空壳会让「没装就没有」退化成「装了但不干活」。
  if (supportsMemoryBackendVerb(authority, 'archive')) {
    backend.archive = async (id: string): Promise<MemoryForgetResult> => {
      const result = await authority.archive!(id)
      await removePointers([id])
      return result
    }
  }
  if (supportsMemoryBackendVerb(authority, 'dream')) {
    backend.dream = (dreamOptions) => authority.dream!(dreamOptions)
  }
  if (isFunction(authority.governSourceEligibility)) {
    backend.governSourceEligibility = (
      sourceId: string,
      state: MemoryEvidenceEligibilityState,
    ): MemorySourceEligibilityResult | Promise<MemorySourceEligibilityResult> =>
      authority.governSourceEligibility!(sourceId, state)
  }
  if (isFunction(authority.governEvidenceEligibility)) {
    backend.governEvidenceEligibility = (
      evidenceId: string,
      state: MemoryEvidenceEligibilityState,
    ): MemoryEvidenceEligibilityResult | Promise<MemoryEvidenceEligibilityResult> =>
      authority.governEvidenceEligibility!(evidenceId, state)
  }

  return backend
}

function recallOptionsExcludeItem(
  item: MemoryRecallItem,
  options: MemoryRecallOptions,
): boolean {
  if (options.excludeConversationObservations && item.predicate === 'conversation_observation')
    return true
  const excluded = options.excludeSourceTypes
  return Boolean(
    excluded?.length
    && item.sourceTypes?.length
    && item.sourceTypes.every((sourceType) => excluded.includes(sourceType))
  )
}

/**
 * 两路结果交错合并。
 *
 * **不按分数排序**：词法命中的分数（索引行匹配）与语义命中的余弦相似度不在一个量纲上，把它们
 * 放进一个 `sort` 是在编造一个没人定义过的可比性。交错则给两层各自保底的席位，也保住了
 * 「装了 vector 只会变好、不会把词法命中挤没」这条产品承诺。
 */
function interleaveById(
  lexical: readonly MemoryRecallItem[],
  semantic: readonly MemoryRecallItem[],
  limit: number,
): MemoryRecallItem[] {
  const merged: MemoryRecallItem[] = []
  const seen = new Set<string>()
  for (let cursor = 0; merged.length < limit; cursor += 1) {
    const left = lexical[cursor]
    const right = semantic[cursor]
    if (!left && !right) break
    for (const candidate of [left, right]) {
      if (!candidate || seen.has(candidate.id) || merged.length >= limit) continue
      seen.add(candidate.id)
      merged.push(candidate)
    }
  }
  return merged
}
