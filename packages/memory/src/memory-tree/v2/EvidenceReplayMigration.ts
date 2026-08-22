import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'

import BetterSqlite3 from 'better-sqlite3'

import {
  AppError,
  isEmpty,
  isNotNull,
  isNull,
  isPlainObject,
  isString,
  toNullable,
} from '@velaros-ai/core'

import type { MemoryAuthorityDatabaseV2 } from './AuthorityDatabase'
import { canonicalStringifyV2 } from './DiffChain'
import type {
  IngestMemoryEvidenceInputV2,
  MemoryEvidenceEligibilityStateV2,
  MemoryEvidenceTrustLevelV2,
  MemoryPrivacyClassV2,
} from './EvidenceIngest'
import type { MemoryEvidenceIngestServiceV2 } from './EvidenceIngest'
import {
  canonicalizeWorkspacePathV2,
  type MemoryIdentityKeyServiceV2,
  normalizeOriginV2,
} from './IdentityKeys'
import type { ContentKeyServiceV2 } from './storage'

type SQLiteDatabase = InstanceType<typeof BetterSqlite3>

const TrustLevelsV2 = new Set<MemoryEvidenceTrustLevelV2>([
  'user_stated',
  'system_observed',
  'agent_derived',
  'external_content',
])
const PrivacyClassesV2 = new Set<MemoryPrivacyClassV2>(['standard', 'personal', 'sensitive'])
const ReplayableEligibilityV2 = new Set<MemoryEvidenceEligibilityStateV2>([
  'active',
  'source_deleted',
  'excluded',
  'erased',
])
const SourceDatabaseIdPatternV2 = /^sha256:[0-9a-f]{64}$/
const LegacySourceTypePatternV2 = /^[a-z][a-z0-9_-]{0,31}$/

export interface LegacyMemoryEvidenceRowV2 {
  readonly id: string
  readonly sourceType: string
  readonly trustLevel: string
  readonly sourceId: string
  readonly sessionId: string
  readonly executionId: string
  readonly workspaceRoot: string
  readonly scopeType: string
  readonly scopeId: string
  readonly occurredAt: number
  readonly title: string
  readonly content: string
  readonly category: string
  readonly privacyClass: string
  readonly eligibilityState: string
  readonly metadataJson: string
  readonly ingestSequence: number
  readonly createdAt: number
}

export interface LegacyMemoryGovernanceRowV2 {
  readonly governanceType: 'forgotten' | 'superseded' | 'erased'
  readonly legacyTargetId: string
  readonly legacyEvidenceId: Nullable<string>
  readonly target: Nullable<LegacyMemoryClaimGovernanceTargetV2>
}

export interface LegacyMemoryClaimGovernanceTargetV2 {
  readonly kind: 'claim'
  readonly conceptType: string
  readonly conceptName: string
  readonly conceptScopeType: string
  readonly conceptScopeId: string
  readonly predicate: string
  readonly valueJson: string
}

export interface LegacyMemoryEvidenceReaderV2 {
  readonly sourceDatabaseId: string
  listEvidence(): readonly LegacyMemoryEvidenceRowV2[]
  listGovernance(): readonly LegacyMemoryGovernanceRowV2[]
}

export interface MemoryEvidenceReplayReportV2 {
  readonly mode: 'apply'
  readonly sourceDatabaseId: string
  readonly sourceEvidenceCount: number
  readonly replayedCount: number
  readonly alreadyReplayedCount: number
  readonly tombstoneCount: number
  readonly governanceAppliedCount: number
  readonly governancePendingCount: number
  readonly knownLossCount: number
}

export interface MemoryEvidenceParityReportV2 {
  readonly mode: 'verify'
  readonly sourceDatabaseId: string
  readonly sourceEvidenceCount: number
  readonly ledgerCount: number
  readonly payloadMatchedCount: number
  readonly payloadMismatchCount: number
  readonly missingMappingCount: number
  readonly orderMismatchCount: number
  readonly eligibilityMismatchCount: number
  readonly governanceAppliedCount: number
  readonly governancePendingCount: number
  readonly knownLossCount: number
  readonly mappingDigest: string
  readonly governanceDigest: string
  readonly verificationDigest: string
}

