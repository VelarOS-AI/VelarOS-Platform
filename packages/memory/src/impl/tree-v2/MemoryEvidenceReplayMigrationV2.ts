import { createHash, randomBytes } from 'node:crypto'

import { AppError, isNotNull, isNull, toNullable } from '@velaros-ai/core'

import type {
  IngestMemoryEvidenceInputV2,
  LegacyMemoryEvidenceReaderV2,
  LegacyMemoryEvidenceRowV2,
  MemoryEvidenceEligibilityStateV2,
  MemoryEvidenceMappingVerificationV2,
  MemoryEvidenceParityReportV2,
  MemoryEvidenceRecordV2,
  MemoryEvidenceReplayReportV2,
  MemoryReplayGovernanceCountRowV2,
  MemoryReplayGovernanceCountsV2,
  RecordMemoryReplayGovernanceInputV2,
  ReplayLedgerRowV2,
  V2EvidenceParityRowV2,
} from '../../types/tree-v2/evidence'
import type { MemoryMetaIntegerRowV2 } from '../../types/tree-v2/store'
import { assertNonNegativeSafeIntegerV2 } from '../../utils/tree-v2/checks'
import { canonicalStringifyV2 } from '../../utils/tree-v2/diff-chain'
import {
  assertSourceDatabaseIdV2,
  computeMemoryEvidenceParityDigestV2,
  EvidenceReplayGovernanceDomainV2,
  EvidenceReplayMappingsDomainV2,
  normalizeLegacyEligibilityV2,
  normalizeLegacyEvidenceV2,
  normalizeLegacyPrivacyV2,
  normalizeLegacySourceTypeV2,
  normalizeLegacyTrustV2,
  ReplayableEligibilityStatesV2,
  resolveLegacyGovernanceTargetV2,
  validateLegacyEvidenceSequenceV2,
} from '../../utils/tree-v2/evidence-replay'

import type { ContentKeyServiceV2Api } from './storage/ContentKeyServiceV2'
import type { MemoryAuthorityDatabaseV2Api } from './MemoryAuthorityDatabaseV2'
import type { MemoryEvidenceIngestServiceV2Api } from './MemoryEvidenceIngestServiceV2'
import type { MemoryIdentityKeyServiceV2Api } from './MemoryIdentityKeyServiceV2'

/**
 * C 案证据重灌：把旧共享库的证据按到达序灌进 v2 权威库，并把旧库的治理裁决一并接过来。
 *
 * 只往 v2 追加；旧库经只读 reader 访问，这个类没有切权威或删旧表的动词。
 * 重灌账本按「旧库身份 + 旧证据 id」幂等，重跑不会灌第二遍。
 * 实例归 `MemorySystemRuntimeV2`（或探针）所有。
 */
export interface MemoryEvidenceReplayMigrationV2Api {
  /**
   * 按旧到达序重灌一遍：已擦除的落墓碑，其余归一化后走正常采集，降级一律记进治理账本。
   * 旧库身份或时刻不合法抛 VALIDATION；旧证据 id 重复或序号不递增抛 INVARIANT。
   */
  replay(
    reader: LegacyMemoryEvidenceReaderV2,
    replayedAt?: number
  ): MemoryEvidenceReplayReportV2
  /**
   * 对账：逐条比正文、可用状态与顺序，算出三个摘要。
   * 它不改任何东西，可以随时重跑；切权判定拿它的 verificationDigest 做依据。
   */
  verify(reader: LegacyMemoryEvidenceReaderV2): MemoryEvidenceParityReportV2
}

export class MemoryEvidenceReplayMigrationV2 implements MemoryEvidenceReplayMigrationV2Api {
  /** 墓碑证据 id 的随机字节数（128 位）。 */
  private static readonly EvidenceIdByteLength = 16

  constructor(
    private readonly authority: MemoryAuthorityDatabaseV2Api,
    private readonly ingest: MemoryEvidenceIngestServiceV2Api,
    private readonly contentKeys: ContentKeyServiceV2Api,
    private readonly identityKeys: MemoryIdentityKeyServiceV2Api,
    private readonly random: (byteLength: number) => Buffer = randomBytes
  ) {}

