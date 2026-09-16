// 检索去重作用域键的推导：同一个会话在不同分支/检查点下看到的历史不一样，重复检索的判定必须跟着分叉。
// 纯函数，不记状态，`ChatContextRetrievalService` 每次请求算一次。

import { isPositiveNumber, numberOrNull } from '@velaros-ai/core'

import type { SessionLineageContext } from '../../types/agent.js'
import { normalizeSessionLineageId, normalizeSessionLineageIdList } from '../chat/session-lineage'

/**
 * 算出这次请求的去重作用域 id：调用方给了 `retrievalScopeId` 就用它当基础（比如把范围收窄到单次工具执行），
 * 没给就退回 sessionId；后面再用冒号接上世系键。重复检索的计数和告警都按这个 id 分桶。
 */
export function resolveRetrievalScopeId(
  sessionId: string,
  retrievalScopeId: LooseOptional<string>,
  lineage: LooseOptional<SessionLineageContext>,
): string {
  const baseScope = retrievalScopeId?.trim() || sessionId
  const lineageScope = buildRetrievalLineageScopeKey(sessionId, lineage)
  return [baseScope, lineageScope].filter((item): item is string => !!item).join(':')
}

/**
 * 从会话世系上下文拼出一段作用域键，挂在基础 scope 后面，让换了分支、换了检查点、改了时间截断或改了可见分支集之后，
 * 同一个 handle/query 重新从 1 计数（在另一条分支上搜同一个词不算重复）。
 *
 * 没带世系、或世系说的 sessionId 跟当前这个对不上时返回 null（调用方就只用基础 scope）；
 * 分支或检查点缺失时分别退化成 `branch:unknown` 和 `head`，截断时间不是正数时记 `none`。
 */
export function buildRetrievalLineageScopeKey(
  sessionId: string,
  lineage: LooseOptional<SessionLineageContext>,
): Nullable<string> {
  const lineageSessionId = lineage?.sessionId?.trim()
  if (!lineage || !lineageSessionId || lineageSessionId !== sessionId) return null

  const branchId = normalizeSessionLineageId(lineage.activeBranchId) || 'branch:unknown'
  const checkpointId = normalizeSessionLineageId(lineage.activeCheckpointId) || 'head'
  const cutoffTimestamp = numberOrNull(lineage.cutoffTimestamp)
  const cutoff = isPositiveNumber(cutoffTimestamp) ? String(cutoffTimestamp) : 'none'
  const visibleBranchKey = normalizeSessionLineageIdList(lineage.visibleBranchIds).join(',')

  return [
    `branch=${branchId}`,
    `checkpoint=${checkpointId}`,
    `cutoff=${cutoff}`,
    `visible=${visibleBranchKey}`,
  ].join('|')
}
