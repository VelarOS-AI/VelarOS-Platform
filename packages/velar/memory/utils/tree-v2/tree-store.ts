import {
  AppError,
  isArray,
  isEmpty,
  isNotNull,
  isNull,
  isPlainObject,
  isString,
  isUndefined,
} from '@velaros-ai/core'

import type { MemorySqliteDatabaseV2 } from '../../types/tree-v2/authority.js'
import type {
  MemoryTreeDiffOpTypeV2,
  MemoryTreeDiffOpV2,
  MemoryTreeDiffV2,
  MemoryTreeNodeStructV2,
  MemoryTreeReplayResultV2,
} from '../../types/tree-v2/diff.js'
import type {
  MemoryBlobStateRowV2,
  MemoryDreamRunCommitV2,
  MemoryMetaIntegerRowV2,
  MemoryTreeDiffRowV2,
  MemoryTreeIdentityChangeV2,
  MemoryTreeProjectionArtifactV2,
  MemoryTreeSnapshotRowV2,
  PersistedMemoryTreeCheckpointV2,
} from '../../types/tree-v2/store.js'

import {
  assertNonEmptyStringV2,
  assertNonNegativeSafeIntegerV2,
  isStrictRecordV2,
} from './checks.js'
import {
  canonicalStringifyV2,
  hashTreeStateV2,
  isMemoryTreeDiffOpV2,
  isMemoryTreeNodeStructV2,
  validateTreeDiffOpV2,
} from './diff-chain.js'

/**
 * 树存储与树投影派生代的纯判据：权威行的严格解析、提交前的树形校验、meta 读写与整理运行落库。
 * 这些都只依赖传进来的连接与数据，用不着实例状态，所以从两个类里提到这里。
 */

/** 树投影派生代的格式身份。 */
export const TreeProjectionArtifactFormatV2 = 'velaros.memory.tree-projection-index.v2'

/** 状态哈希与事件哈希的形态：64 位小写 hex。 */
export const TreeHashPatternV2 = /^[0-9a-f]{64}$/

/** 整理运行输入指纹的形态：`f2:` 加 64 位小写 hex。 */
export const DreamInputFingerprintPatternV2 = /^f2:[0-9a-f]{64}$/

/** 严格解析一行 diff：ops 必须是合法结构事件、必须是规范 canonical 字节。 */
export function parseMemoryTreeDiffRowV2(row: MemoryTreeDiffRowV2): MemoryTreeDiffV2 {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.ops_json)
  } catch (error) {
    throw new AppError('INVARIANT', 'TreeDiff v2 ops_json 无法解析。', error, {
      version: row.version,
    })
  }
  if (!isArray(parsed) || !parsed.every(isMemoryTreeDiffOpV2)) {
    throw new AppError('INVARIANT', 'TreeDiff v2 ops_json 含非法结构事件。', undefined, {
      version: row.version,
    })
  }
  if (row.ops_json !== canonicalStringifyV2(parsed)) {
    throw new AppError('INVARIANT', 'TreeDiff v2 ops_json 不是规范 canonical 字节。', undefined, {
      version: row.version,
    })
  }
  for (const op of parsed) validateTreeDiffOpV2(op)
  return {
    version: row.version,
    baseVersion: row.base_version,
    ops: parsed,
  }
}

/** 严格解析 identity_change_json；为 null 就是这一版没有身份变更。 */
export function parseIdentityChangeJsonV2(
  raw: Nullable<string>
): Nullable<MemoryTreeIdentityChangeV2> {
  if (isNull(raw)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new AppError('INVARIANT', 'identity_change_json 无法解析。', error)
  }
  if (!isIdentityChangeV2(parsed)) {
    throw new AppError('INVARIANT', 'identity_change_json 不符合严格结构。')
  }
  if (raw !== canonicalStringifyV2(parsed)) {
    throw new AppError('INVARIANT', 'identity_change_json 不是规范 canonical 字节。')
  }
  return parsed
}

/** 校验调用方给的身份变更结构合法，不合法抛 VALIDATION。 */
export function validateIdentityChangeV2(change: MemoryTreeIdentityChangeV2): void {
  if (!isIdentityChangeV2(change)) {
    throw new AppError('VALIDATION', 'identityChange 不符合严格结构。')
  }
}

