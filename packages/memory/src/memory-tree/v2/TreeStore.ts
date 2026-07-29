import type BetterSqlite3 from 'better-sqlite3'

import { AppError } from '@velaros-ai/core/error'

import type { ContentKeyServiceV2 } from './storage/ContentKeyService'
import type { MemoryKeyringStoreV2 } from './storage/Keyring'
import type { MemoryAuthorityDatabaseV2 } from './AuthorityDatabase'
import {
  assertForwardReplayResultForPersistenceV2,
  canonicalStringifyV2,
  hashTreeEventV2,
  isMemoryTreeDiffOpV2,
  type MemoryTreeDiffOpTypeV2,
  type MemoryTreeDiffOpV2,
  type MemoryTreeDiffV2,
  type MemoryTreeNodeStructV2,
  type MemoryTreeReplayResultV2,
  replayTreeDiffsForwardV2,
  TreeDiffGenesisEventHashV2,
  validateTreeDiffOpV2,
} from './DiffChain'
import {
  buildMemoryTreeBaseStateV2,
  computeMemoryTreeBaseHashesV2,
  parseMemoryTreeBaseStateV2,
} from './TreeManifest'
import {
  MemoryTreeCheckpointIntervalV2,
  type MemoryTreeCheckpointV2,
  MemoryTreeProjectionIndexV2,
  type MemoryTreeProjectionInspectionV2,
} from './TreeProjectionIndex'

type SQLiteDatabase = InstanceType<typeof BetterSqlite3>

interface MemoryTreeDiffRowV2 {
  version: number
  base_version: number
  ops_json: string
  identity_change_json: string | null
  op_count: number
  previous_event_hash: string
  event_hash: string
  created_by_run_id: string
  created_at: number
}

interface MemoryTreeSnapshotRowV2 {
  version: number
  root_node_id: string
  active_identity_epoch_id: string
  global_mainline_node_id: string
  frontier_evidence_sequence: number
  created_by_run_id: string
  tree_hash: string
  event_head_hash: string
  diff_summary_json: string
  created_at: number
}

interface MemoryTreeBaseRowV2 {
  base_version: number
  state_blob_ref: string
  state_commitment: string
  tree_hash: string
  compacted_from_version: number
  compacted_to_version: number
  prior_segment_event_head: string
  base_event_hash: string
  canonical_version: number
  compaction_version: number
  manifest_hash: string
  created_at: number
}

export interface MemoryTreeIdentityChangeV2 {
  readonly epochId: string
  readonly sequence: number
  readonly predecessorId: string | null
}

export interface CommitMemoryTreeVersionInputV2 {
  readonly expectedBaseVersion: number
  readonly ops: readonly MemoryTreeDiffOpV2[]
  readonly identityChange?: MemoryTreeIdentityChangeV2 | null
  readonly activeIdentityEpochId: string
  readonly globalMainlineNodeId: string
  readonly frontierEvidenceSequence: number
  readonly createdByRunId: string
  readonly createdAt?: number
  readonly dreamRunCommit?: MemoryDreamRunCommitV2
  /** package-owned 参与者；在 tree CAS 后、snapshot/diff 前运行，抛错即整事务回滚。 */
  readonly authorityCommit?: MemoryTreeAuthorityCommitParticipantV2
  /** Erasure 第一段专用：即使没有投影节点命中，也推进事件版本使并发 Dream CAS 失效。 */
  readonly erasureCommit?: boolean
}

export interface MemoryTreeAuthorityCommitParticipantV2 {
  apply(): void
  applyAfterSnapshot?(): void
}

export interface MemoryDreamRunCommitV2 {
  readonly runId: string
  readonly inputFingerprint: string
  readonly frontierBefore: number
  readonly tokenUsage: number
  readonly candidateCount: number
  readonly acceptedCount: number
  readonly rejectedCount: number
  readonly finishedAt?: number
}

export interface CommitMemoryTreeVersionResultV2 {
  readonly version: number
  readonly treeHash: string
  readonly eventHash: string
  readonly projectionPersisted: boolean
}

