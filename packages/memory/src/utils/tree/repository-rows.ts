import { isArray, isPlainObject, isString, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  MemoryEvidenceRecord,
  MemoryTreeNodeRecord,
  MemoryTreeSnapshotRecord,
} from '../../types/memory'
import type {
  EvidenceRow,
  MemoryIdentityEpochRow,
  MemoryTreeDiffOp,
  SnapshotRow,
  TreeDiffRow,
  TreeNodeRow,
} from '../../types/tree'
import { MemoryTuning } from '../tuning'

import { isMemoryTreeDiffOp } from './tree-projection'

const log = Log.tag('MemoryTreeRows')

/** 解析行里的 JSON 对象字段；坏数据记一条警告后按空对象降级，不让一行脏数据打断整次读取。 */
export function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return isPlainObject(parsed) ? (parsed) : {}
  } catch (error) {
    log.warn('invalid JSON in memory tree row', { error })
    return {}
  }
}

/** 解析主张的 value_json；历史上存过裸字符串，解析不出来时原样返回那个字符串。 */
export function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    // arch-guard:silent-catch-ok value_json 兼容原始字符串值，解析失败时原样返回。
    return value
  }
}

/** 解析行里的字符串数组字段；坏数据按空数组降级，权威正文不在这类辅助字段里。 */
export function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return isArray(parsed) ? parsed.filter(isString) : []
  } catch {
    // arch-guard:silent-catch-ok 损坏的辅助数组按空值降级，权威正文不在此字段。
    return []
  }
}

/** 把一行 memory_evidence 映射成对外的证据 DTO：下划线列名换成驼峰，metadata 顺手解析。 */
export function mapEvidenceRow(row: EvidenceRow): MemoryEvidenceRecord {
  return {
    id: row.id,
    sourceType: row.source_type,
    trustLevel: row.trust_level,
    sourceId: row.source_id,
    sessionId: row.session_id,
    executionId: row.execution_id,
    workspaceRoot: row.workspace_root,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    occurredAt: row.occurred_at,
    title: row.title,
    content: row.content,
    category: row.category,
    privacyClass: row.privacy_class,
    eligibilityState: row.eligibility_state,
    metadata: parseJsonObject(row.metadata_json),
    ingestSequence: row.ingest_sequence,
    createdAt: row.created_at,
  }
}

/** 把一行 memory_tree_nodes 映射成对外的树节点 DTO。 */
export function mapTreeNode(row: TreeNodeRow): MemoryTreeNodeRecord {
  return {
    id: row.id,
    stableKey: row.stable_key,
    parentId: row.parent_id,
    nodeType: row.node_type,
    namespace: row.namespace,
    title: row.title,
    summary: row.summary,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    mainlineScore: row.mainline_score,
    confidence: row.confidence,
    firstSeenAt: row.first_seen_at,
    lastActiveAt: row.last_active_at,
    projectionVersion: row.projection_version,
    activation: row.activation,
    visibilityState: row.visibility_state,
  }
}

/** 把一行 memory_tree_snapshots 映射成对外的快照 DTO。 */
export function mapSnapshot(row: SnapshotRow): MemoryTreeSnapshotRecord {
  return {
    version: row.version,
    rootNodeId: row.root_node_id,
    activeIdentityEpochId: row.active_identity_epoch_id,
    globalMainlineNodeId: row.global_mainline_node_id,
    frontierEvidenceSequence: row.frontier_evidence_sequence,
    treeHash: row.tree_hash,
    eventHeadHash: row.event_head_hash,
    createdAt: row.created_at,
  }
}

/** 读出一个身份纪元当前的支撑概念 id 列表。 */
export function readIdentitySupportingConceptIds(epoch: MemoryIdentityEpochRow): string[] {
  return parseStringArray(epoch.supporting_concept_ids_json)
}

/**
 * 把一行 memory_tree_diffs 的 ops_json 解析成 diff 操作序列。
 * JSON 损坏或有一项不合法就抛 INTERNAL：宁可报断链，也不拿半截 diff 回放出一棵假树。
 */
export function parseTreeOps(diff: TreeDiffRow): MemoryTreeDiffOp[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(diff.ops_json)
  } catch (error) {
    throw new AppError('INTERNAL', `记忆树 v${diff.version} diff JSON 损坏`, { cause: error })
  }
  if (!isArray(parsed) || !parsed.every(isMemoryTreeDiffOp)) {
    throw new AppError('INTERNAL', `记忆树 v${diff.version} diff 操作不合法`)
  }
  return parsed
}

/** 把一句查询拆成检索词：ASCII 标识符、几个语义关键词、连续汉字串；去重后只留前面若干个。 */
export function buildSearchTerms(query: string): string[] {
  const asciiTerms = query.match(/[A-Za-z0-9][A-Za-z0-9_.:/-]{1,}/g) ?? []
  const semanticTerms = (query.match(
    /长期目标|偏好|目标|项目|任务|兴趣|习惯|职业|身份|方法|结论|证据/gu
  ) ?? []).flatMap((term) => term === '长期目标' ? [term, '目标'] : [term])
  const chineseRuns = query.match(/[\p{Script=Han}]{2,12}/gu) ?? []
  return [...new Set([...asciiTerms, ...semanticTerms, ...chineseRuns])]
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, MemoryTuning.tree.likeTermsMax)
}

/** 把检索词拼成 FTS5 的 MATCH 表达式：剥掉会被当语法的符号，每个词做前缀匹配后取并集。 */
export function buildFtsQuery(terms: readonly string[]): string {
  return terms
    .map((term) => term.replace(/["*:^(){}]/g, '').replaceAll('[', '').replaceAll(']', '').trim())
    .filter((term) => term.length >= 2)
    .map((term) => `"${term}"*`)
    .join(' OR ')
}
