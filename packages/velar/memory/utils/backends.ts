/**
 * 召回过滤 —— **词法通道与语义通道同一个判据**。
 *
 * 叠加编排的语义通道拿到指针后回权威层取全文，从前只看 `excludeConversationObservations` 与
 * `excludeSourceTypes` 两格，于是重建派生索引之后归档的记忆回到普通召回、`categories` 过滤
 * 形同虚设，回合自动召回把会话条目与归档条目一并注进模型上下文。过滤散成两份写法就一定会
 * 走偏，因此收成本文件一处，两条通道都调。
 *
 * 判据只认 `MemoryRecallItem` 上有的字段。`excludeSessionId` 与 `excludeAgentConversationEchoes`
 * 要看每条证据的会话与信任级，召回条目上没有这两格，只有树后端能在 SQL 里判——语义通道与文件
 * 档的词法通道一样不判它们，这是**如实的能力边界**，不是遗漏。
 */

import { isEmpty, isFunction, isTrue } from '@velaros-ai/core'

import type { MemoryBackendVerb } from '../contract/constants.js'
import { RequiredAuthorityMemoryVerbs } from '../contract/constants.js'
import type {
  MemoryAuthorityEnumeration,
  MemoryDerivedIndexBackend,
  MemoryStoreBackend,
} from '../contract/requires.js'
import type { MemoryRecallFilterHints } from '../types/backends.js'
import type {
  MemoryConceptType,
  MemoryDerivedIndexVersion,
  MemoryEvidenceCategory,
  MemoryRecallItem,
  MemoryRecallOptions,
} from '../types/memory.js'

export type { MemoryRecallFilterHints } from '../types/backends.js'

/** 证据类别 → 概念类型；文件后端按它给条目定概念类型，过滤时反过来用。 */
export const memoryConceptTypeByCategory: Readonly<Record<string, MemoryConceptType>> = {
  conversation: 'conversation',
  fact: 'entity',
  preference: 'user',
  feedback: 'user',
  procedure: 'procedure',
  project: 'project',
  task: 'task',
  goal: 'goal',
  interest: 'interest',
  entity: 'entity',
  artifact: 'artifact',
}

/** 这一条的类别在不在要的类别名单里：知道确切类别就精确比，不知道就按概念类型宽一格反推。 */
function matchesCategories(
  item: MemoryRecallItem,
  categories: readonly MemoryEvidenceCategory[],
  hints: MemoryRecallFilterHints,
): boolean {
  if (hints.category) return categories.includes(hints.category as MemoryEvidenceCategory)
  return categories.some((category) => memoryConceptTypeByCategory[category] === item.conceptType)
}

/** 这一条该不该被当前召回口径挡下来。 */
export function isMemoryRecallItemExcluded(
  item: MemoryRecallItem,
  options: MemoryRecallOptions,
  hints: MemoryRecallFilterHints = {},
): boolean {
  // 归档 = activation 归零：普通召回看不到，`includeDormant` 的深层召回才捞得回来。
  if (!isTrue(options.includeDormant) && item.activation <= 0) return true
  if (
    isTrue(options.excludeConversationObservations)
    && (item.predicate === 'conversation_observation' || item.conceptType === 'conversation')
  ) return true

  const categories = options.categories ?? []
  if (!isEmpty(categories) && !matchesCategories(item, categories, hints)) return true

  const excluded = options.excludeSourceTypes ?? []
  const sourceTypes = item.sourceTypes ?? []
  // 混合来源的条目只要还有一个未被排除的来源就保留（与树后端 SQL 同口径）。
  return (
    !isEmpty(excluded)
    && !isEmpty(sourceTypes)
    && sourceTypes.every((sourceType) => excluded.includes(sourceType))
  )
}

/** 后端是否声明并实现了某个可选动词（声明与实现必须一致，否则视为未实现）。 */
export function supportsMemoryBackendVerb(
  backend: MemoryStoreBackend,
  verb: MemoryBackendVerb,
): boolean {
  if (!backend.descriptor.verbs.includes(verb)) return false
  if (verb === 'archive') return isFunction(backend.archive)
  if (verb === 'dream') return isFunction(backend.dream)
  if (verb === 'govern') return (
      isFunction(backend.governSourceEligibility)
      || isFunction(backend.governEvidenceEligibility)
    )
  return true
}

/**
 * 一个权威层后端缺了哪些必备动词（空数组 = 合格）。
 *
 * 解析器用它把「装了一个半成品权威层」变成启动期可见的诊断，而不是等用户按下归档才发现
 * 这个后端根本没有归档。
 */
export function listMissingAuthorityMemoryVerbs(
  backend: MemoryStoreBackend,
): readonly MemoryBackendVerb[] {
  return RequiredAuthorityMemoryVerbs.filter(
    (verb) => !supportsMemoryBackendVerb(backend, verb),
  )
}

/** 派生索引版本戳的落盘形式；比较用字符串，避免各实现各写一套字段比较。 */
export function formatMemoryDerivedIndexVersion(version: MemoryDerivedIndexVersion): string {
  return `s${version.schema}|${version.embedding}`
}

/** 权威后端是否自带全量枚举；没有则重建不可能，调用方必须显式注入一个源。 */
export function resolveAuthorityEnumeration(
  backend: MemoryStoreBackend,
): MemoryAuthorityEnumeration | undefined {
  const candidate = backend as Partial<MemoryAuthorityEnumeration>
  return isFunction(candidate.listAll)
    ? (candidate as MemoryAuthorityEnumeration)
    : undefined
}

/** 运行时判一个后端是不是派生索引（角色是唯一判据，不做实现探测）。 */
export function isMemoryDerivedIndexBackend(
  backend: MemoryStoreBackend,
): backend is MemoryDerivedIndexBackend {
  return backend.descriptor.role === 'derived-index'
}

/**
 * 两路召回结果交错合并。
 *
 * **不按分数排序**：词法命中的分数（索引行匹配）与语义命中的余弦相似度不在一个量纲上，把它们
 * 放进一个 `sort` 是在编造一个没人定义过的可比性。交错则给两层各自保底的席位，也保住了
 * 「装了向量层只会变好、不会把词法命中挤没」这条产品承诺。
 */
export function interleaveById(
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