export interface CommitMemoryDreamNoopInputV2 {
  readonly expectedTreeVersion: number
  readonly frontierEvidenceSequence: number
  readonly dreamRunCommit: MemoryDreamRunCommitV2
  readonly committedAt?: number
  readonly authorityCommit?: MemoryTreeAuthorityCommitParticipantV2
}

export interface CompactMemoryTreeHeadInputV2 {
  readonly compactionId: string
  readonly createdAt?: number
}

export interface CompactMemoryTreeHeadResultV2 {
  readonly baseVersion: number
  readonly baseEventHash: string
  readonly manifestHash: string
  readonly deletedDiffCount: number
}

export interface MemoryTreeStoreOpenReportV2 {
  readonly treeVersion: number
  readonly baseVersion: number
  readonly replayedDiffCount: number
  readonly checkpointCount: number
  readonly projectionRebuilt: boolean
}

interface ReconstructedTreeV2 {
  readonly version: number
  readonly baseVersion: number
  readonly eventHead: string
  readonly current: MemoryTreeReplayResultV2
  readonly checkpoints: readonly MemoryTreeCheckpointV2[]
  readonly replayedDiffCount: number
}

/**
 * Memory Tree v2 的 snapshot/diff/base authority owner。
 *
 * 所有写入先在内存正向应用并校验，再以 SQLite 单事务提交 snapshot + diff + meta CAS；
 * index projection 只在 authority 成功后刷新，失败时标记可重建，不反向污染权威提交。
 */
export class MemoryTreeStoreV2 {
  private currentVersion: number
  private baseVersion: number
  private eventHead: string
  private currentReplay: MemoryTreeReplayResultV2
  private checkpoints: MemoryTreeCheckpointV2[]

  private constructor(
    private readonly authority: MemoryAuthorityDatabaseV2,
    private readonly contentKeys: ContentKeyServiceV2,
    private readonly projectionIndex: MemoryTreeProjectionIndexV2,
    reconstructed: ReconstructedTreeV2
  ) {
    this.currentVersion = reconstructed.version
    this.baseVersion = reconstructed.baseVersion
    this.eventHead = reconstructed.eventHead
    this.currentReplay = reconstructed.current
    this.checkpoints = [...reconstructed.checkpoints]
  }

  public static open(input: {
    authority: MemoryAuthorityDatabaseV2
    contentKeys: ContentKeyServiceV2
    keyring: MemoryKeyringStoreV2
  }): { store: MemoryTreeStoreV2; report: MemoryTreeStoreOpenReportV2 } {
    const reconstructed = reconstructTreeFromAuthorityV2(
      input.authority.database,
      input.contentKeys
    )
    const projectionIndex = new MemoryTreeProjectionIndexV2(
      input.authority.roots.indexDir,
      input.keyring
    )
    let projectionRebuilt = false
    if (reconstructed.version > 0) {
      let projectionMatches = false
      try {
        projectionMatches =
          projectionIndex.inspect(reconstructed.version, reconstructed.current)
            ?.matchesAuthority === true
      } catch {
        projectionMatches = false
      }
      if (!projectionMatches) {
        projectionIndex.persist(
          reconstructed.version,
          reconstructed.current,
          reconstructed.checkpoints
        )
        projectionRebuilt = true
      }
    }
    return {
      store: new MemoryTreeStoreV2(
        input.authority,
        input.contentKeys,
        projectionIndex,
        reconstructed
      ),
      report: {
        treeVersion: reconstructed.version,
        baseVersion: reconstructed.baseVersion,
        replayedDiffCount: reconstructed.replayedDiffCount,
        checkpointCount: reconstructed.checkpoints.length,
        projectionRebuilt,
      },
    }
  }

  public get version(): number {
    return this.currentVersion
  }

  public get current(): MemoryTreeReplayResultV2 {
    return {
      nodes: this.currentReplay.nodes.map((node) => ({
        ...node,
        content: { ...node.content },
      })),
      stateHash: this.currentReplay.stateHash,
      direction: this.currentReplay.direction,
    }
  }