  public replay(
    reader: LegacyMemoryEvidenceReaderV2,
    replayedAt = Date.now()
  ): MemoryEvidenceReplayReportV2 {
    assertSourceDatabaseIdV2(reader.sourceDatabaseId)
    assertNonNegativeSafeIntegerV2(replayedAt, 'replayedAt')
    const rows = validateLegacyEvidenceSequenceV2(reader.listEvidence())
    let replayedCount = 0
    let alreadyReplayedCount = 0
    let tombstoneCount = 0

    for (const row of rows) {
      const existing = this.readLedger(reader.sourceDatabaseId, row.id)
      if (row.eligibilityState === 'erased') {
        const tombstone =
          existing ?? this.insertErasedTombstone(reader.sourceDatabaseId, row, replayedAt)
        if (existing) alreadyReplayedCount += 1
        else tombstoneCount += 1
        this.recordGovernance({
          sourceDatabaseId: reader.sourceDatabaseId,
          governanceType: 'eligibility',
          legacyTargetId: row.id,
          legacyEvidenceId: row.id,
          evidenceId: tombstone.evidence_id,
          disposition: 'applied',
          reasonCode: 'erased',
          recordedAt: replayedAt,
        })
        continue
      }
      const normalized = normalizeLegacyEvidenceV2(row)
      const evidenceId = existing
        ? existing.evidence_id
        : this.ingestWithLedger(reader.sourceDatabaseId, row, normalized.input, replayedAt).id
      if (existing) alreadyReplayedCount += 1
      else replayedCount += 1
      for (const reasonCode of normalized.knownLossReasons) {
        this.recordGovernance({
          sourceDatabaseId: reader.sourceDatabaseId,
          governanceType: 'scope_degraded',
          legacyTargetId: row.id,
          legacyEvidenceId: row.id,
          evidenceId,
          disposition: 'known_loss',
          reasonCode,
          recordedAt: replayedAt,
        })
      }
      if (row.eligibilityState !== 'active') {
        const eligibilityValid = ReplayableEligibilityStatesV2.has(
          row.eligibilityState as MemoryEvidenceEligibilityStateV2
        )
        this.recordGovernance({
          sourceDatabaseId: reader.sourceDatabaseId,
          governanceType: 'eligibility',
          legacyTargetId: row.id,
          legacyEvidenceId: row.id,
          evidenceId,
          disposition: eligibilityValid ? 'applied' : 'known_loss',
          reasonCode: eligibilityValid
            ? row.eligibilityState
            : 'eligibility_invalid_defaulted_to_excluded',
          recordedAt: replayedAt,
        })
      }
    }

    this.replayGovernance(reader, replayedAt)
    const governance = this.readGovernanceCounts(reader.sourceDatabaseId)
    return {
      mode: 'apply',
      sourceDatabaseId: reader.sourceDatabaseId,
      sourceEvidenceCount: rows.length,
      replayedCount,
      alreadyReplayedCount,
      tombstoneCount,
      governanceAppliedCount: governance.applied,
      governancePendingCount: governance.pending,
      knownLossCount: governance.knownLoss,
    }
  }