export interface MemoryAuthorityCutoverReceiptV2 {
  readonly verificationDigest: string
  readonly verifiedAt: number
  readonly receiptId: string
}

export interface MemoryAuthorityUserSignoffV2 {
  readonly verificationDigest: string
  readonly confirmedAt: number
  readonly signoffId: string
}

export interface MemoryAuthorityCutoverDecisionV2 {
  readonly ready: boolean
  readonly missing: ReadonlyArray<
    'parity' | 'true_device_verification' | 'user_signoff' | 'digest_mismatch'
  >
}

interface ReplayLedgerRowV2 {
  legacy_evidence_id: string
  legacy_ingest_sequence: number
  evidence_id: string
  outcome: 'replayed' | 'tombstone'
}

interface V2EvidenceParityRowV2 {
  id: string
  eligibility_state: MemoryEvidenceEligibilityStateV2
  payload_blob_ref: Nullable<string>
  payload_commitment: Nullable<string>
  ingest_sequence: number
}

/**
 * 遗留共享库的只读 reader。以 SQLite readonly + query_only 双锁保证迁移代码无写权。
 */
export class LegacyMemoryEvidenceSqliteReaderV2 implements LegacyMemoryEvidenceReaderV2 {
  private constructor(
    public readonly sourceDatabaseId: string,
    private readonly database: SQLiteDatabase
  ) {}

  public static open(
    databasePath: string,
    sourceDatabaseId: string
  ): LegacyMemoryEvidenceSqliteReaderV2 {
    if (!existsSync(databasePath)) {
      throw new AppError('NOT_FOUND', '旧记忆 authority 数据库不存在。', undefined, {
        sourceDatabaseId,
      })
    }
    assertSourceDatabaseIdV2(sourceDatabaseId)
    const database = new BetterSqlite3(databasePath, {
      readonly: true,
      fileMustExist: true,
    })
    database.pragma('query_only = ON')
    assertLegacyEvidenceSchemaV2(database)
    return new LegacyMemoryEvidenceSqliteReaderV2(sourceDatabaseId, database)
  }

  public listEvidence(): readonly LegacyMemoryEvidenceRowV2[] {
    return (
      this.database
        .prepare(
          `SELECT id, source_type, trust_level, source_id, session_id, execution_id,
                  workspace_root, scope_type, scope_id, occurred_at, title, content,
                  category, privacy_class, eligibility_state, metadata_json,
                  ingest_sequence, created_at
           FROM memory_evidence
           ORDER BY ingest_sequence`
        )
        .all() as Array<Record<string, unknown>>
    ).map(mapLegacyEvidenceRowV2)
  }

  public listGovernance(): readonly LegacyMemoryGovernanceRowV2[] {
    if (
      !hasLegacyTableV2(this.database, 'memory_claims') ||
      !hasLegacyTableV2(this.database, 'memory_claim_evidence') ||
      !hasLegacyTableV2(this.database, 'memory_concepts')
    )
      return []
    return (
      this.database
        .prepare(
          `SELECT claim.id AS legacy_target_id,
                  claim.lifecycle_reason AS governance_type,
                  link.evidence_id AS legacy_evidence_id,
                  claim.predicate,
                  claim.value_json,
                  concept.concept_type,
                  concept.canonical_name,
                  concept.scope_type,
                  concept.scope_id
           FROM memory_claims claim
           LEFT JOIN memory_claim_evidence link ON link.claim_id = claim.id
           LEFT JOIN memory_concepts concept ON concept.id = claim.subject_concept_id
           WHERE claim.lifecycle_reason IN ('forgotten', 'superseded', 'erased')
           ORDER BY claim.id, link.evidence_id`
        )
        .all() as Array<{
        legacy_target_id: string
        governance_type: LegacyMemoryGovernanceRowV2['governanceType']
        legacy_evidence_id: Nullable<string>
        predicate: Nullable<string>
        value_json: Nullable<string>
        concept_type: Nullable<string>
        canonical_name: Nullable<string>
        scope_type: Nullable<string>
        scope_id: Nullable<string>
      }>
    ).map((row) => ({
      governanceType: row.governance_type,
      legacyTargetId: row.legacy_target_id,
      legacyEvidenceId: row.legacy_evidence_id,
      target:
        isString(row.predicate) &&
        isString(row.value_json) &&
        isString(row.concept_type) &&
        isString(row.canonical_name) &&
        isString(row.scope_type) &&
        isString(row.scope_id)
          ? {
              kind: 'claim',
              conceptType: row.concept_type,
              conceptName: row.canonical_name,
              conceptScopeType: row.scope_type,
              conceptScopeId: row.scope_id,
              predicate: row.predicate,
              valueJson: row.value_json,
            }
          : null,
    }))
  }

