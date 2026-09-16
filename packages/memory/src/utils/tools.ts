/**
 * 记忆工具的入参规则：类别归一、工作区根推断、召回结果投影、跨作用域读门。
 *
 * 这些都是纯规则，工具文件只写定义，执行交给 `impl/MemoryToolOperations.ts`。
 */

import { isEmpty, optionalWhen } from '@velaros-ai/core'

import { MemoryEvidenceCategoryAliases } from '../contract/constants'
import type { MemoryEvidenceCategory, MemoryPrivacyClass, MemoryRecallItem } from '../types/memory'
import type { MemoryToolCategory } from '../types/tool'

import { isMemoryVisibleInScope, MemoryScopePrefixes } from './scope'

/** 默认落 personal 隐私级的类别：这几类天然是关于用户本人的。 */
const PersonalCategories: readonly string[] = ['preference', 'feedback', 'user']

/** 画像模式固定看这几类。 */
export const ProfileCategories: readonly MemoryEvidenceCategory[] = [
  'preference',
  'feedback',
  'interest',
]

/** 把工具入参上的类别归一到后端认的类别；旧别名只在这一层存在。 */
export function normalizeMemoryCategory(category: MemoryToolCategory): MemoryEvidenceCategory {
  const alias = (MemoryEvidenceCategoryAliases as Readonly<Record<string, MemoryEvidenceCategory>>)[category]
  return alias ?? (category as MemoryEvidenceCategory)
}

/** 这个类别缺省落哪个隐私级。 */
export function defaultPrivacyClassFor(category: MemoryToolCategory): MemoryPrivacyClass {
  return PersonalCategories.includes(category) ? 'personal' : 'standard'
}

/** 推断这次调用的工作区根：显式给的优先，否则从当前项目作用域反解。 */
export function inferWorkspaceRoot(
  explicitRoot: LooseOptional<string>,
  memoryScope: LooseOptional<string>,
): string {
  const explicit = explicitRoot?.trim()
  if (explicit) return explicit
  const scope = memoryScope?.trim() ?? ''
  return scope.startsWith(MemoryScopePrefixes.project)
    ? scope.slice(MemoryScopePrefixes.project.length)
    : ''
}

/** 把一条召回结果投影成给模型看的紧凑条目（去掉模型用不上的内部字段）。 */
export function compactRecallItem(item: MemoryRecallItem): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    conceptType: item.conceptType,
    predicate: item.predicate,
    scopeType: item.scopeType,
    scopeId: item.scopeId,
    confidence: item.confidence,
    activation: item.activation,
    retrievalReason: item.retrievalReason,
    sources: item.evidenceIds,
    // 树路径只有树档有；文件档如实返回空数组，投影成缺席而不是一串空节点。
    path: optionalWhen(
      !isEmpty(item.path),
      item.path.map((node) => ({ type: node.nodeType, title: node.title })),
    ),
  }
}

// @arch-guard:suspend code-style/require-chinese-comments 理由：本块为中文说明，反引号内技术标识符密度触发启发式误报。
/**
 * 跨作用域读门 —— **全仓唯一一处**。
 *
 * 召回本身已按当前空间收敛（`memory:search` 传 scopeId）；`memory:get` 收的是模型手里的一个
 * id，没有这道门就等于「拿到任何 id 都能跨项目/跨站点读全文」。global 作用域的记忆按设计
 * 处处可读，`global` 记忆管理面（memoryScope = global）则代表「全部」，两者都放行。
 *
 * 判据本身住 `isMemoryVisibleInScope`（两轴单源），这里只把工具面的入参喂进去：读门与后端
 * 过滤必须是同一条真值表，否则「search 看不见但 get 读得到」就是一个可利用的越界口。
 * `memory:get` 只有会话身份轴（模型给的是 id，不是根），因此不传 workspaceRoot。
 */
export function isMemoryReadableInScope(
  item: MemoryRecallItem,
  memoryScope: LooseOptional<string>,
): boolean {
  return isMemoryVisibleInScope(item, { scopeId: memoryScope })
}
