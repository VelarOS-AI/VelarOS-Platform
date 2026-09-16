import { randomBytes } from 'node:crypto'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  CommitMemoryDreamTreeInputV2,
  MaterializedMemoryDreamEvidenceV2,
  MemoryDreamEvidenceDescriptorV2,
  MemoryDreamEvidenceRowV2,
  MemoryDreamRunRowV2,
  MemoryDreamValidationStatsV2,
  StartMemoryDreamBatchInputV2,
  StartMemoryDreamRunResultV2,
} from '../../types/tree-v2/dream'
import type {
  CommitMemoryTreeVersionResultV2,
  MemoryTreeAuthorityCommitParticipantV2,
} from '../../types/tree-v2/store'
import {
  assertNonEmptyStringV2,
  assertNonNegativeSafeIntegerV2,
  assertPositiveSafeIntegerV2,
  registerMemoryContentBlobV2,
} from '../../utils/tree-v2/checks'
import { canonicalStringifyV2 } from '../../utils/tree-v2/diff-chain'
import { mapDreamEvidenceV2, validateDreamStatsV2 } from '../../utils/tree-v2/dream-runs'
import { computeDreamInputFingerprintV2 } from '../../utils/tree-v2/identity-keys'
import { readMemoryMetaV2 } from '../../utils/tree-v2/tree-store'

import type { ContentKeyServiceV2Api } from './storage/ContentKeyServiceV2'
import type { MemoryAuthorityDatabaseV2Api } from './MemoryAuthorityDatabaseV2'
import type { MemoryTreeStoreV2Api } from './MemoryTreeStoreV2'

/**
 * 整理运行的账本与事务编排：开批次、封候选账本、把结果提交成树版本或空提交。
 *
 * 模型推理仍由上层注入；这个类只拥有批次边界、状态机与提交时机。
 * 实例归 `MemorySystemRuntimeV2`（或探针）所有，与一条权威连接、一份树存储成组。
 */
export interface MemoryDreamRunCoordinatorV2Api {
  /**
   * 按 frontier 之后的到达序开一个批次；没有新证据返回 null，同输入已提交过返回 skipped。
   * 到达序有空洞抛 INVARIANT，同输入已有在跑的批次抛 CONFLICT。
   */
  startNextBatch(input: StartMemoryDreamBatchInputV2): StartMemoryDreamRunResultV2
  /**
   * 解开一条证据的正文与元数据，交给上层去推理；调用方用完要清零。
   * 非 active 或缺正文的证据抛 VALIDATION。
   */
  materializeEvidence(
    descriptor: MemoryDreamEvidenceDescriptorV2
  ): MaterializedMemoryDreamEvidenceV2
  /**
   * 把候选账本封成密文并把这次运行推进到 validating。
   * 统计不守恒抛 VALIDATION，运行不在 running 抛 CONFLICT（此时刚封的密文会被擦掉）。
   */
  markValidating(runId: string, candidateLedger: unknown, stats: MemoryDreamValidationStatsV2): void
  /**
   * 把这次运行的结构变更提交成新树版本。零结构变更要走 `commitNoop`，从这里进抛 VALIDATION。
   * 运行不在 validating 或统计与账本对不上抛 CONFLICT / VALIDATION。
   */
  commitTree(
    runId: string,
    input: CommitMemoryDreamTreeInputV2
  ): CommitMemoryTreeVersionResultV2
  /**
   * 这一批被完整消化但没产生结构变更：树 head 不动，frontier 与运行一起推进。
   * 运行不在 validating 抛 CONFLICT。
   */
  commitNoop(
    runId: string,
    stats: MemoryDreamValidationStatsV2,
    committedAt?: number,
    authorityCommit?: MemoryTreeAuthorityCommitParticipantV2
  ): void
  /** 把一次运行收口成 failed；不在 running / validating 抛 CONFLICT。 */
  failRun(runId: string, errorCode: string, finishedAt?: number): void
  /**
   * I3：把上次进程留下的孤儿运行统一翻成 failed，返回翻了几条。
   * 只翻运行状态，不碰 frontier、树版本或 diff / snapshot。
   */
  recoverOrphanedRuns(recoveredAt?: number): number
}