/** 身份变更的运行时守卫：恰好三个字段，纪元 id 非空、序号为正、前驱可空。 */
export function isIdentityChangeV2(value: unknown): value is MemoryTreeIdentityChangeV2 {
  if (!isPlainObject(value)) return false
  const record = value
  const keys = Object.keys(record).sort()
  return (
    keys.length === 3 &&
    keys[0] === 'epochId' &&
    keys[1] === 'predecessorId' &&
    keys[2] === 'sequence' &&
    isString(record.epochId) &&
    !isEmpty(record.epochId) &&
    Number.isSafeInteger(record.sequence) &&
    (record.sequence as number) > 0 &&
    (isNull(record.predecessorId) ||
      (isString(record.predecessorId) && !isEmpty(record.predecessorId)))
  )
}

/**
 * 提交前的树形校验：非空、键唯一、评分在 [0,1]、redact 状态位与内容引用一致、
 * 恰好一个 stableKey=root 的根、父节点都存在、父链无环。
 */
export function validateCommittedTreeStateV2(nodes: readonly MemoryTreeNodeStructV2[]): void {
  if (isEmpty(nodes)) {
    throw new AppError('VALIDATION', '已提交树状态不得为空。')
  }
  const byKey = new Map<string, MemoryTreeNodeStructV2>()
  for (const node of nodes) {
    if (byKey.has(node.stableKey)) {
      throw new AppError('VALIDATION', '已提交树存在重复 stableKey。', undefined, {
        stableKey: node.stableKey,
      })
    }
    if (
      node.mainlineScore < 0 ||
      node.mainlineScore > 1 ||
      node.confidence < 0 ||
      node.confidence > 1 ||
      node.activation < 0 ||
      node.activation > 1
    ) {
      throw new AppError('VALIDATION', '树节点评分必须位于 [0, 1]。')
    }
    if (
      node.content.redacted !== (node.visibilityState === 'redacted') ||
      (node.content.redacted && isNotNull(node.content.blobRef))
    ) {
      throw new AppError('VALIDATION', '树节点 redact 状态位与内容引用不一致。')
    }
    byKey.set(node.stableKey, node)
  }
  const roots = nodes.filter((node) => isNull(node.parentKey))
  if (roots.length !== 1 || roots[0]?.stableKey !== 'root' || roots[0].nodeType !== 'root') {
    throw new AppError('VALIDATION', '已提交树必须且只能有一个 stableKey=root 的根节点。')
  }
  for (const node of nodes) {
    if (isNotNull(node.parentKey) && !byKey.has(node.parentKey)) {
      throw new AppError('VALIDATION', '树节点引用了不存在的父节点。', undefined, {
        stableKey: node.stableKey,
        parentKey: node.parentKey,
      })
    }
    const visited = new Set<string>()
    let cursor: MemoryTreeNodeStructV2 | undefined = node
    while (cursor && isNotNull(cursor.parentKey)) {
      if (visited.has(cursor.stableKey)) {
        throw new AppError('VALIDATION', '已提交树存在父链环。', undefined, {
          stableKey: node.stableKey,
        })
      }
      visited.add(cursor.stableKey)
      cursor = byKey.get(cursor.parentKey)
    }
  }
}

/** 提交前核对：树上引用到的每个 blob 都要在账本里且状态是 active。 */
export function assertReferencedBlobsExistV2(
  database: MemorySqliteDatabaseV2,
  nodes: readonly MemoryTreeNodeStructV2[]
): void {
  const blobRefs = [
    ...new Set(
      nodes.flatMap((node) => (isNull(node.content.blobRef) ? [] : [node.content.blobRef]))
    ),
  ]
  const lookup = database.prepare(`SELECT state FROM memory_content_blobs WHERE blob_id = ?`)
  for (const blobRef of blobRefs) {
    const row = lookup.get(blobRef) as MemoryBlobStateRowV2 | undefined
    if (!row || row.state !== 'active') {
      throw new AppError('VALIDATION', '树节点引用了缺失或已擦除的内容 blob。', undefined, {
        blobRef,
      })
    }
  }
}

/** 把一批结构事件按类型计数，连同总数一起落进 snapshot 的摘要列。 */
export function summarizeTreeDiffOpsV2(
  ops: readonly MemoryTreeDiffOpV2[]
): Record<string, number> {
  const summary: Record<MemoryTreeDiffOpTypeV2 | 'total', number> = {
    total: ops.length,
    add: 0,
    update: 0,
    move: 0,
    merge: 0,
    split: 0,
    dormant: 0,
    reactivate: 0,
    remove: 0,
    redact: 0,
  }
  for (const op of ops) summary[op.type] += 1
  return summary
}

