import { AppError, isEmpty, isNull, isTrue, toNullable } from '@velaros-ai/core'

import type { MemoryTreeDiffV2, MemoryTreeReplayResultV2 } from '../../types/tree-v2/diff'
import type {
  CommitMemoryDreamNoopInputV2,
  CommitMemoryTreeVersionInputV2,
  CommitMemoryTreeVersionResultV2,
  CompactMemoryTreeHeadInputV2,
  CompactMemoryTreeHeadResultV2,
  MemoryCountRowV2,
  MemoryTreeBaseRowV2,
  MemoryTreeCheckpointV2,
  MemoryTreeDiffRowV2,
  MemoryTreeProjectionInspectionV2,
  MemoryTreeSnapshotRowV2,
  MemoryTreeStoreOpenReportV2,
  ReconstructedTreeV2,
} from '../../types/tree-v2/store'
import {
  assertNonEmptyStringV2,
  assertNonNegativeSafeIntegerV2,
} from '../../utils/tree-v2/checks'
import {
  canonicalStringifyV2,
  hashTreeEventV2,
  TreeDiffGenesisEventHashV2,
  validateTreeDiffOpV2,
} from '../../utils/tree-v2/diff-chain'
import {
  buildMemoryTreeBaseStateV2,
  computeMemoryTreeBaseHashesV2,
  parseMemoryTreeBaseStateV2,
} from '../../utils/tree-v2/tree-manifest'
import {
  assertFrontierAdvanceIsValidV2,
  assertReferencedBlobsExistV2,
  assertSnapshotAnchorsV2,
  commitDreamRunRowV2,
  parseIdentityChangeJsonV2,
  parseMemoryTreeDiffRowV2,
  readMemoryMetaV2,
  summarizeTreeDiffOpsV2,
  validateCommittedTreeStateV2,
  validateDreamRunCommitV2,
  validateIdentityChangeV2,
} from '../../utils/tree-v2/tree-store'
import { MemoryTuning } from '../../utils/tuning'

import type { ContentKeyServiceV2Api } from './storage/ContentKeyServiceV2'
import type { MemoryKeyringStoreV2Api } from './storage/MemoryKeyringStoreV2'
import type { MemoryAuthorityDatabaseV2Api } from './MemoryAuthorityDatabaseV2'
import { MemoryTreeProjectionIndexV2 } from './MemoryTreeProjectionIndexV2'
import { MemoryTreeReplayV2 } from './MemoryTreeReplayV2'

/**
 * 记忆树 v2 的 snapshot / diff / base 权威 owner：构造即从权威链重建出当前树。
 *
 * 所有写入先在内存正向应用并校验，再以 SQLite 单事务提交 snapshot + diff + meta CAS；
 * 派生投影只在权威提交成功后刷新，刷新失败只降级不回滚，绝不反向污染权威提交。
 * 实例归 `MemorySystemRuntimeV2`（或探针）所有，与一条权威连接一一对应。
 */
export interface MemoryTreeStoreV2Api {
  /** 构造时那一次从权威链重建的读数：树版本、基点、重放条数、检查点数、投影有没有被重建。 */
  readonly openReport: MemoryTreeStoreOpenReportV2
  /** 当前树版本；空树是 0。 */
  readonly version: number
  /** 当前树的一份深拷贝，改它不影响内部状态。 */
  readonly current: MemoryTreeReplayResultV2
  /** 核对派生投影与权威链是否一致；空树或一代都没有时返回 null。 */
  inspectProjection(): Nullable<MemoryTreeProjectionInspectionV2>
  /** 强制按当前权威状态重建一代派生投影，返回新代号；空树返回 null。 */
  rebuildProjection(): Nullable<number>
  /**
   * 提交一个新树版本：校验 → 内存正向重放 → 单事务写 meta CAS、snapshot、diff、整理运行。
   * 基线过期或事务内 CAS 失败抛 CONFLICT，入参或提交后树形不合法抛 VALIDATION。
   */
  commitVersion(input: CommitMemoryTreeVersionInputV2): CommitMemoryTreeVersionResultV2
  /**
   * 一批证据被完整消化但没产生树事件：树 head 不动，frontier 与整理运行在同一事务推进。
   * 树版本 CAS 失败抛 CONFLICT。
   */
  commitDreamNoop(input: CommitMemoryDreamNoopInputV2): void
  /**
   * 在当前 head 建物化基点：封存状态 blob、写基点与压缩账本、删掉被吃掉的 diff 与旧 snapshot。
   * 空树抛 VALIDATION，当前版本已是基点抛 CONFLICT；事务没提交成功会把刚封的 blob 擦掉。
   */
  compactHead(input: CompactMemoryTreeHeadInputV2): CompactMemoryTreeHeadResultV2
}