  public verify(reader: LegacyMemoryEvidenceReaderV2): MemoryEvidenceParityReportV2 {
    assertSourceDatabaseIdV2(reader.sourceDatabaseId)
    const source = validateLegacyEvidenceSequenceV2(reader.listEvidence())
    const sourceById = new Map(source.map((row) => [row.id, row]))
    const ledger = this.authority.database
      .prepare(
        `SELECT legacy_evidence_id, legacy_ingest_sequence, evidence_id, outcome
         FROM memory_evidence_replay_ledger
         WHERE source_database_id = ?
         ORDER BY legacy_ingest_sequence`
      )
      .all(reader.sourceDatabaseId) as ReplayLedgerRowV2[]
    let payloadMatchedCount = 0
    let payloadMismatchCount = 0
    let missingMappingCount = 0
    let orderMismatchCount = 0
    let eligibilityMismatchCount = 0
    let priorV2Sequence = 0
    const mappingVerification: MemoryEvidenceMappingVerificationV2[] = []
    const ledgerByLegacyId = new Map(ledger.map((row) => [row.legacy_evidence_id, row]))

    for (const sourceRow of source) {
      const mapping = ledgerByLegacyId.get(sourceRow.id)
      if (!mapping) {
        missingMappingCount += 1
        mappingVerification.push({
          legacyEvidenceId: sourceRow.id,
          legacyIngestSequence: sourceRow.ingestSequence,
          evidenceId: '',
          v2IngestSequence: null,
          outcome: 'missing',
          payloadMatched: false,
          eligibilityMatched: false,
        })
        continue
      }
      if (mapping.legacy_ingest_sequence !== sourceRow.ingestSequence) orderMismatchCount += 1
      const v2 = this.authority.database
        .prepare(
          `SELECT id, eligibility_state, payload_blob_ref, payload_commitment, ingest_sequence
           FROM memory_evidence
           WHERE id = ?`
        )
        .get(mapping.evidence_id) as V2EvidenceParityRowV2 | undefined
      if (!v2) {
        missingMappingCount += 1
        mappingVerification.push({
          legacyEvidenceId: sourceRow.id,
          legacyIngestSequence: sourceRow.ingestSequence,
          evidenceId: mapping.evidence_id,
          v2IngestSequence: null,
          outcome: mapping.outcome,
          payloadMatched: false,
          eligibilityMatched: false,
        })
        continue
      }
      if (v2.ingest_sequence <= priorV2Sequence) orderMismatchCount += 1
      priorV2Sequence = v2.ingest_sequence
      const eligibilityMatched =
        v2.eligibility_state === normalizeLegacyEligibilityV2(sourceRow.eligibilityState)
      if (!eligibilityMatched) eligibilityMismatchCount += 1
      const payloadMatched = this.comparePayload(sourceRow, mapping, v2)
      if (payloadMatched) payloadMatchedCount += 1
      else payloadMismatchCount += 1
      mappingVerification.push({
        legacyEvidenceId: sourceRow.id,
        legacyIngestSequence: sourceRow.ingestSequence,
        evidenceId: mapping.evidence_id,
        v2IngestSequence: v2.ingest_sequence,
        outcome: mapping.outcome,
        payloadMatched,
        eligibilityMatched,
      })
    }
    for (const mapping of ledger) {
      if (sourceById.has(mapping.legacy_evidence_id)) continue
      orderMismatchCount += 1
      mappingVerification.push({
        legacyEvidenceId: mapping.legacy_evidence_id,
        legacyIngestSequence: mapping.legacy_ingest_sequence,
        evidenceId: mapping.evidence_id,
        v2IngestSequence: null,
        outcome: 'orphan',
        payloadMatched: false,
        eligibilityMatched: false,
      })
    }
    const governance = this.readGovernanceCounts(reader.sourceDatabaseId)
    const unsigned = {
      mode: 'verify' as const,
      sourceDatabaseId: reader.sourceDatabaseId,
      sourceEvidenceCount: source.length,
      ledgerCount: ledger.length,
      payloadMatchedCount,
      payloadMismatchCount,
      missingMappingCount,
      orderMismatchCount,
      eligibilityMismatchCount,
      governanceAppliedCount: governance.applied,
      governancePendingCount: governance.pending,
      knownLossCount: governance.knownLoss,
      mappingDigest: createHash('sha256')
        .update(
          canonicalStringifyV2({
            domain: EvidenceReplayMappingsDomainV2,
            mappings: mappingVerification,
          }),
          'utf8'
        )
        .digest('hex'),
      governanceDigest: this.readGovernanceDigest(reader.sourceDatabaseId),
    }
    return { ...unsigned, verificationDigest: computeMemoryEvidenceParityDigestV2(unsigned) }
  }

  /** 逐条比正文：墓碑要求新库这条没有正文，其余解密后与旧正文逐字节比。 */
  private comparePayload(
    sourceRow: LegacyMemoryEvidenceRowV2,
    mapping: ReplayLedgerRowV2,
    v2: V2EvidenceParityRowV2
  ): boolean {
    if (mapping.outcome === 'tombstone') return !isNotNull(v2.payload_blob_ref) && !isNotNull(v2.payload_commitment)
    if (!v2.payload_blob_ref || !v2.payload_commitment) return false
    const plaintext = this.contentKeys.openContent(v2.payload_blob_ref, v2.payload_commitment)
    try {
      return plaintext.equals(Buffer.from(sourceRow.content, 'utf8'))
    } finally {
      plaintext.fill(0)
    }
  }