/** 逐版核对 snapshot 的双锚点：状态哈希、事件头、根与主线节点、运行 id、时刻与摘要。 */
export function assertSnapshotAnchorsV2(
  database: MemorySqliteDatabaseV2,
  row: MemoryTreeDiffRowV2,
  ops: readonly MemoryTreeDiffOpV2[],
  current: MemoryTreeReplayResultV2
): void {
  const snapshot = database
    .prepare(`SELECT * FROM memory_tree_snapshots WHERE version = ?`)
    .get(row.version) as MemoryTreeSnapshotRowV2 | undefined
  if (
    !snapshot ||
    snapshot.tree_hash !== current.stateHash ||
    snapshot.event_head_hash !== row.event_hash ||
    snapshot.root_node_id !== current.nodes.find((node) => isNull(node.parentKey))?.stableKey ||
    !current.nodes.some((node) => node.stableKey === snapshot.global_mainline_node_id) ||
    snapshot.created_by_run_id !== row.created_by_run_id ||
    snapshot.created_at !== row.created_at ||
    snapshot.diff_summary_json !== canonicalStringifyV2(summarizeTreeDiffOpsV2(ops))
  ) {
    throw new AppError('INVARIANT', 'TreeDiff v2 snapshot 双锚点失配。', undefined, {
      version: row.version,
    })
  }
}

/** 读一个 memory_meta 的整数值；缺行就是库被动过，抛 INVARIANT。 */
export function readMemoryMetaV2(database: MemorySqliteDatabaseV2, key: string): number {
  const row = database.prepare(`SELECT integer_value FROM memory_meta WHERE key = ?`).get(key) as
    | MemoryMetaIntegerRowV2
    | undefined
  if (!row) throw new AppError('INVARIANT', `memory_meta 缺少 ${key}。`)
  return row.integer_value
}

/** 核对 frontier 推进合法：只进不退，且不得越过已采集的证据序号。 */
export function assertFrontierAdvanceIsValidV2(
  database: MemorySqliteDatabaseV2,
  frontierEvidenceSequence: number
): void {
  const current = readMemoryMetaV2(database, 'dream_frontier')
  const ingested = readMemoryMetaV2(database, 'evidence_ingest_sequence')
  if (frontierEvidenceSequence < current || frontierEvidenceSequence > ingested) {
    throw new AppError(
      'VALIDATION',
      'frontier 必须只进不退且不得越过已采集 Evidence。',
      undefined,
      { current, requested: frontierEvidenceSequence, ingested }
    )
  }
}

/** 校验整理运行的提交读数：运行 id 对得上、指纹形态合法、三个计数自洽。 */
export function validateDreamRunCommitV2(
  commit: MemoryDreamRunCommitV2,
  createdByRunId: string
): void {
  assertNonEmptyStringV2(commit.runId, 'dreamRunCommit.runId')
  if (commit.runId !== createdByRunId) {
    throw new AppError('VALIDATION', 'Dream run id 必须与 tree createdByRunId 一致。')
  }
  if (!DreamInputFingerprintPatternV2.test(commit.inputFingerprint)) {
    throw new AppError('VALIDATION', 'Dream input fingerprint 形态非法。')
  }
  assertNonNegativeSafeIntegerV2(commit.frontierBefore, 'dreamRunCommit.frontierBefore')
  assertNonNegativeSafeIntegerV2(commit.tokenUsage, 'dreamRunCommit.tokenUsage')
  assertNonNegativeSafeIntegerV2(commit.candidateCount, 'dreamRunCommit.candidateCount')
  assertNonNegativeSafeIntegerV2(commit.acceptedCount, 'dreamRunCommit.acceptedCount')
  assertNonNegativeSafeIntegerV2(commit.rejectedCount, 'dreamRunCommit.rejectedCount')
  if (commit.acceptedCount + commit.rejectedCount !== commit.candidateCount) {
    throw new AppError('VALIDATION', 'Dream 候选接受/拒绝计数与总数不一致。')
  }
  if (!isUndefined(commit.finishedAt)) {
    assertNonNegativeSafeIntegerV2(commit.finishedAt, 'dreamRunCommit.finishedAt')
  }
}