export class MemoryTreeStoreV2 implements MemoryTreeStoreV2Api {
  /** 物化基点写入时记的 canonical 序列化规范版本。 */
  private static readonly CanonicalVersion = 2

  /** 物化基点写入时记的压缩协议版本。 */
  private static readonly CompactionVersion = 1

  public readonly openReport: MemoryTreeStoreOpenReportV2

  private readonly projectionIndex: MemoryTreeProjectionIndexV2
  private readonly replay = new MemoryTreeReplayV2()
  private currentVersion: number
  private baseVersion: number
  private eventHead: string
  private currentReplay: MemoryTreeReplayResultV2
  private checkpoints: MemoryTreeCheckpointV2[]

  constructor(
    private readonly authority: MemoryAuthorityDatabaseV2Api,
    private readonly contentKeys: ContentKeyServiceV2Api,
    keyring: MemoryKeyringStoreV2Api
  ) {
    const reconstructed = this.reconstructFromAuthority()
    this.projectionIndex = new MemoryTreeProjectionIndexV2(
      authority.roots.indexDir,
      keyring,
      this.replay
    )
    this.currentVersion = reconstructed.version
    this.baseVersion = reconstructed.baseVersion
    this.eventHead = reconstructed.eventHead
    this.currentReplay = reconstructed.current
    this.checkpoints = [...reconstructed.checkpoints]

    let projectionRebuilt = false
    if (reconstructed.version > 0 && !this.projectionMatchesAuthority(reconstructed)) {
      this.projectionIndex.persist(
        reconstructed.version,
        reconstructed.current,
        reconstructed.checkpoints
      )
      projectionRebuilt = true
    }
    this.openReport = {
      treeVersion: reconstructed.version,
      baseVersion: reconstructed.baseVersion,
      replayedDiffCount: reconstructed.replayedDiffCount,
      checkpointCount: reconstructed.checkpoints.length,
      projectionRebuilt,
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

  public inspectProjection(): Nullable<MemoryTreeProjectionInspectionV2> {
    if (this.currentVersion < 1) return null
    return this.projectionIndex.inspect(this.currentVersion, this.currentReplay)
  }

  public rebuildProjection(): Nullable<number> {
    if (this.currentVersion < 1) return null
    return this.projectionIndex.persist(this.currentVersion, this.currentReplay, this.checkpoints)
  }

  public commitVersion(input: CommitMemoryTreeVersionInputV2): CommitMemoryTreeVersionResultV2 {
    if (input.expectedBaseVersion !== this.currentVersion) {
      throw new AppError('CONFLICT', '树版本 CAS 失败：提交基线已过期。', undefined, {
        expectedBaseVersion: input.expectedBaseVersion,
        currentVersion: this.currentVersion,
      })
    }
    this.validateCommitInput(input)

    const version = this.currentVersion + 1
    const diff: MemoryTreeDiffV2 = {
      version,
      baseVersion: this.currentVersion,
      ops: input.ops,
    }
    const next = this.replay.replayForward(this.currentReplay.nodes, [diff], {
      persistenceBase: this.currentReplay,
    })
    validateCommittedTreeStateV2(next.nodes)
    const root = next.nodes.find((node) => isNull(node.parentKey))
    if (!root) throw new AppError('INVARIANT', '提交后树缺少根节点。')
    if (!next.nodes.some((node) => node.stableKey === input.globalMainlineNodeId)) {
      throw new AppError('VALIDATION', 'globalMainlineNodeId 不在提交后树状态中。')
    }

    const identityChange = toNullable(input.identityChange)
    const eventHash = hashTreeEventV2({
      previousEventHash: this.eventHead,
      version,
      baseVersion: this.currentVersion,
      identityChange,
      ops: input.ops,
    })
    const createdAt = input.createdAt ?? Date.now()
    assertNonNegativeSafeIntegerV2(createdAt, 'createdAt')
    const opsJson = canonicalStringifyV2(input.ops)
    const identityChangeJson = isNull(identityChange) ? null : canonicalStringifyV2(identityChange)
    const diffSummaryJson = canonicalStringifyV2(summarizeTreeDiffOpsV2(input.ops))

    const database = this.authority.database
    const commit = database.transaction(() => {
      const cas = database
        .prepare(
          `UPDATE memory_meta
           SET integer_value = ?, updated_at = ?
           WHERE key = 'tree_version' AND integer_value = ?`
        )
        .run(version, createdAt, input.expectedBaseVersion)
      if (cas.changes !== 1) {
        throw new AppError('CONFLICT', '树版本 CAS 在事务提交点失败。')
      }
      const frontier = database
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
      assertReferencedBlobsExistV2(database, next.nodes)
      database
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
      database
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
          database,
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
    if (version % MemoryTuning.treeV2.checkpointInterval === 0) {
      this.checkpoints.push({ version, replay: next })
    }
    let projectionPersisted = true
    try {
      this.projectionIndex.persist(version, next, this.checkpoints)
    } catch {
      // arch-guard:silent-catch-ok projection 是可重建派生物；返回 false 让调用方得到明确降级状态。
      projectionPersisted = false
    }
    return {
      version,
      treeHash: next.stateHash,
      eventHash,
      projectionPersisted,
    }
  }

  public commitDreamNoop(input: CommitMemoryDreamNoopInputV2): void {
    if (input.expectedTreeVersion !== this.currentVersion) {
      throw new AppError('CONFLICT', 'Dream no-op 树版本 CAS 失败。', undefined, {
        expectedTreeVersion: input.expectedTreeVersion,
        currentVersion: this.currentVersion,
      })
    }
    const database = this.authority.database
    assertNonNegativeSafeIntegerV2(input.frontierEvidenceSequence, 'frontierEvidenceSequence')
    assertFrontierAdvanceIsValidV2(database, input.frontierEvidenceSequence)
    validateDreamRunCommitV2(input.dreamRunCommit, input.dreamRunCommit.runId)
    const committedAt = input.committedAt ?? Date.now()
    assertNonNegativeSafeIntegerV2(committedAt, 'committedAt')
    const commit = database.transaction(() => {
      const treeVersion = readMemoryMetaV2(database, 'tree_version')
      if (treeVersion !== input.expectedTreeVersion) {
        throw new AppError('CONFLICT', 'Dream no-op 在事务提交点树版本 CAS 失败。')
      }
      const frontier = database
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
        database,
        input.dreamRunCommit,
        input.expectedTreeVersion,
        input.expectedTreeVersion,
        input.frontierEvidenceSequence,
        committedAt
      )
    })
    commit()
  }

  public compactHead(input: CompactMemoryTreeHeadInputV2): CompactMemoryTreeHeadResultV2 {
    assertNonEmptyStringV2(input.compactionId, 'compactionId')
    if (this.currentVersion < 1) {
      throw new AppError('VALIDATION', '空树没有可压缩的历史。')
    }
    this.replay.assertForwardResultForPersistence(this.currentReplay)
    const database = this.authority.database
    const duplicate = database
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
    assertNonNegativeSafeIntegerV2(createdAt, 'createdAt')
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
        database
          .prepare(
            `SELECT count(*) AS count
             FROM memory_tree_diffs
             WHERE version <= ?`
          )
          .get(this.currentVersion) as MemoryCountRowV2
      ).count
      const compact = database.transaction(() => {
        database
          .prepare(
            `INSERT INTO memory_content_blobs(
               blob_id, byte_length, state, created_at
             ) VALUES (?, ?, 'active', ?)`
          )
          .run(sealed.blobId, sealed.byteLength, createdAt)
        database
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
            MemoryTreeStoreV2.CanonicalVersion,
            MemoryTreeStoreV2.CompactionVersion,
            hashes.manifestHash,
            createdAt
          )
        database
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
        database.prepare(`DELETE FROM memory_tree_diffs WHERE version <= ?`).run(this.currentVersion)
        database
          .prepare(`DELETE FROM memory_tree_snapshots WHERE version < ?`)
          .run(this.currentVersion)
        const anchor = database
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

  /** 提交前的入参自检：空变更、Erasure 版本的事件白名单、各字段形态与 frontier 推进。 */
  private validateCommitInput(input: CommitMemoryTreeVersionInputV2): void {
    if (isEmpty(input.ops) && !input.identityChange && !input.erasureCommit) {
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
    assertNonEmptyStringV2(input.activeIdentityEpochId, 'activeIdentityEpochId')
    assertNonEmptyStringV2(input.globalMainlineNodeId, 'globalMainlineNodeId')
    assertNonEmptyStringV2(input.createdByRunId, 'createdByRunId')
    assertNonNegativeSafeIntegerV2(input.frontierEvidenceSequence, 'frontierEvidenceSequence')
    assertFrontierAdvanceIsValidV2(this.authority.database, input.frontierEvidenceSequence)
    if (input.dreamRunCommit) {
      validateDreamRunCommitV2(input.dreamRunCommit, input.createdByRunId)
    }
    if (input.identityChange) validateIdentityChangeV2(input.identityChange)
    if (input.identityChange && input.identityChange.epochId !== input.activeIdentityEpochId) {
      throw new AppError('VALIDATION', 'identityChange epochId 必须与 activeIdentityEpochId 一致。')
    }
    for (const op of input.ops) validateTreeDiffOpV2(op)
  }

  /** 派生投影是不是和刚重建出来的权威状态一致；解析失败等价于不一致。 */
  private projectionMatchesAuthority(reconstructed: ReconstructedTreeV2): boolean {
    try {
      return isTrue(
        this.projectionIndex.inspect(reconstructed.version, reconstructed.current)
          ?.matchesAuthority
      )
    } catch {
      // arch-guard:silent-catch-ok 派生投影损坏等价于不匹配，调用方会从 authority 立即重建。
      return false
    }
  }

  /**
   * 从权威链重建当前树：先解物化基点，再逐条重放 diff，逐版核对事件哈希与 snapshot 双锚点。
   * 任何一处对不上都抛 INVARIANT——重放本身就是权威库的完整性自检。
   */
  private reconstructFromAuthority(): ReconstructedTreeV2 {
    const database = this.authority.database
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
    let current = this.replay.replayForward([], [])
    if (base) {
      current = this.replayMaterializedBase(base)
      baseVersion = base.base_version
      eventHead = base.base_event_hash
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
      current = this.replay.replayForward(current.nodes, [parsed], {
        persistenceBase: current,
      })
      validateCommittedTreeStateV2(current.nodes)
      assertSnapshotAnchorsV2(database, row, parsed.ops, current)
      version = row.version
      eventHead = row.event_hash
      if (version % MemoryTuning.treeV2.checkpointInterval === 0) {
        checkpoints.push({ version, replay: current })
      }
    }

    const metaVersion = readMemoryMetaV2(database, 'tree_version')
    if (metaVersion !== version) {
      throw new AppError('INVARIANT', 'tree_version meta 与 authority 链 head 不一致。', undefined, {
        metaVersion,
        replayedVersion: version,
      })
    }
    if (version > 0 && isEmpty(rows)) {
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

  /** 解开物化基点的状态 blob，核对四个哈希锚点，再把它重放成起点状态。 */
  private replayMaterializedBase(base: MemoryTreeBaseRowV2): MemoryTreeReplayResultV2 {
    const plaintext = this.contentKeys.openContent(base.state_blob_ref, base.state_commitment)
    try {
      const state = parseMemoryTreeBaseStateV2(plaintext)
      const hashes = computeMemoryTreeBaseHashesV2(state, base.prior_segment_event_head)
      if (
        state.baseVersion !== base.base_version ||
        hashes.treeHash !== base.tree_hash ||
        hashes.manifestHash !== base.manifest_hash ||
        hashes.baseEventHash !== base.base_event_hash ||
        base.canonical_version !== MemoryTreeStoreV2.CanonicalVersion ||
        base.compaction_version !== MemoryTreeStoreV2.CompactionVersion
      ) {
        throw new AppError('INVARIANT', '物化基点行、state blob 与哈希锚点不一致。')
      }
      const replayed = this.replay.replayForward(
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
      validateCommittedTreeStateV2(replayed.nodes)
      return replayed
    } finally {
      plaintext.fill(0)
    }
  }

}