  public close(): void {
    this.database.close()
  }
}

/**
 * C 案 Evidence 重灌。只追加 v2 authority；旧库 reader 永久只读，不包含切权或 drop 动词。
 */
export class MemoryEvidenceReplayMigrationV2 {
  constructor(
    private readonly authority: MemoryAuthorityDatabaseV2,
    private readonly ingest: MemoryEvidenceIngestServiceV2,
    private readonly contentKeys: ContentKeyServiceV2,
    private readonly identityKeys: MemoryIdentityKeyServiceV2,
    private readonly random: (byteLength: number) => Buffer = randomBytes
  ) {}

  public replay(
    reader: LegacyMemoryEvidenceReaderV2,
    replayedAt = Date.now()
  ): MemoryEvidenceReplayReportV2 {
    assertSourceDatabaseIdV2(reader.sourceDatabaseId)
    assertNonNegativeIntegerV2(replayedAt, 'replayedAt')
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
        const eligibilityValid = ReplayableEligibilityV2.has(
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
    const mappingVerification: Array<{
      legacyEvidenceId: string
      legacyIngestSequence: number
      evidenceId: string
      v2IngestSequence: Nullable<number>
      outcome: ReplayLedgerRowV2['outcome'] | 'missing' | 'orphan'
      payloadMatched: boolean
      eligibilityMatched: boolean
    }> = []
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
      if (mapping.legacy_ingest_sequence !== sourceRow.ingestSequence) {
        orderMismatchCount += 1
      }
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
      const expectedEligibility = normalizeLegacyEligibilityV2(sourceRow.eligibilityState)
      const eligibilityMatched = v2.eligibility_state === expectedEligibility
      if (!eligibilityMatched) eligibilityMismatchCount += 1
      let payloadMatched = false
      if (mapping.outcome === 'tombstone') {
        if (isNotNull(v2.payload_blob_ref) || isNotNull(v2.payload_commitment)) {
          payloadMismatchCount += 1
        } else {
          payloadMatched = true
          payloadMatchedCount += 1
        }
        mappingVerification.push({
          legacyEvidenceId: sourceRow.id,
          legacyIngestSequence: sourceRow.ingestSequence,
          evidenceId: mapping.evidence_id,
          v2IngestSequence: v2.ingest_sequence,
          outcome: mapping.outcome,
          payloadMatched,
          eligibilityMatched,
        })
        continue
      }
      if (!v2.payload_blob_ref || !v2.payload_commitment) {
        payloadMismatchCount += 1
        mappingVerification.push({
          legacyEvidenceId: sourceRow.id,
          legacyIngestSequence: sourceRow.ingestSequence,
          evidenceId: mapping.evidence_id,
          v2IngestSequence: v2.ingest_sequence,
          outcome: mapping.outcome,
          payloadMatched: false,
          eligibilityMatched,
        })
        continue
      }
      const plaintext = this.contentKeys.openContent(v2.payload_blob_ref, v2.payload_commitment)
      try {
        if (plaintext.equals(Buffer.from(sourceRow.content, 'utf8'))) {
          payloadMatched = true
          payloadMatchedCount += 1
        } else {
          payloadMismatchCount += 1
        }
      } finally {
        plaintext.fill(0)
      }
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
      if (!sourceById.has(mapping.legacy_evidence_id)) {
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
    }
    const governance = this.readGovernanceCounts(reader.sourceDatabaseId)
    const mappingDigest = createHash('sha256')
      .update(
        canonicalStringifyV2({
          domain: 'velaros.memory.evidence-replay-mappings.v2',
          mappings: mappingVerification,
        }),
        'utf8'
      )
      .digest('hex')
    const governanceRows = this.authority.database
      .prepare(
        `SELECT governance_type, legacy_target_id, legacy_evidence_id,
                evidence_id, target_match_key, deny_generation,
                disposition, reason_code
         FROM memory_replay_governance
         WHERE source_database_id = ?
         ORDER BY governance_type, legacy_target_id, legacy_evidence_id,
                  reason_code`
      )
      .all(reader.sourceDatabaseId)
    const governanceDigest = createHash('sha256')
      .update(
        canonicalStringifyV2({
          domain: 'velaros.memory.evidence-replay-governance.v2',
          entries: governanceRows,
        }),
        'utf8'
      )
      .digest('hex')
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
      mappingDigest,
      governanceDigest,
    }
    return {
      ...unsigned,
      verificationDigest: computeMemoryEvidenceParityDigestV2(unsigned),
    }
  }

