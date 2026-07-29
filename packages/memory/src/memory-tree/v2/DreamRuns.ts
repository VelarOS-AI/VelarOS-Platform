import { randomBytes } from 'node:crypto'

import { AppError } from '@velaros-ai/core/error'

import type { MemoryAuthorityDatabaseV2 } from './AuthorityDatabase'
import { canonicalStringifyV2, type MemoryTreeDiffOpV2 } from './DiffChain'
import { computeDreamInputFingerprintV2 } from './IdentityKeys'
import type { ContentKeyServiceV2, MemorySealedContentV2 } from './storage'
import {
  type CommitMemoryTreeVersionResultV2,
  type MemoryTreeAuthorityCommitParticipantV2,
  type MemoryTreeIdentityChangeV2,
  type MemoryTreeStoreV2,
} from './TreeStore'

export const MemoryDreamPipelineVersionV2 = 1

export interface MemoryDreamModelProfileV2 {
  readonly provider: string | null
  readonly model: string | null
}

export interface MemoryDreamEvidenceDescriptorV2 {
  readonly id: string
  readonly ingestSequence: number
  readonly eligibilityState: 'active' | 'source_deleted' | 'excluded' | 'erased'
  readonly payloadBlobRef: string | null
  readonly payloadCommitment: string | null
  readonly metadataBlobRef: string | null
  readonly metadataCommitment: string | null
}

export interface MemoryDreamStartedRunV2 {
  readonly kind: 'started'
  readonly runId: string
  readonly inputFingerprint: string
  readonly frontierBefore: number
  readonly frontierAfter: number
  readonly treeVersionBefore: number
  readonly evidence: readonly MemoryDreamEvidenceDescriptorV2[]
  readonly eligibleEvidence: readonly MemoryDreamEvidenceDescriptorV2[]
}

export interface MemoryDreamSkippedRunV2 {
  readonly kind: 'skipped'
  readonly runId: string
  readonly inputFingerprint: string
  readonly frontierBefore: number
  readonly frontierAfter: number
  readonly treeVersionBefore: number
}

export type StartMemoryDreamRunResultV2 =
  | MemoryDreamStartedRunV2
  | MemoryDreamSkippedRunV2
  | null

export interface MemoryDreamValidationStatsV2 {
  readonly tokenUsage: number
  readonly candidateCount: number
  readonly acceptedCount: number
  readonly rejectedCount: number
}

export interface CommitMemoryDreamTreeInputV2 extends MemoryDreamValidationStatsV2 {
  readonly ops: readonly MemoryTreeDiffOpV2[]
  readonly identityChange?: MemoryTreeIdentityChangeV2 | null
  readonly activeIdentityEpochId: string
  readonly globalMainlineNodeId: string
  readonly committedAt?: number
  readonly authorityCommit?: MemoryTreeAuthorityCommitParticipantV2
}

export interface MaterializedMemoryDreamEvidenceV2 {
  readonly payload: Buffer
  readonly metadata: Buffer | null
}

interface MemoryDreamRunRowV2 {
  id: string
  state: string
  input_fingerprint: string
  frontier_before: number
  frontier_after: number
  tree_version_before: number
  tree_version_after: number
  model_provider: string | null
  model: string | null
  token_usage: number
  candidate_count: number
  accepted_count: number
  rejected_count: number
}

interface MemoryDreamEvidenceRowV2 {
  id: string
  ingest_sequence: number
  eligibility_state: MemoryDreamEvidenceDescriptorV2['eligibilityState']
  payload_blob_ref: string | null
  payload_commitment: string | null
  metadata_blob_ref: string | null
  metadata_commitment: string | null
}

/**
 * Dream run 账本与 I1-I6 事务编排。模型推理仍由上层注入；本层只拥有批次、状态机与提交。
 */
export class MemoryDreamRunCoordinatorV2 {
  constructor(
    private readonly authority: MemoryAuthorityDatabaseV2,
    private readonly contentKeys: ContentKeyServiceV2,
    private readonly treeStore: MemoryTreeStoreV2,
    private readonly random: (byteLength: number) => Buffer = randomBytes
  ) {}