  /** 把旧库的治理裁决接过来：能算出匹配键的落成 applied，算不出的记成已知损耗。 */
  private replayGovernance(reader: LegacyMemoryEvidenceReaderV2, replayedAt: number): void {
    let denyGeneration: Nullable<number> = null
    for (const governance of reader.listGovernance()) {
      const mapping = governance.legacyEvidenceId
        ? this.readLedger(reader.sourceDatabaseId, governance.legacyEvidenceId)
        : null
      const target = resolveLegacyGovernanceTargetV2(governance.target, this.identityKeys)
      if (target.matchKey && isNull(denyGeneration)) {
        denyGeneration = this.ensureReplayDenyGeneration(reader.sourceDatabaseId, replayedAt)
      }
      this.recordGovernance({
        sourceDatabaseId: reader.sourceDatabaseId,
        governanceType: governance.governanceType,
        legacyTargetId: governance.legacyTargetId,
        legacyEvidenceId: governance.legacyEvidenceId,
        evidenceId: toNullable(mapping?.evidence_id),
        targetMatchKey: target.matchKey,
        denyGeneration: target.matchKey ? denyGeneration : null,
        disposition: target.matchKey ? 'applied' : 'known_loss',
        reasonCode:
          target.reasonCode ?? `legacy_${governance.governanceType}_governance_deny_applied`,
        recordedAt: replayedAt,
      })
    }
  }

  /** 采集一条并在同一事务里写重灌账本；事务失败就把刚封的密文擦掉。 */
  private ingestWithLedger(
    sourceDatabaseId: string,
    legacy: LegacyMemoryEvidenceRowV2,
    input: IngestMemoryEvidenceInputV2,
    replayedAt: number
  ): MemoryEvidenceRecordV2 {
    let captured: Optional<MemoryEvidenceRecordV2>
    try {
      const replay = this.authority.database.transaction(() => {
        captured = this.ingest.ingest(input)
        this.authority.database
          .prepare(
            `INSERT INTO memory_evidence_replay_ledger(
               source_database_id, legacy_evidence_id, legacy_ingest_sequence,
               evidence_id, outcome, replayed_at
             ) VALUES (?, ?, ?, ?, 'replayed', ?)`
          )
          .run(sourceDatabaseId, legacy.id, legacy.ingestSequence, captured.id, replayedAt)
      })
      replay()
      if (!captured) throw new AppError('INVARIANT', 'Evidence 重灌事务没有产出记录。')
      return captured
    } catch (error) {
      if (captured) {
        this.contentKeys.eraseContent(captured.payloadBlobRef)
        if (captured.metadataBlobRef) this.contentKeys.eraseContent(captured.metadataBlobRef)
      }
      throw error
    }
  }

  /** 旧库里已擦除的那条只落一个没有正文的墓碑行，占住采集序号与账本映射。 */
  private insertErasedTombstone(
    sourceDatabaseId: string,
    legacy: LegacyMemoryEvidenceRowV2,
    replayedAt: number
  ): ReplayLedgerRowV2 {
    const id = this.randomId()
    const database = this.authority.database
    const insert = database.transaction(() => {
      const sequence = database
        .prepare(
          `UPDATE memory_meta
           SET integer_value = integer_value + 1, updated_at = ?
           WHERE key = 'evidence_ingest_sequence'
           RETURNING integer_value`
        )
        .get(replayedAt) as MemoryMetaIntegerRowV2 | undefined
      if (!sequence) throw new AppError('INVARIANT', 'Evidence 序号 meta 缺失。')
      database
        .prepare(
          `INSERT INTO memory_evidence(
             id, source_type, trust_level, source_id,
             scope_type, occurred_at, privacy_class, eligibility_state,
             ingest_sequence, created_at
           ) VALUES (?, ?, ?, ?, 'global', ?, ?, 'erased', ?, ?)`
        )
        .run(
          id,
          normalizeLegacySourceTypeV2(legacy.sourceType),
          normalizeLegacyTrustV2(legacy.trustLevel),
          legacy.id,
          legacy.occurredAt,
          normalizeLegacyPrivacyV2(legacy.privacyClass),
          sequence.integer_value,
          replayedAt
        )
      database
        .prepare(
          `INSERT INTO memory_evidence_replay_ledger(
             source_database_id, legacy_evidence_id, legacy_ingest_sequence,
             evidence_id, outcome, replayed_at
           ) VALUES (?, ?, ?, ?, 'tombstone', ?)`
        )
        .run(sourceDatabaseId, legacy.id, legacy.ingestSequence, id, replayedAt)
    })
    insert()
    return {
      legacy_evidence_id: legacy.id,
      legacy_ingest_sequence: legacy.ingestSequence,
      evidence_id: id,
      outcome: 'tombstone',
    }
  }

