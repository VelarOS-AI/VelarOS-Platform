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

import { isEmpty, isTrue } from '@velaros-ai/core'

import type {
  MemoryConceptType,
  MemoryEvidenceCategory,
  MemoryRecallItem,
  MemoryRecallOptions,
} from '../types/memory'

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

export interface MemoryRecallFilterHints {
  /**
   * 这一条的确切证据类别（权威层读到全文时知道）。
   *
   * 缺席时按 `conceptType` 反推：类别到概念类型不是一一对应（`fact` 与 `entity` 都落 `entity`），
   * 反推只能宽一格。语义通道只有召回条目，宽一格也远好过完全不过滤。
   */
  readonly category?: string
}

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