  private ingestWithLedger(
    sourceDatabaseId: string,
    legacy: LegacyMemoryEvidenceRowV2,
    input: IngestMemoryEvidenceInputV2,
    replayedAt: number
  ): { id: string } {
    let captured: ReturnType<MemoryEvidenceIngestServiceV2['ingest']> | undefined
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
      return { id: captured!.id }
    } catch (error) {
      if (captured) {
        this.contentKeys.eraseContent(captured.payloadBlobRef)
        if (captured.metadataBlobRef) {
          this.contentKeys.eraseContent(captured.metadataBlobRef)
        }
      }
      throw error
    }
  }

  private insertErasedTombstone(
    sourceDatabaseId: string,
    legacy: LegacyMemoryEvidenceRowV2,
    replayedAt: number
  ): ReplayLedgerRowV2 {
    const id = this.randomId()
    const insert = this.authority.database.transaction(() => {
      const sequence = this.authority.database
        .prepare(
          `UPDATE memory_meta
           SET integer_value = integer_value + 1, updated_at = ?
           WHERE key = 'evidence_ingest_sequence'
           RETURNING integer_value`
        )
        .get(replayedAt) as { integer_value: number } | undefined
      if (!sequence) throw new AppError('INVARIANT', 'Evidence 序号 meta 缺失。')
      this.authority.database
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
      this.authority.database
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

  private recordGovernance(input: {
    sourceDatabaseId: string
    governanceType: 'eligibility' | 'forgotten' | 'superseded' | 'erased' | 'scope_degraded'
    legacyTargetId: string
    legacyEvidenceId: Nullable<string>
    evidenceId: Nullable<string>
    targetMatchKey?: LooseOptional<string>
    denyGeneration?: LooseOptional<number>
    disposition: 'applied' | 'pending' | 'known_loss'
    reasonCode: string
    recordedAt: number
  }): void {
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
      .get(recordedAt) as { integer_value: number } | undefined
    if (!next) throw new AppError('INVARIANT', 'privacy_generation meta 缺失。')
    return next.integer_value
  }

  private readGovernanceCounts(sourceDatabaseId: string): {
    applied: number
    pending: number
    knownLoss: number
  } {
    const rows = this.authority.database
      .prepare(
        `SELECT disposition, count(*) AS count
         FROM memory_replay_governance
         WHERE source_database_id = ?
         GROUP BY disposition`
      )
      .all(sourceDatabaseId) as Array<{
      disposition: 'applied' | 'pending' | 'known_loss'
      count: number
    }>
    const count = (disposition: 'applied' | 'pending' | 'known_loss'): number =>
      rows.find((item) => item.disposition === disposition)?.count ?? 0
    return {
      applied: count('applied'),
      pending: count('pending'),
      knownLoss: count('known_loss'),
    }
  }

  private randomId(): string {
    const value = this.random(16)
    if (!Buffer.isBuffer(value) || value.length !== 16) {
      throw new AppError('INVARIANT', 'Replay 随机源必须返回 16 字节。')
    }
    return value.toString('hex')
  }
}

export function evaluateMemoryAuthorityCutoverV2(input: {
  report: MemoryEvidenceParityReportV2
  trueDeviceReceipt?: LooseOptional<MemoryAuthorityCutoverReceiptV2>
  userSignoff?: LooseOptional<MemoryAuthorityUserSignoffV2>
}): MemoryAuthorityCutoverDecisionV2 {
  const missing: Array<MemoryAuthorityCutoverDecisionV2['missing'][number]> = []
  const { verificationDigest, ...unsignedReport } = input.report
  const reportDigestValid =
    /^[0-9a-f]{64}$/.test(input.report.mappingDigest) &&
    /^[0-9a-f]{64}$/.test(input.report.governanceDigest) &&
    verificationDigest === computeMemoryEvidenceParityDigestV2(unsignedReport)
  if (
    !reportDigestValid ||
    input.report.payloadMismatchCount > 0 ||
    input.report.missingMappingCount > 0 ||
    input.report.orderMismatchCount > 0 ||
    input.report.eligibilityMismatchCount > 0 ||
    input.report.ledgerCount !== input.report.sourceEvidenceCount
  ) {
    missing.push('parity')
  }
  const trueDeviceReceipt = isValidCutoverAttestationV2(input.trueDeviceReceipt)
    ? input.trueDeviceReceipt
    : null
  const userSignoff = isValidCutoverAttestationV2(input.userSignoff) ? input.userSignoff : null
  if (!trueDeviceReceipt) missing.push('true_device_verification')
  if (!userSignoff) missing.push('user_signoff')
  if (
    (trueDeviceReceipt &&
      trueDeviceReceipt.verificationDigest !== input.report.verificationDigest) ||
    (userSignoff && userSignoff.verificationDigest !== input.report.verificationDigest)
  ) {
    missing.push('digest_mismatch')
  }
  return { ready: isEmpty(missing), missing }
}

export function computeMemoryEvidenceParityDigestV2(
  report: Omit<MemoryEvidenceParityReportV2, 'verificationDigest'>
): string {
  return createHash('sha256')
    .update(
      canonicalStringifyV2({
        domain: 'velaros.memory.evidence-replay-verification.v2',
        report,
      }),
      'utf8'
    )
    .digest('hex')
}

function isValidCutoverAttestationV2(
  input: LooseOptional<MemoryAuthorityCutoverReceiptV2 | MemoryAuthorityUserSignoffV2>
): input is MemoryAuthorityCutoverReceiptV2 | MemoryAuthorityUserSignoffV2 {
  if (!input || !/^[0-9a-f]{64}$/.test(input.verificationDigest)) return false
  const timestamp = 'verifiedAt' in input ? input.verifiedAt : input.confirmedAt
  const id = 'receiptId' in input ? input.receiptId : input.signoffId
  return Number.isSafeInteger(timestamp) && timestamp >= 0 && !isEmpty(id)
}

function resolveLegacyGovernanceTargetV2(
  target: Nullable<LegacyMemoryClaimGovernanceTargetV2>,
  identityKeys: MemoryIdentityKeyServiceV2
): { matchKey: Nullable<string>; reasonCode: Nullable<string> } {
  if (!target)
    return {
      matchKey: null,
      reasonCode: 'legacy_governance_target_missing',
    }
  if (!target.conceptType || !target.conceptName || !target.predicate)
    return {
      matchKey: null,
      reasonCode: 'legacy_governance_identity_incomplete',
    }
  let scopeType: 'global' | 'workspace' | 'origin'
  let scopeId: string
  try {
    if (target.conceptScopeType === 'global') {
      scopeType = 'global'
      scopeId = 'global'
    } else if (target.conceptScopeType === 'workspace') {
      scopeType = 'workspace'
      scopeId = canonicalizeWorkspacePathV2(target.conceptScopeId)
    } else if (target.conceptScopeType === 'site' || target.conceptScopeType === 'origin') {
      scopeType = 'origin'
      scopeId = normalizeOriginV2(target.conceptScopeId)
    } else {
      return {
        matchKey: null,
        reasonCode: 'legacy_governance_scope_unsupported',
      }
    }
  } catch {
    // arch-guard:silent-catch-ok 遗留 scope 不可解析时返回明确的 reasonCode，继续处理其他证据。
    return {
      matchKey: null,
      reasonCode: 'legacy_governance_scope_unresolvable',
    }
  }
  let value: unknown
  try {
    value = JSON.parse(target.valueJson) as unknown
  } catch {
    // arch-guard:silent-catch-ok 遗留治理值不是 JSON 时返回明确的 reasonCode，继续处理其他证据。
    return {
      matchKey: null,
      reasonCode: 'legacy_governance_value_invalid',
    }
  }
  const conceptStableKey = identityKeys.conceptStableKey({
    conceptType: target.conceptType,
    scopeType,
    scopeId,
    discriminator: target.conceptName,
  })
  return {
    matchKey: identityKeys.claimGovernanceMatchKey({
      conceptStableKey,
      predicate: target.predicate,
      content: canonicalStringifyV2(value),
    }),
    reasonCode: null,
  }
}

function normalizeLegacyEvidenceV2(row: LegacyMemoryEvidenceRowV2): {
  input: IngestMemoryEvidenceInputV2
  knownLossReasons: readonly string[]
} {
  const scope = resolveLegacyScopeV2(row)
  const metadata = parseLegacyMetadataV2(row.metadataJson)
  const knownLossReasons = [
    scope.degradedReason,
    metadata.parsed ? null : 'metadata_json_invalid',
    TrustLevelsV2.has(row.trustLevel as MemoryEvidenceTrustLevelV2)
      ? null
      : 'trust_level_invalid_defaulted_to_external_content',
    PrivacyClassesV2.has(row.privacyClass as MemoryPrivacyClassV2)
      ? null
      : 'privacy_class_invalid_defaulted_to_sensitive',
    LegacySourceTypePatternV2.test(row.sourceType)
      ? null
      : 'source_type_invalid_defaulted_to_legacy_import',
  ].filter((reason): reason is string => isNotNull(reason))
  return {
    input: {
      sourceType: normalizeLegacySourceTypeV2(row.sourceType),
      trustLevel: normalizeLegacyTrustV2(row.trustLevel),
      sourceId: row.id,
      sessionId: row.sessionId || null,
      executionId: row.executionId || null,
      scope: scope.scope,
      occurredAt: row.occurredAt,
      payload: row.content,
      metadata: {
        category: row.category,
        legacyMetadata: metadata.value,
        legacySourceId: row.sourceId,
        legacyScopeId: row.scopeId,
        legacyScopeType: row.scopeType,
        legacyTitle: row.title,
        legacyWorkspaceRoot: row.workspaceRoot,
        metadataParseState: metadata.parsed ? 'parsed' : 'invalid_json',
      },
      privacyClass: normalizeLegacyPrivacyV2(row.privacyClass),
      eligibilityState: normalizeLegacyEligibilityV2(row.eligibilityState) as Exclude<
        MemoryEvidenceEligibilityStateV2,
        'erased'
      >,
      createdAt: row.createdAt,
    },
    knownLossReasons,
  }
}

function resolveLegacyScopeV2(row: LegacyMemoryEvidenceRowV2): {
  scope: IngestMemoryEvidenceInputV2['scope']
  degradedReason: Nullable<string>
} {
  if (row.workspaceRoot) {
    if (existsSync(row.workspaceRoot))
      return {
        scope: { type: 'workspace', rootPath: row.workspaceRoot },
        degradedReason: null,
      }
    return {
      scope: { type: 'global' },
      degradedReason: 'workspace_path_unresolvable',
    }
  }
  if (row.scopeType === 'site' || row.scopeType === 'origin') {
    try {
      const origin = new URL(row.scopeId).origin
      if (origin !== 'null') return { scope: { type: 'origin', origin }, degradedReason: null }
    } catch {
      // arch-guard:silent-catch-ok 遗留 site scope 不是 URL 时退为 global，并记录已知损耗。
    }
    return {
      scope: { type: 'global' },
      degradedReason: 'site_origin_unresolvable',
    }
  }
  return {
    scope: { type: 'global' },
    degradedReason: row.scopeType === 'global' ? null : 'legacy_scope_unknown_flattened',
  }
}

function normalizeLegacyEligibilityV2(value: string): MemoryEvidenceEligibilityStateV2 {
  return ReplayableEligibilityV2.has(value as MemoryEvidenceEligibilityStateV2)
    ? (value as MemoryEvidenceEligibilityStateV2)
    : 'excluded'
}

function normalizeLegacyTrustV2(value: string): MemoryEvidenceTrustLevelV2 {
  return TrustLevelsV2.has(value as MemoryEvidenceTrustLevelV2)
    ? (value as MemoryEvidenceTrustLevelV2)
    : 'external_content'
}

function normalizeLegacyPrivacyV2(value: string): MemoryPrivacyClassV2 {
  return PrivacyClassesV2.has(value as MemoryPrivacyClassV2)
    ? (value as MemoryPrivacyClassV2)
    : 'sensitive'
}

function normalizeLegacySourceTypeV2(value: string): string {
  return LegacySourceTypePatternV2.test(value) ? value : 'legacy_import'
}

function validateLegacyEvidenceSequenceV2(
  rows: readonly LegacyMemoryEvidenceRowV2[]
): readonly LegacyMemoryEvidenceRowV2[] {
  const ids = new Set<string>()
  let prior = 0
  for (const row of rows) {
    if (!row.id || ids.has(row.id)) {
      throw new AppError('INVARIANT', '旧 Evidence id 缺失或重复。')
    }
    if (!Number.isSafeInteger(row.ingestSequence) || row.ingestSequence <= prior) {
      throw new AppError('INVARIANT', '旧 Evidence ingest_sequence 必须严格递增。')
    }
    ids.add(row.id)
    prior = row.ingestSequence
  }
  return rows
}

function mapLegacyEvidenceRowV2(row: Record<string, unknown>): LegacyMemoryEvidenceRowV2 {
  const text = (key: string): string => {
    const value = row[key]
    if (!isString(value)) {
      throw new AppError('INVARIANT', `旧 Evidence ${key} 不是字符串。`)
    }
    return value
  }
  const integer = (key: string): number => {
    const value = row[key]
    if (!Number.isSafeInteger(value)) {
      throw new AppError('INVARIANT', `旧 Evidence ${key} 不是安全整数。`)
    }
    return value as number
  }
  return {
    id: text('id'),
    sourceType: text('source_type'),
    trustLevel: text('trust_level'),
    sourceId: text('source_id'),
    sessionId: text('session_id'),
    executionId: text('execution_id'),
    workspaceRoot: text('workspace_root'),
    scopeType: text('scope_type'),
    scopeId: text('scope_id'),
    occurredAt: integer('occurred_at'),
    title: text('title'),
    content: text('content'),
    category: text('category'),
    privacyClass: text('privacy_class'),
    eligibilityState: text('eligibility_state'),
    metadataJson: text('metadata_json'),
    ingestSequence: integer('ingest_sequence'),
    createdAt: integer('created_at'),
  }
}

function parseLegacyMetadataV2(raw: string): {
  value: Record<string, unknown>
  parsed: boolean
} {
  try {
    const value: unknown = JSON.parse(raw)
    if (isPlainObject(value)) return { value, parsed: true }
  } catch {
    // arch-guard:silent-catch-ok 返回 parsed=false，由调用方记录损耗；坏 metadata 不阻断正文重放。
  }
  return { value: {}, parsed: false }
}

function assertLegacyEvidenceSchemaV2(database: SQLiteDatabase): void {
  if (!hasLegacyTableV2(database, 'memory_evidence')) {
    throw new AppError('VALIDATION', '旧数据库缺少 memory_evidence，拒绝猜测迁移来源。')
  }
  const columns = new Set(
    (
      database.pragma('table_info(memory_evidence)') as Array<{
        name: string
      }>
    ).map((column) => column.name)
  )
  const required = [
    'id',
    'source_type',
    'trust_level',
    'source_id',
    'session_id',
    'execution_id',
    'workspace_root',
    'scope_type',
    'scope_id',
    'occurred_at',
    'title',
    'content',
    'category',
    'privacy_class',
    'eligibility_state',
    'metadata_json',
    'ingest_sequence',
    'created_at',
  ]
  if (required.some((column) => !columns.has(column))) {
    throw new AppError('VALIDATION', '旧 memory_evidence schema 不受支持。')
  }
}

function hasLegacyTableV2(database: SQLiteDatabase, table: string): boolean {
  return Boolean(
    database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
  )
}

function assertSourceDatabaseIdV2(value: string): void {
  if (!SourceDatabaseIdPatternV2.test(value)) {
    throw new AppError('VALIDATION', 'sourceDatabaseId 必须是旧库文件的 SHA-256 身份。')
  }
}

function assertNonNegativeIntegerV2(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError('VALIDATION', `${label} 必须是非负安全整数。`)
  }
}