  /** 查这条旧证据之前灌过没有（重灌的幂等键）。 */
  private readLedger(
    sourceDatabaseId: string,
    legacyEvidenceId: string
  ): Nullable<ReplayLedgerRowV2> {
    return toNullable(
      this.authority.database
        .prepare(
          `SELECT legacy_evidence_id, legacy_ingest_sequence, evidence_id, outcome
           FROM memory_evidence_replay_ledger
           WHERE source_database_id = ? AND legacy_evidence_id = ?`
        )
        .get(sourceDatabaseId, legacyEvidenceId) as ReplayLedgerRowV2 | undefined
    )
  }

  /** 往治理账本写一条（按「来源 + 类型 + 目标 + 证据 + 理由」幂等 upsert）。 */
  private recordGovernance(input: RecordMemoryReplayGovernanceInputV2): void {
    this.authority.database
      .prepare(
        `INSERT INTO memory_replay_governance(
           source_database_id, governance_type, legacy_target_id,
           legacy_evidence_id, evidence_id, target_match_key, deny_generation,
           disposition, reason_code, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(
           source_database_id, governance_type, legacy_target_id,
           legacy_evidence_id, reason_code
         ) DO UPDATE SET
           evidence_id = excluded.evidence_id,
           target_match_key = excluded.target_match_key,
           deny_generation = excluded.deny_generation,
           disposition = excluded.disposition,
           recorded_at = excluded.recorded_at`
      )
      .run(
        input.sourceDatabaseId,
        input.governanceType,
        input.legacyTargetId,
        input.legacyEvidenceId ?? '',
        input.evidenceId,
        toNullable(input.targetMatchKey),
        toNullable(input.denyGeneration),
        input.disposition,
        input.reasonCode,
        input.recordedAt
      )
  }

  /** 这次重灌用哪一代隐私代：同一个旧库复用已有那一代，第一次才推进一格。 */
  private ensureReplayDenyGeneration(sourceDatabaseId: string, recordedAt: number): number {
    const existing = this.authority.database
      .prepare(
        `SELECT max(deny_generation)
         FROM memory_replay_governance
         WHERE source_database_id = ? AND deny_generation IS NOT NULL`
      )
      .pluck()
      .get(sourceDatabaseId) as Nullable<number>
    if (isNotNull(existing)) return existing
    const next = this.authority.database
      .prepare(
        `UPDATE memory_meta
         SET integer_value = integer_value + 1, updated_at = ?
         WHERE key = 'privacy_generation'
         RETURNING integer_value`
      )
      .get(recordedAt) as MemoryMetaIntegerRowV2 | undefined
    if (!next) throw new AppError('INVARIANT', 'privacy_generation meta 缺失。')
    return next.integer_value
  }

  /** 按处置分组数一遍治理账本。 */
  private readGovernanceCounts(sourceDatabaseId: string): MemoryReplayGovernanceCountsV2 {
    const rows = this.authority.database
      .prepare(
        `SELECT disposition, count(*) AS count
         FROM memory_replay_governance
         WHERE source_database_id = ?
         GROUP BY disposition`
      )
      .all(sourceDatabaseId) as MemoryReplayGovernanceCountRowV2[]
    const count = (disposition: MemoryReplayGovernanceCountRowV2['disposition']): number =>
      rows.find((item) => item.disposition === disposition)?.count ?? 0
    return {
      applied: count('applied'),
      pending: count('pending'),
      knownLoss: count('known_loss'),
    }
  }

  /** 按固定排序读整本治理账本并取摘要，作为对账报告的一部分。 */
  private readGovernanceDigest(sourceDatabaseId: string): string {
    const entries = this.authority.database
      .prepare(
        `SELECT governance_type, legacy_target_id, legacy_evidence_id,
                evidence_id, target_match_key, deny_generation,
                disposition, reason_code
         FROM memory_replay_governance
         WHERE source_database_id = ?
         ORDER BY governance_type, legacy_target_id, legacy_evidence_id,
                  reason_code`
      )
      .all(sourceDatabaseId)
    return createHash('sha256')
      .update(
        canonicalStringifyV2({ domain: EvidenceReplayGovernanceDomainV2, entries }),
        'utf8'
      )
      .digest('hex')
  }

  /** 从注入的随机源取墓碑证据 id；长度不对就是随机源坏了。 */
  private randomId(): string {
    const value = this.random(MemoryEvidenceReplayMigrationV2.EvidenceIdByteLength)
    if (
      !Buffer.isBuffer(value) ||
      value.length !== MemoryEvidenceReplayMigrationV2.EvidenceIdByteLength
    ) {
      throw new AppError('INVARIANT', 'Replay 随机源必须返回 16 字节。')
    }
    return value.toString('hex')
  }
}