/** 把一次整理运行改成 committed；CAS 不中一行就是并发抢跑，抛 CONFLICT。 */
export function commitDreamRunRowV2(
  database: MemorySqliteDatabaseV2,
  commit: MemoryDreamRunCommitV2,
  treeVersionBefore: number,
  treeVersionAfter: number,
  frontierAfter: number,
  defaultFinishedAt: number
): void {
  const result = database
    .prepare(
      `UPDATE memory_dream_runs
       SET state = 'committed',
           frontier_after = ?,
           token_usage = ?,
           candidate_count = ?,
           accepted_count = ?,
           rejected_count = ?,
           tree_version_after = ?,
           finished_at = ?
       WHERE id = ?
         AND state = 'validating'
         AND input_fingerprint = ?
         AND frontier_before = ?
         AND tree_version_before = ?`
    )
    .run(
      frontierAfter,
      commit.tokenUsage,
      commit.candidateCount,
      commit.acceptedCount,
      commit.rejectedCount,
      treeVersionAfter,
      commit.finishedAt ?? defaultFinishedAt,
      commit.runId,
      commit.inputFingerprint,
      commit.frontierBefore,
      treeVersionBefore
    )
  if (result.changes !== 1) {
    throw new AppError('CONFLICT', 'Dream run 提交 CAS 失败。', undefined, {
      runId: commit.runId,
      treeVersionBefore,
      frontierBefore: commit.frontierBefore,
    })
  }
}

/**
 * 严格解析一代树投影产物：格式、字段、两层状态哈希与 canonical 字节四关都要过。
 * 任何一关不过都只意味着派生代不可信，调用方从权威链重建。
 */
export function parseTreeProjectionArtifactV2(raw: Buffer): MemoryTreeProjectionArtifactV2 {
  const source = raw.toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new AppError('VALIDATION', '树投影派生代不是合法 JSON。', error)
  }
  if (
    !isStrictRecordV2(parsed, [
      'checkpoints',
      'format',
      'nodes',
      'treeHash',
      'treeVersion',
    ]) ||
    parsed['format'] !== TreeProjectionArtifactFormatV2 ||
    !Number.isSafeInteger(parsed['treeVersion']) ||
    (parsed['treeVersion'] as number) < 1 ||
    !isString(parsed['treeHash']) ||
    !TreeHashPatternV2.test(parsed['treeHash']) ||
    !isArray(parsed['nodes']) ||
    !parsed['nodes'].every(isMemoryTreeNodeStructV2) ||
    !isArray(parsed['checkpoints'])
  ) {
    throw new AppError('VALIDATION', '树投影派生代不符合 v2 严格格式。')
  }
  const checkpoints: PersistedMemoryTreeCheckpointV2[] = []
  for (const candidate of parsed['checkpoints']) {
    if (
      !isStrictRecordV2(candidate, ['nodes', 'treeHash', 'version']) ||
      !Number.isSafeInteger(candidate['version']) ||
      (candidate['version'] as number) < 1 ||
      !isString(candidate['treeHash']) ||
      !TreeHashPatternV2.test(candidate['treeHash']) ||
      !isArray(candidate['nodes']) ||
      !candidate['nodes'].every(isMemoryTreeNodeStructV2)
    ) {
      throw new AppError('VALIDATION', '树投影 checkpoint 不符合 v2 严格格式。')
    }
    if (hashTreeStateV2(candidate['nodes']) !== candidate['treeHash']) {
      throw new AppError('INVARIANT', '树投影 checkpoint 状态哈希失配。')
    }
    checkpoints.push({
      version: candidate['version'] as number,
      treeHash: candidate['treeHash'],
      nodes: candidate['nodes'],
    })
  }
  if (hashTreeStateV2(parsed['nodes']) !== parsed['treeHash']) {
    throw new AppError('INVARIANT', '树投影派生代当前状态哈希失配。')
  }
  if (source !== canonicalStringifyV2(parsed)) {
    throw new AppError('INVARIANT', '树投影派生代不是规范 canonical 字节。')
  }
  return {
    format: TreeProjectionArtifactFormatV2,
    treeVersion: parsed['treeVersion'] as number,
    treeHash: parsed['treeHash'],
    nodes: parsed['nodes'],
    checkpoints,
  }
}