  public startNextBatch(input: {
    trigger: string
    batchSize: number
    modelProfile: MemoryDreamModelProfileV2
    startedAt?: number
  }): StartMemoryDreamRunResultV2 {
    assertNonEmptyStringV2(input.trigger, 'trigger')
    assertPositiveSafeIntegerV2(input.batchSize, 'batchSize')
    const startedAt = input.startedAt ?? Date.now()
    assertNonNegativeSafeIntegerV2(startedAt, 'startedAt')
    const frontierBefore = this.readMeta('dream_frontier')
    const ingestHead = this.readMeta('evidence_ingest_sequence')
    if (ingestHead <= frontierBefore) return null
    const frontierAfter = Math.min(ingestHead, frontierBefore + input.batchSize)
    const evidence = (
      this.authority.database
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
      pipelineVersion: MemoryDreamPipelineVersionV2,
    })
    const treeVersionBefore = this.treeStore.version
    const existing = this.authority.database
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
    const start = this.authority.database.transaction(() => {
      if (
        this.readMeta('dream_frontier') !== frontierBefore ||
        this.readMeta('tree_version') !== treeVersionBefore
      ) {
        throw new AppError('CONFLICT', 'Dream 批次建立时 frontier/tree head 已变化。')
      }
      if (existing) {
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
      } else {
        this.authority.database
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
      }
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
          ? this.contentKeys.openContent(
              descriptor.metadataBlobRef,
              descriptor.metadataCommitment
            )
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
    validateStatsV2(stats)
    const sealed = this.contentKeys.sealContent(canonicalStringifyV2(candidateLedger))
    let committed = false
    try {
      const mark = this.authority.database.transaction(() => {
        registerBlobV2(this.authority, sealed, Date.now())
        const result = this.authority.database
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
    validateStatsV2(input)
    if (input.ops.length === 0 && !input.identityChange) {
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
    validateStatsV2(stats)
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

  /** I3：只翻 run 状态，不触碰 frontier、tree_version 或 diff/snapshot。 */
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

  private readMeta(key: string): number {
    const row = this.authority.database
      .prepare(`SELECT integer_value FROM memory_meta WHERE key = ?`)
      .get(key) as { integer_value: number } | undefined
    if (!row) throw new AppError('INVARIANT', `memory_meta 缺少 ${key}。`)
    return row.integer_value
  }

  private randomId(): string {
    const value = this.random(16)
    if (!Buffer.isBuffer(value) || value.length !== 16) {
      throw new AppError('INVARIANT', 'Dream run 随机源必须返回 16 字节。')
    }
    return value.toString('hex')
  }
}

function mapDreamEvidenceV2(row: MemoryDreamEvidenceRowV2): MemoryDreamEvidenceDescriptorV2 {
  return {
    id: row.id,
    ingestSequence: row.ingest_sequence,
    eligibilityState: row.eligibility_state,
    payloadBlobRef: row.payload_blob_ref,
    payloadCommitment: row.payload_commitment,
    metadataBlobRef: row.metadata_blob_ref,
    metadataCommitment: row.metadata_commitment,
  }
}

function registerBlobV2(
  authority: MemoryAuthorityDatabaseV2,
  sealed: MemorySealedContentV2,
  createdAt: number
): void {
  authority.database
    .prepare(
      `INSERT INTO memory_content_blobs(blob_id, byte_length, state, created_at)
       VALUES (?, ?, 'active', ?)`
    )
    .run(sealed.blobId, sealed.byteLength, createdAt)
}

function validateStatsV2(stats: MemoryDreamValidationStatsV2): void {
  assertNonNegativeSafeIntegerV2(stats.tokenUsage, 'tokenUsage')
  assertNonNegativeSafeIntegerV2(stats.candidateCount, 'candidateCount')
  assertNonNegativeSafeIntegerV2(stats.acceptedCount, 'acceptedCount')
  assertNonNegativeSafeIntegerV2(stats.rejectedCount, 'rejectedCount')
  if (stats.acceptedCount + stats.rejectedCount !== stats.candidateCount) {
    throw new AppError('VALIDATION', 'candidate 统计不守恒。')
  }
}

function assertNonEmptyStringV2(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('VALIDATION', `${label} 不得为空。`)
  }
}

function assertPositiveSafeIntegerV2(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AppError('VALIDATION', `${label} 必须是正安全整数。`)
  }
}

function assertNonNegativeSafeIntegerV2(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError('VALIDATION', `${label} 必须是非负安全整数。`)
  }
}