  public inspectProjection(): MemoryTreeProjectionInspectionV2 | null {
    if (this.currentVersion < 1) return null
    return this.projectionIndex.inspect(this.currentVersion, this.currentReplay)
  }

  public rebuildProjection(): number | null {
    if (this.currentVersion < 1) return null
    return this.projectionIndex.persist(
      this.currentVersion,
      this.currentReplay,
      this.checkpoints
    )
  }

  public commitVersion(input: CommitMemoryTreeVersionInputV2): CommitMemoryTreeVersionResultV2 {
    if (input.expectedBaseVersion !== this.currentVersion) {
      throw new AppError('CONFLICT', '树版本 CAS 失败：提交基线已过期。', undefined, {
        expectedBaseVersion: input.expectedBaseVersion,
        currentVersion: this.currentVersion,
      })
    }
    if (input.ops.length === 0 && !input.identityChange && !input.erasureCommit) {
      throw new AppError('VALIDATION', '空树变更不得创建新版本。')
    }
    if (
      input.erasureCommit &&
      input.ops.some(
        (op) =>
          op.type !== 'redact' &&
          !(
            op.type === 'add' &&
            op.after.every(
              (node) =>
                (node.namespace === 'identity' && node.nodeType === 'mainline') ||
                (node.namespace === 'root' && node.nodeType === 'root')
            )
          )
      )
    ) {
      throw new AppError('VALIDATION', 'Erasure 版本只允许 redact 与中性身份主线 add。')
    }
    assertNonEmptyV2(input.activeIdentityEpochId, 'activeIdentityEpochId')
    assertNonEmptyV2(input.globalMainlineNodeId, 'globalMainlineNodeId')
    assertNonEmptyV2(input.createdByRunId, 'createdByRunId')
    assertNonNegativeIntegerV2(input.frontierEvidenceSequence, 'frontierEvidenceSequence')
    assertFrontierAdvanceIsValidV2(this.authority.database, input.frontierEvidenceSequence)
    if (input.dreamRunCommit) {
      validateDreamRunCommitV2(input.dreamRunCommit, input.createdByRunId)
    }
    if (input.identityChange) validateIdentityChangeV2(input.identityChange)
    if (input.identityChange && input.identityChange.epochId !== input.activeIdentityEpochId) {
      throw new AppError('VALIDATION', 'identityChange epochId 必须与 activeIdentityEpochId 一致。')
    }
    for (const op of input.ops) validateTreeDiffOpV2(op)

    const version = this.currentVersion + 1
    const diff: MemoryTreeDiffV2 = {
      version,
      baseVersion: this.currentVersion,
      ops: input.ops,
    }
    const next = replayTreeDiffsForwardV2(this.currentReplay.nodes, [diff], {
      persistenceBase: this.currentReplay,
    })
    validateCommittedTreeStateV2(next.nodes)
    const root = next.nodes.find((node) => node.parentKey === null)
    if (!root) throw new AppError('INVARIANT', '提交后树缺少根节点。')
    if (!next.nodes.some((node) => node.stableKey === input.globalMainlineNodeId)) {
      throw new AppError('VALIDATION', 'globalMainlineNodeId 不在提交后树状态中。')
    }

    const identityChange = input.identityChange ?? null
    const eventHash = hashTreeEventV2({
      previousEventHash: this.eventHead,
      version,
      baseVersion: this.currentVersion,
      identityChange,
      ops: input.ops,
    })
    const createdAt = input.createdAt ?? Date.now()
    assertNonNegativeIntegerV2(createdAt, 'createdAt')
    const opsJson = canonicalStringifyV2(input.ops)
    const identityChangeJson = identityChange === null ? null : canonicalStringifyV2(identityChange)
    const diffSummaryJson = canonicalStringifyV2(summarizeTreeDiffOpsV2(input.ops))

    const commit = this.authority.database.transaction(() => {
      const cas = this.authority.database
        .prepare(
          `UPDATE memory_meta
           SET integer_value = ?, updated_at = ?
           WHERE key = 'tree_version' AND integer_value = ?`
        )
        .run(version, createdAt, input.expectedBaseVersion)
      if (cas.changes !== 1) {
        throw new AppError('CONFLICT', '树版本 CAS 在事务提交点失败。')
      }
      const frontier = this.authority.database
        .prepare(
          `UPDATE memory_meta
           SET integer_value = MAX(integer_value, ?), updated_at = ?
           WHERE key = 'dream_frontier'`
        )
        .run(input.frontierEvidenceSequence, createdAt)
      if (frontier.changes !== 1) {
        throw new AppError('INVARIANT', 'dream_frontier meta 缺失。')
      }
      input.authorityCommit?.apply()
      assertReferencedBlobsExistV2(this.authority.database, next.nodes)
      this.authority.database
        .prepare(
          `INSERT INTO memory_tree_snapshots(
             version, root_node_id, active_identity_epoch_id, global_mainline_node_id,
             frontier_evidence_sequence, created_by_run_id, tree_hash,
             event_head_hash, diff_summary_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          version,
          root.stableKey,
          input.activeIdentityEpochId,
          input.globalMainlineNodeId,
          input.frontierEvidenceSequence,
          input.createdByRunId,
          next.stateHash,
          eventHash,
          diffSummaryJson,
          createdAt
        )
      input.authorityCommit?.applyAfterSnapshot?.()
      this.authority.database
        .prepare(
          `INSERT INTO memory_tree_diffs(
             version, base_version, ops_json, identity_change_json, op_count,
             previous_event_hash, event_hash, created_by_run_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          version,
          input.expectedBaseVersion,
          opsJson,
          identityChangeJson,
          input.ops.length,
          this.eventHead,
          eventHash,
          input.createdByRunId,
          createdAt
        )
      if (input.dreamRunCommit) {
        commitDreamRunRowV2(
          this.authority.database,
          input.dreamRunCommit,
          input.expectedBaseVersion,
          version,
          input.frontierEvidenceSequence,
          createdAt
        )
      }
    })
    commit()

    this.currentVersion = version
    this.eventHead = eventHash
    this.currentReplay = next
    if (version % MemoryTreeCheckpointIntervalV2 === 0) {
      this.checkpoints.push({ version, replay: next })
    }
    let projectionPersisted = true
    try {
      this.projectionIndex.persist(version, next, this.checkpoints)
    } catch {
      projectionPersisted = false
    }
    return {
      version,
      treeHash: next.stateHash,
      eventHash,
      projectionPersisted,
    }
  }

  /**
   * 一批 Evidence 被完整考虑但没有产生树事件时，树 head 保持不变；frontier 与 run
   * 仍在同一事务推进。这个动词是 I1 对“零候选/全拒绝”批次的显式落点。
   */
  public commitDreamNoop(input: CommitMemoryDreamNoopInputV2): void {
    if (input.expectedTreeVersion !== this.currentVersion) {
      throw new AppError('CONFLICT', 'Dream no-op 树版本 CAS 失败。', undefined, {
        expectedTreeVersion: input.expectedTreeVersion,
        currentVersion: this.currentVersion,
      })
    }
    assertNonNegativeIntegerV2(input.frontierEvidenceSequence, 'frontierEvidenceSequence')
    assertFrontierAdvanceIsValidV2(this.authority.database, input.frontierEvidenceSequence)
    validateDreamRunCommitV2(input.dreamRunCommit, input.dreamRunCommit.runId)
    const committedAt = input.committedAt ?? Date.now()
    assertNonNegativeIntegerV2(committedAt, 'committedAt')
    const commit = this.authority.database.transaction(() => {
      const treeVersion = readMemoryMetaV2(this.authority.database, 'tree_version')
      if (treeVersion !== input.expectedTreeVersion) {
        throw new AppError('CONFLICT', 'Dream no-op 在事务提交点树版本 CAS 失败。')
      }
      const frontier = this.authority.database
        .prepare(
          `UPDATE memory_meta
           SET integer_value = MAX(integer_value, ?), updated_at = ?
           WHERE key = 'dream_frontier'`
        )
        .run(input.frontierEvidenceSequence, committedAt)
      if (frontier.changes !== 1) {
        throw new AppError('INVARIANT', 'dream_frontier meta 缺失。')
      }
      input.authorityCommit?.apply()
      commitDreamRunRowV2(
        this.authority.database,
        input.dreamRunCommit,
        input.expectedTreeVersion,
        input.expectedTreeVersion,
        input.frontierEvidenceSequence,
        committedAt
      )
    })
    commit()
  }

  /**
   * 只允许在当前 head 建基点，因此不需要改写尚存后继 diff 的 event_hash。
   * 细粒度 diff 删除、snapshot 收窄与 base_event_hash 切换在同一 authority 事务完成。
   */
  public compactHead(input: CompactMemoryTreeHeadInputV2): CompactMemoryTreeHeadResultV2 {
    assertNonEmptyV2(input.compactionId, 'compactionId')
    if (this.currentVersion < 1) {
      throw new AppError('VALIDATION', '空树没有可压缩的历史。')
    }
    assertForwardReplayResultForPersistenceV2(this.currentReplay)
    const duplicate = this.authority.database
      .prepare(
        `SELECT 1 AS present
         FROM memory_tree_bases
         WHERE base_version = ?`
      )
      .get(this.currentVersion)
    if (duplicate) {
      throw new AppError('CONFLICT', '当前树版本已经是物化基点。')
    }
    const createdAt = input.createdAt ?? Date.now()
    assertNonNegativeIntegerV2(createdAt, 'createdAt')
    const state = buildMemoryTreeBaseStateV2(this.currentVersion, this.currentReplay.nodes)
    const hashes = computeMemoryTreeBaseHashesV2(state, this.eventHead)
    if (hashes.treeHash !== this.currentReplay.stateHash) {
      throw new AppError('INVARIANT', '物化基点 tree_hash 与当前权威树失配。')
    }

    const stateBytes = Buffer.from(canonicalStringifyV2(state), 'utf8')
    const sealed = this.contentKeys.sealContent(stateBytes)
    stateBytes.fill(0)
    let committed = false
    try {
      const deletedDiffCount = (
        this.authority.database
          .prepare(
            `SELECT count(*) AS count
             FROM memory_tree_diffs
             WHERE version <= ?`
          )
          .get(this.currentVersion) as { count: number }
      ).count
      const compact = this.authority.database.transaction(() => {
        this.authority.database
          .prepare(
            `INSERT INTO memory_content_blobs(
               blob_id, byte_length, state, created_at
             ) VALUES (?, ?, 'active', ?)`
          )
          .run(sealed.blobId, sealed.byteLength, createdAt)
        this.authority.database
          .prepare(
            `INSERT INTO memory_tree_bases(
               base_version, state_blob_ref, state_commitment, tree_hash,
               compacted_from_version, compacted_to_version,
               prior_segment_event_head, base_event_hash, canonical_version,
               compaction_version, manifest_hash, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            this.currentVersion,
            sealed.blobId,
            sealed.commitment,
            hashes.treeHash,
            this.baseVersion + 1,
            this.currentVersion,
            this.eventHead,
            hashes.baseEventHash,
            2,
            1,
            hashes.manifestHash,
            createdAt
          )
        this.authority.database
          .prepare(
            `INSERT INTO memory_tree_compactions(
               id, base_version, source_from_version, source_to_version,
               deleted_diff_count, validation_before, validation_after, created_at
             ) VALUES (?, ?, ?, ?, ?, 'passed', 'passed', ?)`
          )
          .run(
            input.compactionId,
            this.currentVersion,
            this.baseVersion + 1,
            this.currentVersion,
            deletedDiffCount,
            createdAt
          )
        this.authority.database
          .prepare(`DELETE FROM memory_tree_diffs WHERE version <= ?`)
          .run(this.currentVersion)
        this.authority.database
          .prepare(`DELETE FROM memory_tree_snapshots WHERE version < ?`)
          .run(this.currentVersion)
        const anchor = this.authority.database
          .prepare(
            `UPDATE memory_tree_snapshots
             SET event_head_hash = ?
             WHERE version = ? AND tree_hash = ?`
          )
          .run(hashes.baseEventHash, this.currentVersion, hashes.treeHash)
        if (anchor.changes !== 1) {
          throw new AppError('INVARIANT', '物化基点无法重写 head snapshot 锚点。')
        }
      })
      compact()
      committed = true
      this.baseVersion = this.currentVersion
      this.eventHead = hashes.baseEventHash
      this.checkpoints = this.checkpoints.filter(
        (checkpoint) => checkpoint.version >= this.baseVersion
      )
      return {
        baseVersion: this.baseVersion,
        baseEventHash: hashes.baseEventHash,
        manifestHash: hashes.manifestHash,
        deletedDiffCount,
      }
    } finally {
      if (!committed) this.contentKeys.eraseContent(sealed.blobId)
    }
  }
}

function reconstructTreeFromAuthorityV2(
  database: SQLiteDatabase,
  contentKeys: ContentKeyServiceV2
): ReconstructedTreeV2 {
  const base = database
    .prepare(
      `SELECT *
       FROM memory_tree_bases
       ORDER BY base_version DESC
       LIMIT 1`
    )
    .get() as MemoryTreeBaseRowV2 | undefined
  let baseVersion = 0
  let eventHead = TreeDiffGenesisEventHashV2
  let current = replayTreeDiffsForwardV2([], [])
  if (base) {
    const plaintext = contentKeys.openContent(base.state_blob_ref, base.state_commitment)
    try {
      const state = parseMemoryTreeBaseStateV2(plaintext)
      const hashes = computeMemoryTreeBaseHashesV2(state, base.prior_segment_event_head)
      if (
        state.baseVersion !== base.base_version ||
        hashes.treeHash !== base.tree_hash ||
        hashes.manifestHash !== base.manifest_hash ||
        hashes.baseEventHash !== base.base_event_hash ||
        base.canonical_version !== 2 ||
        base.compaction_version !== 1
      ) {
        throw new AppError('INVARIANT', '物化基点行、state blob 与哈希锚点不一致。')
      }
      baseVersion = base.base_version
      eventHead = base.base_event_hash
      current = replayTreeDiffsForwardV2(
        [],
        [
          {
            version: state.baseVersion,
            baseVersion: 0,
            ops: state.nodes.map((node) => ({
              type: 'add',
              before: [],
              after: [node],
            })),
          },
        ]
      )
      validateCommittedTreeStateV2(current.nodes)
    } finally {
      plaintext.fill(0)
    }
  }

  const rows = database
    .prepare(
      `SELECT *
       FROM memory_tree_diffs
       WHERE version > ?
       ORDER BY version`
    )
    .all(baseVersion) as MemoryTreeDiffRowV2[]
  const checkpoints: MemoryTreeCheckpointV2[] = []
  let version = baseVersion
  for (const row of rows) {
    const parsed = parseMemoryTreeDiffRowV2(row)
    if (
      parsed.baseVersion !== version ||
      row.previous_event_hash !== eventHead ||
      row.op_count !== parsed.ops.length
    ) {
      throw new AppError('INVARIANT', 'TreeDiff v2 authority 链断裂或 op_count 失配。', undefined, {
        version: row.version,
      })
    }
    const expectedEventHash = hashTreeEventV2({
      previousEventHash: eventHead,
      version: row.version,
      baseVersion: row.base_version,
      identityChange: parseIdentityChangeJsonV2(row.identity_change_json),
      ops: parsed.ops,
    })
    if (expectedEventHash !== row.event_hash) {
      throw new AppError('INVARIANT', 'TreeDiff v2 event_hash 自检失败。', undefined, {
        version: row.version,
      })
    }
    current = replayTreeDiffsForwardV2(current.nodes, [parsed], {
      persistenceBase: current,
    })
    validateCommittedTreeStateV2(current.nodes)
    const snapshot = database
      .prepare(`SELECT * FROM memory_tree_snapshots WHERE version = ?`)
      .get(row.version) as MemoryTreeSnapshotRowV2 | undefined
    if (
      !snapshot ||
      snapshot.tree_hash !== current.stateHash ||
      snapshot.event_head_hash !== row.event_hash ||
      snapshot.root_node_id !== current.nodes.find((node) => node.parentKey === null)?.stableKey ||
      !current.nodes.some((node) => node.stableKey === snapshot.global_mainline_node_id) ||
      snapshot.created_by_run_id !== row.created_by_run_id ||
      snapshot.created_at !== row.created_at ||
      snapshot.diff_summary_json !== canonicalStringifyV2(summarizeTreeDiffOpsV2(parsed.ops))
    ) {
      throw new AppError('INVARIANT', 'TreeDiff v2 snapshot 双锚点失配。', undefined, {
        version: row.version,
      })
    }
    version = row.version
    eventHead = row.event_hash
    if (version % MemoryTreeCheckpointIntervalV2 === 0) {
      checkpoints.push({ version, replay: current })
    }
  }

  const metaVersion = (
    database.prepare(`SELECT integer_value FROM memory_meta WHERE key = 'tree_version'`).get() as
      { integer_value: number } | undefined
  )?.integer_value
  if (metaVersion !== version) {
    throw new AppError('INVARIANT', 'tree_version meta 与 authority 链 head 不一致。', undefined, {
      metaVersion,
      replayedVersion: version,
    })
  }
  if (version > 0 && rows.length === 0) {
    const snapshot = database
      .prepare(`SELECT * FROM memory_tree_snapshots WHERE version = ?`)
      .get(version) as MemoryTreeSnapshotRowV2 | undefined
    if (
      !snapshot ||
      snapshot.tree_hash !== current.stateHash ||
      snapshot.event_head_hash !== eventHead
    ) {
      throw new AppError('INVARIANT', '物化基点 head snapshot 锚点失配。')
    }
  }
  return {
    version,
    baseVersion,
    eventHead,
    current,
    checkpoints,
    replayedDiffCount: rows.length,
  }
}

function parseMemoryTreeDiffRowV2(row: MemoryTreeDiffRowV2): MemoryTreeDiffV2 {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.ops_json)
  } catch (error) {
    throw new AppError('INVARIANT', 'TreeDiff v2 ops_json 无法解析。', error, {
      version: row.version,
    })
  }
  if (!Array.isArray(parsed) || !parsed.every(isMemoryTreeDiffOpV2)) {
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

function parseIdentityChangeJsonV2(raw: string | null): MemoryTreeIdentityChangeV2 | null {
  if (raw === null) return null
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

function validateIdentityChangeV2(change: MemoryTreeIdentityChangeV2): void {
  if (!isIdentityChangeV2(change)) {
    throw new AppError('VALIDATION', 'identityChange 不符合严格结构。')
  }
}

function isIdentityChangeV2(value: unknown): value is MemoryTreeIdentityChangeV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return (
    keys.length === 3 &&
    keys[0] === 'epochId' &&
    keys[1] === 'predecessorId' &&
    keys[2] === 'sequence' &&
    typeof record.epochId === 'string' &&
    record.epochId.length > 0 &&
    Number.isSafeInteger(record.sequence) &&
    (record.sequence as number) > 0 &&
    (record.predecessorId === null ||
      (typeof record.predecessorId === 'string' && record.predecessorId.length > 0))
  )
}

function validateCommittedTreeStateV2(nodes: readonly MemoryTreeNodeStructV2[]): void {
  if (nodes.length === 0) {
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
      (node.content.redacted && node.content.blobRef !== null)
    ) {
      throw new AppError('VALIDATION', '树节点 redact 状态位与内容引用不一致。')
    }
    byKey.set(node.stableKey, node)
  }
  const roots = nodes.filter((node) => node.parentKey === null)
  if (roots.length !== 1 || roots[0]?.stableKey !== 'root' || roots[0].nodeType !== 'root') {
    throw new AppError('VALIDATION', '已提交树必须且只能有一个 stableKey=root 的根节点。')
  }
  for (const node of nodes) {
    if (node.parentKey !== null && !byKey.has(node.parentKey)) {
      throw new AppError('VALIDATION', '树节点引用了不存在的父节点。', undefined, {
        stableKey: node.stableKey,
        parentKey: node.parentKey,
      })
    }
    const visited = new Set<string>()
    let cursor: MemoryTreeNodeStructV2 | undefined = node
    while (cursor && cursor.parentKey !== null) {
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

function assertReferencedBlobsExistV2(
  database: SQLiteDatabase,
  nodes: readonly MemoryTreeNodeStructV2[]
): void {
  const blobRefs = [
    ...new Set(
      nodes.flatMap((node) => (node.content.blobRef === null ? [] : [node.content.blobRef]))
    ),
  ]
  const lookup = database.prepare(`SELECT state FROM memory_content_blobs WHERE blob_id = ?`)
  for (const blobRef of blobRefs) {
    const row = lookup.get(blobRef) as { state: string } | undefined
    if (!row || row.state !== 'active') {
      throw new AppError('VALIDATION', '树节点引用了缺失或已擦除的内容 blob。', undefined, {
        blobRef,
      })
    }
  }
}

function summarizeTreeDiffOpsV2(ops: readonly MemoryTreeDiffOpV2[]): Record<string, number> {
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

function assertNonEmptyV2(value: string, field: string): void {
  if (!value) {
    throw new AppError('VALIDATION', `${field} 不得为空。`)
  }
}

function assertNonNegativeIntegerV2(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError('VALIDATION', `${field} 必须是非负安全整数。`)
  }
}

function assertFrontierAdvanceIsValidV2(
  database: SQLiteDatabase,
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

function readMemoryMetaV2(database: SQLiteDatabase, key: string): number {
  const row = database
    .prepare(`SELECT integer_value FROM memory_meta WHERE key = ?`)
    .get(key) as { integer_value: number } | undefined
  if (!row) throw new AppError('INVARIANT', `memory_meta 缺少 ${key}。`)
  return row.integer_value
}

function validateDreamRunCommitV2(
  commit: MemoryDreamRunCommitV2,
  createdByRunId: string
): void {
  assertNonEmptyV2(commit.runId, 'dreamRunCommit.runId')
  if (commit.runId !== createdByRunId) {
    throw new AppError('VALIDATION', 'Dream run id 必须与 tree createdByRunId 一致。')
  }
  if (!/^f2:[0-9a-f]{64}$/.test(commit.inputFingerprint)) {
    throw new AppError('VALIDATION', 'Dream input fingerprint 形态非法。')
  }
  assertNonNegativeIntegerV2(commit.frontierBefore, 'dreamRunCommit.frontierBefore')
  assertNonNegativeIntegerV2(commit.tokenUsage, 'dreamRunCommit.tokenUsage')
  assertNonNegativeIntegerV2(commit.candidateCount, 'dreamRunCommit.candidateCount')
  assertNonNegativeIntegerV2(commit.acceptedCount, 'dreamRunCommit.acceptedCount')
  assertNonNegativeIntegerV2(commit.rejectedCount, 'dreamRunCommit.rejectedCount')
  if (commit.acceptedCount + commit.rejectedCount !== commit.candidateCount) {
    throw new AppError('VALIDATION', 'Dream 候选接受/拒绝计数与总数不一致。')
  }
  if (commit.finishedAt !== undefined) {
    assertNonNegativeIntegerV2(commit.finishedAt, 'dreamRunCommit.finishedAt')
  }
}

function commitDreamRunRowV2(
  database: SQLiteDatabase,
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
