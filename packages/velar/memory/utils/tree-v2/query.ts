import { isEmpty, isPresent, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { MemoryTreeNodeStructV2 } from '../../types/tree-v2/diff.js'
import type {
  MemoryPathEntityIdsV2,
  MemoryRecallQueryV2,
  QueryAuthoritySnapshotV2,
} from '../../types/tree-v2/query.js'
import { MemoryTuning } from '../tuning.js'

import { compareCodeUnitV2 } from './checks.js'

/**
 * 查询门面的纯判据：入参校验、候选与路径构造、可见性判定与中文友好的查询切词。
 */

/** 敏感节点未授权时给的稳定模糊标签。 */
export const SensitiveLabelV2 = '敏感记忆'

/** 校验召回入参：查询必须是字符串，分支 id 非空，limit 是正安全整数。 */
export function validateRecallQueryV2(input: MemoryRecallQueryV2): void {
  if (!isString(input.query)) {
    throw new AppError('VALIDATION', 'memory recall query 必须是字符串。')
  }
  if (isPresent(input.branchTreeNodeId) && isEmpty(input.branchTreeNodeId)) {
    throw new AppError('VALIDATION', 'branchTreeNodeId 不得为空。')
  }
  if (isPresent(input.limit) && (!Number.isSafeInteger(input.limit) || input.limit < 1)) {
    throw new AppError('VALIDATION', 'memory recall limit 必须是正安全整数。')
  }
}

/** 索引没就绪时的确定性降级：优先当前全局主线，否则取权重最高的非根节点。 */
export function resolveFallbackNodesV2(
  snapshot: QueryAuthoritySnapshotV2,
  nodes: readonly MemoryTreeNodeStructV2[],
  denied: ReadonlySet<string>
): MemoryTreeNodeStructV2[] {
  const mainline = snapshot.globalMainlineNodeId
    ? nodes.find(
        (node) =>
          node.stableKey === snapshot.globalMainlineNodeId &&
          isQueryableNodeV2(node) &&
          !isDeniedNodeV2(node, denied)
      )
    : null
  if (mainline) return [mainline]
  const fallback = [...nodes]
    .filter(
      (node) =>
        isQueryableNodeV2(node) && !isDeniedNodeV2(node, denied) && node.namespace !== 'root'
    )
    .sort((left, right) => {
      if (left.mainlineScore !== right.mainlineScore) return right.mainlineScore - left.mainlineScore
      if (left.lastActiveAt !== right.lastActiveAt) return right.lastActiveAt - left.lastActiveAt
      return compareCodeUnitV2(left.stableKey, right.stableKey)
    })[0]
  return fallback ? [fallback] : []
}

/** 从命中节点沿父链走到根，最多取 MemoryTuning.treeV2.maxPathNodes 个；出现环抛 INVARIANT。 */
export function buildPathV2(
  anchor: MemoryTreeNodeStructV2,
  byStableKey: ReadonlyMap<string, MemoryTreeNodeStructV2>
): MemoryTreeNodeStructV2[] {
  const reversed: MemoryTreeNodeStructV2[] = []
  const visited = new Set<string>()
  let cursor: MemoryTreeNodeStructV2 | undefined = anchor
  while (cursor && reversed.length < MemoryTuning.treeV2.maxPathNodes) {
    if (visited.has(cursor.stableKey)) {
      throw new AppError('INVARIANT', '记忆树路径出现环。')
    }
    visited.add(cursor.stableKey)
    reversed.push(cursor)
    cursor = cursor.parentKey ? byStableKey.get(cursor.parentKey) : undefined
  }
  return reversed.reverse()
}

/** 把路径上的节点按实体种类分成概念、情节、主张三组 id，各自按码元序去重排好。 */
export function collectEntityIdsV2(
  nodes: readonly MemoryTreeNodeStructV2[]
): MemoryPathEntityIdsV2 {
  const conceptIds = new Set<string>()
  const episodeIds = new Set<string>()
  const claimIds = new Set<string>()
  for (const node of nodes) {
    if (node.subjectType === 'concept') conceptIds.add(node.subjectId)
    if (node.subjectType === 'episode') episodeIds.add(node.subjectId)
    if (node.subjectType === 'claim') claimIds.add(node.subjectId)
  }
  return {
    conceptIds: [...conceptIds].sort(compareCodeUnitV2),
    episodeIds: [...episodeIds].sort(compareCodeUnitV2),
    claimIds: [...claimIds].sort(compareCodeUnitV2),
  }
}

/** 这个节点能不能进查询：已 redact 的一律不进。 */
export function isQueryableNodeV2(node: MemoryTreeNodeStructV2): boolean {
  return node.visibilityState !== 'redacted' && !node.content.redacted
}

/** 这个节点在不在擦除名单里（按实体键或节点键命中都算）。 */
export function isDeniedNodeV2(
  node: MemoryTreeNodeStructV2,
  denied: ReadonlySet<string>
): boolean {
  return denied.has(subjectKeyV2(node)) || denied.has(`tree_node\0${node.stableKey}`)
}

/** 一个节点对应实体的键：`<subjectType>\0<subjectId>`。 */
export function subjectKeyV2(node: MemoryTreeNodeStructV2): string {
  return `${node.subjectType}\0${node.subjectId}`
}

/**
 * 查询切词：NFKC 小写归一化后按非字母数字切；汉字串另外补单字与相邻二字，
 * 这样中文不分词也能命中。
 */
export function tokenizeMemoryQueryV2(value: string): ReadonlySet<string> {
  const normalized = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, ' ')
    .trim()
  const tokens = new Set<string>()
  for (const word of normalized.split(/\s+/u)) {
    if (!word) continue
    tokens.add(word)
    const characters = [...word]
    if (characters.some((character) => /\p{Script=Han}/u.test(character))) {
      for (const character of characters) tokens.add(character)
      for (let index = 0; index < characters.length - 1; index += 1) {
        tokens.add(`${characters[index]}${characters[index + 1]}`)
      }
    }
  }
  return tokens
}

/** 数两个 token 集的交集大小。 */
export function countTokenOverlapV2(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>
): number {
  let count = 0
  for (const token of left) {
    if (right.has(token)) count += 1
  }
  return count
}