export class MemoryDreamRunCoordinatorV2 implements MemoryDreamRunCoordinatorV2Api {
  /**
   * 整理管线的版本号（格式身份）：它进输入指纹，改了就等于换了一条管线，
   * 同样的证据集会重新被整理一遍。
   */
  private static readonly PipelineVersion = 1

  /** 运行 id 的随机字节数（128 位）。 */
  private static readonly RunIdByteLength = 16

  constructor(
    private readonly authority: MemoryAuthorityDatabaseV2Api,
    private readonly contentKeys: ContentKeyServiceV2Api,
    private readonly treeStore: MemoryTreeStoreV2Api,
    private readonly random: (byteLength: number) => Buffer = randomBytes
  ) {}

  public startNextBatch(input: StartMemoryDreamBatchInputV2): StartMemoryDreamRunResultV2 {
    assertNonEmptyStringV2(input.trigger, 'trigger')
    assertPositiveSafeIntegerV2(input.batchSize, 'batchSize')
    const startedAt = input.startedAt ?? Date.now()
    assertNonNegativeSafeIntegerV2(startedAt, 'startedAt')
    const database = this.authority.database
    const frontierBefore = readMemoryMetaV2(database, 'dream_frontier')
    const ingestHead = readMemoryMetaV2(database, 'evidence_ingest_sequence')
    if (ingestHead <= frontierBefore) return null
    const frontierAfter = Math.min(ingestHead, frontierBefore + input.batchSize)
    const evidence = (
      database
        .prepare(
          `SELECT id, ingest_sequence, eligibility_state,
                  payload_blob_ref, payload_commitment,
                  metadata_blob_ref, metadata_commitment
           FROM memory_evidence
           WHERE ingest_sequence > ? AND ingest_sequence <= ?
           ORDER BY ingest_sequence`
        )
        .all(frontierBefore, frontierAfter) as MemoryDreamEvidenceRowV2[]
    ).map(mapDreamEvidenceV2)
    if (evidence.length !== frontierAfter - frontierBefore) {
      throw new AppError('INVARIANT', 'Evidence 到达序前缀出现空洞，Dream 拒绝越过。', undefined, {
        frontierBefore,
        frontierAfter,
        evidenceCount: evidence.length,
      })
    }
    const fingerprint = computeDreamInputFingerprintV2({
      frontierBefore,
      evidenceIds: evidence.map((item) => item.id),
      modelProfile: input.modelProfile,
      pipelineVersion: MemoryDreamRunCoordinatorV2.PipelineVersion,
    })
    const treeVersionBefore = this.treeStore.version
    const existing = database
      .prepare(`SELECT * FROM memory_dream_runs WHERE input_fingerprint = ?`)
      .get(fingerprint) as MemoryDreamRunRowV2 | undefined
    if (existing?.state === 'committed') return {
        kind: 'skipped',
        runId: existing.id,
        inputFingerprint: fingerprint,
        frontierBefore,
        frontierAfter,
        treeVersionBefore,
      }
    if (existing && (existing.state === 'running' || existing.state === 'validating')) {
      throw new AppError('CONFLICT', '同一 Dream input 已有进行中的 run。', undefined, {
        runId: existing.id,
        state: existing.state,
      })
    }

    const runId = existing?.id ?? this.randomId()
    const start = database.transaction(() => {
      if (
        readMemoryMetaV2(database, 'dream_frontier') !== frontierBefore ||
        readMemoryMetaV2(database, 'tree_version') !== treeVersionBefore
      ) {
        throw new AppError('CONFLICT', 'Dream 批次建立时 frontier/tree head 已变化。')
      }
      if (existing) {
        this.restartFailedRun(runId, input, frontierBefore, frontierAfter, treeVersionBefore, startedAt)
        return
      }
      database
        .prepare(
          `INSERT INTO memory_dream_runs(
             id, trigger, state, input_fingerprint,
             frontier_before, frontier_after,
             model_provider, model,
             tree_version_before, tree_version_after,
             started_at
           ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          runId,
          input.trigger,
          fingerprint,
          frontierBefore,
          frontierAfter,
          input.modelProfile.provider,
          input.modelProfile.model,
          treeVersionBefore,
          treeVersionBefore,
          startedAt
        )
    })
    start()
    return {
      kind: 'started',
      runId,
      inputFingerprint: fingerprint,
      frontierBefore,
      frontierAfter,
      treeVersionBefore,
      evidence,
      eligibleEvidence: evidence.filter((item) => item.eligibilityState === 'active'),
    }
  }

  public materializeEvidence(
    descriptor: MemoryDreamEvidenceDescriptorV2
  ): MaterializedMemoryDreamEvidenceV2 {
    if (
      descriptor.eligibilityState !== 'active' ||
      !descriptor.payloadBlobRef ||
      !descriptor.payloadCommitment
    ) {
      throw new AppError('VALIDATION', '只有 active 且有正文的 Evidence 可进入 Dream 推理。')
    }
    const payload = this.contentKeys.openContent(
      descriptor.payloadBlobRef,
      descriptor.payloadCommitment
    )
    try {
      const metadata =
        descriptor.metadataBlobRef && descriptor.metadataCommitment
          ? this.contentKeys.openContent(descriptor.metadataBlobRef, descriptor.metadataCommitment)
          : null
      return { payload, metadata }
    } catch (error) {
      payload.fill(0)
      throw error
    }
  }

  public markValidating(
    runId: string,
    candidateLedger: unknown,
    stats: MemoryDreamValidationStatsV2
  ): void {
    validateDreamStatsV2(stats)
    const database = this.authority.database
    const sealed = this.contentKeys.sealContent(canonicalStringifyV2(candidateLedger))
    let committed = false
    try {
      const mark = database.transaction(() => {
        registerMemoryContentBlobV2(database, sealed, Date.now())
        const result = database
          .prepare(
            `UPDATE memory_dream_runs
             SET state = 'validating',
                 candidate_ledger_blob_ref = ?,
                 candidate_ledger_commitment = ?,
                 token_usage = ?, candidate_count = ?,
                 accepted_count = ?, rejected_count = ?
             WHERE id = ? AND state = 'running'`
          )
          .run(
            sealed.blobId,
            sealed.commitment,
            stats.tokenUsage,
            stats.candidateCount,
            stats.acceptedCount,
            stats.rejectedCount,
            runId
          )
        if (result.changes !== 1) {
          throw new AppError('CONFLICT', 'Dream run 进入 validating 的 CAS 失败。', undefined, {
            runId,
          })
        }
      })
      mark()
      committed = true
    } finally {
      if (!committed) this.contentKeys.eraseContent(sealed.blobId)
    }
  }

  public commitTree(
    runId: string,
    input: CommitMemoryDreamTreeInputV2
  ): CommitMemoryTreeVersionResultV2 {
    validateDreamStatsV2(input)
    if (isEmpty(input.ops) && !input.identityChange) {
      throw new AppError('VALIDATION', '零结构变更批次必须使用 commitNoop。')
    }
    const row = this.readValidatingRun(runId, input)
    return this.treeStore.commitVersion({
      expectedBaseVersion: row.tree_version_before,
      ops: input.ops,
      identityChange: input.identityChange,
      activeIdentityEpochId: input.activeIdentityEpochId,
      globalMainlineNodeId: input.globalMainlineNodeId,
      frontierEvidenceSequence: row.frontier_after,
      createdByRunId: row.id,
      createdAt: input.committedAt,
      authorityCommit: input.authorityCommit,
      dreamRunCommit: {
        runId: row.id,
        inputFingerprint: row.input_fingerprint,
        frontierBefore: row.frontier_before,
        tokenUsage: input.tokenUsage,
        candidateCount: input.candidateCount,
        acceptedCount: input.acceptedCount,
        rejectedCount: input.rejectedCount,
        finishedAt: input.committedAt,
      },
    })
  }

  public commitNoop(
    runId: string,
    stats: MemoryDreamValidationStatsV2,
    committedAt = Date.now(),
    authorityCommit?: MemoryTreeAuthorityCommitParticipantV2
  ): void {
    validateDreamStatsV2(stats)
    const row = this.readValidatingRun(runId, stats)
    this.treeStore.commitDreamNoop({
      expectedTreeVersion: row.tree_version_before,
      frontierEvidenceSequence: row.frontier_after,
      dreamRunCommit: {
        runId: row.id,
        inputFingerprint: row.input_fingerprint,
        frontierBefore: row.frontier_before,
        tokenUsage: stats.tokenUsage,
        candidateCount: stats.candidateCount,
        acceptedCount: stats.acceptedCount,
        rejectedCount: stats.rejectedCount,
        finishedAt: committedAt,
      },
      committedAt,
      authorityCommit,
    })
  }

  public failRun(runId: string, errorCode: string, finishedAt = Date.now()): void {
    assertNonEmptyStringV2(errorCode, 'errorCode')
    assertNonNegativeSafeIntegerV2(finishedAt, 'finishedAt')
    const result = this.authority.database
      .prepare(
        `UPDATE memory_dream_runs
         SET state = 'failed', error_code = ?, finished_at = ?
         WHERE id = ? AND state IN ('running', 'validating')`
      )
      .run(errorCode, finishedAt, runId)
    if (result.changes !== 1) {
      throw new AppError('CONFLICT', 'Dream run 失败收口 CAS 失败。', undefined, { runId })
    }
  }

  public recoverOrphanedRuns(recoveredAt = Date.now()): number {
    assertNonNegativeSafeIntegerV2(recoveredAt, 'recoveredAt')
    const result = this.authority.database
      .prepare(
        `UPDATE memory_dream_runs
         SET state = 'failed', error_code = 'ORPHANED', finished_at = ?
         WHERE state IN ('running', 'validating')`
      )
      .run(recoveredAt)
    return result.changes
  }

  /** 同输入的旧运行是 failed / cancelled / skipped 时，原地重置成新的 running 批次。 */
  private restartFailedRun(
    runId: string,
    input: StartMemoryDreamBatchInputV2,
    frontierBefore: number,
    frontierAfter: number,
    treeVersionBefore: number,
    startedAt: number
  ): void {
    const updated = this.authority.database
      .prepare(
        `UPDATE memory_dream_runs
         SET trigger = ?, state = 'running',
             frontier_before = ?, frontier_after = ?,
             error_code = NULL,
             model_provider = ?, model = ?,
             token_usage = 0, candidate_count = 0,
             accepted_count = 0, rejected_count = 0,
             tree_version_before = ?, tree_version_after = ?,
             started_at = ?, finished_at = NULL
         WHERE id = ? AND state IN ('failed', 'cancelled', 'skipped')`
      )
      .run(
        input.trigger,
        frontierBefore,
        frontierAfter,
        input.modelProfile.provider,
        input.modelProfile.model,
        treeVersionBefore,
        treeVersionBefore,
        startedAt,
        runId
      )
    if (updated.changes !== 1) {
      throw new AppError('CONFLICT', 'Dream failed run 重试 CAS 失败。')
    }
  }

  /** 读一条必须处于 validating 的运行，并核对提交统计与已封存的候选账本一致。 */
  private readValidatingRun(
    runId: string,
    stats: MemoryDreamValidationStatsV2
  ): MemoryDreamRunRowV2 {
    const row = this.authority.database
      .prepare(`SELECT * FROM memory_dream_runs WHERE id = ?`)
      .get(runId) as MemoryDreamRunRowV2 | undefined
    if (!row || row.state !== 'validating') {
      throw new AppError('CONFLICT', 'Dream run 不在 validating 状态。', undefined, { runId })
    }
    if (
      row.token_usage !== stats.tokenUsage ||
      row.candidate_count !== stats.candidateCount ||
      row.accepted_count !== stats.acceptedCount ||
      row.rejected_count !== stats.rejectedCount
    ) {
      throw new AppError('VALIDATION', 'Dream 提交统计与已验证 candidate ledger 不一致。')
    }
    return row
  }

  /** 从注入的随机源取运行 id；长度不对就是随机源坏了。 */
  private randomId(): string {
    const value = this.random(MemoryDreamRunCoordinatorV2.RunIdByteLength)
    if (
      !Buffer.isBuffer(value) ||
      value.length !== MemoryDreamRunCoordinatorV2.RunIdByteLength
    ) {
      throw new AppError('INVARIANT', 'Dream run 随机源必须返回 16 字节。')
    }
    return value.toString('hex')
  }
}
