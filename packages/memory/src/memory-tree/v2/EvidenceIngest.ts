import { randomBytes } from 'node:crypto'

import { isString, isUndefined, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { MemoryBlobStoreV2 } from './storage/BlobStore'
import type { ContentKeyServiceV2, MemorySealedContentV2 } from './storage/ContentKeyService'
import type { MemoryAuthorityDatabaseV2 } from './AuthorityDatabase'
import { canonicalStringifyV2 } from './DiffChain'
import {
  canonicalizeWorkspacePathV2,
  type MemoryIdentityKeyServiceV2,
  normalizeOriginV2,
} from './IdentityKeys'

export type MemoryEvidenceEligibilityStateV2 = 'active' | 'source_deleted' | 'excluded' | 'erased'

export type MemoryPrivacyClassV2 = 'standard' | 'personal' | 'sensitive'
export type MemoryEvidenceTrustLevelV2 =
  'user_stated' | 'system_observed' | 'agent_derived' | 'external_content'

export type MemoryEvidenceScopeInputV2 =
  | { readonly type: 'global' }
  | { readonly type: 'workspace'; readonly rootPath: string }
  | { readonly type: 'origin'; readonly origin: string }

export interface IngestMemoryEvidenceInputV2 {
  readonly sourceType: string
  readonly trustLevel: MemoryEvidenceTrustLevelV2
  readonly sourceId?: LooseOptional<string>
  readonly sourceReference?: LooseOptional<string>
  readonly sessionId?: LooseOptional<string>
  readonly executionId?: LooseOptional<string>
  readonly scope: MemoryEvidenceScopeInputV2
  readonly occurredAt: number
  readonly payload: Buffer | string
  readonly metadata?: unknown
  readonly privacyClass: MemoryPrivacyClassV2
  readonly eligibilityState?: Exclude<MemoryEvidenceEligibilityStateV2, 'erased'>
  readonly createdAt?: number
}

export interface MemoryEvidenceRecordV2 {
  readonly id: string
  readonly ingestSequence: number
  readonly sourceType: string
  readonly sourceId: Nullable<string>
  readonly sourceMatchKey: Nullable<string>
  readonly sessionId: Nullable<string>
  readonly executionId: Nullable<string>
  readonly scopeType: string
  readonly scopeMatchKey: Nullable<string>
  readonly occurredAt: number
  readonly payloadBlobRef: string
  readonly payloadCommitment: string
  readonly metadataBlobRef: Nullable<string>
  readonly metadataCommitment: Nullable<string>
  readonly privacyClass: MemoryPrivacyClassV2
  readonly eligibilityState: MemoryEvidenceEligibilityStateV2
  readonly createdAt: number
}

export interface ReactivateMemoryEvidenceResultV2 {
  readonly mode: 'in_place' | 'reingested'
  readonly evidence: MemoryEvidenceRecordV2
}

interface MemoryEvidenceRowV2 {
  id: string
  ingest_sequence: number
  source_type: string
  source_id: Nullable<string>
  source_match_key: Nullable<string>
  session_id: Nullable<string>
  execution_id: Nullable<string>
  scope_type: string
  scope_match_key: Nullable<string>
  occurred_at: number
  payload_blob_ref: Nullable<string>
  payload_commitment: Nullable<string>
  metadata_blob_ref: Nullable<string>
  metadata_commitment: Nullable<string>
  privacy_class: MemoryPrivacyClassV2
  eligibility_state: MemoryEvidenceEligibilityStateV2
  created_at: number
}

/**
 * Evidence 的唯一采集入口：先密封正文，再在一个 authority 事务里分配序号、登记 blob 与写行。
 */
export class MemoryEvidenceIngestServiceV2 {
  constructor(
    private readonly authority: MemoryAuthorityDatabaseV2,
    private readonly contentKeys: ContentKeyServiceV2,
    private readonly identityKeys: MemoryIdentityKeyServiceV2,
    private readonly blobs: MemoryBlobStoreV2,
    private readonly random: (byteLength: number) => Buffer = randomBytes
  ) {}

  public ingest(input: IngestMemoryEvidenceInputV2): MemoryEvidenceRecordV2 {
    validateIngestInputV2(input)
    const scope = this.resolveScope(input.scope)
    const sourceMatchKey = input.sourceReference
      ? this.identityKeys.sourceReferenceMatchKey(input.sourceReference)
      : null
    const payload = this.contentKeys.sealContent(input.payload)
    let metadata: Nullable<MemorySealedContentV2> = null
    try {
      if (!isUndefined(input.metadata)) {
        metadata = this.contentKeys.sealContent(canonicalStringifyV2(input.metadata))
      }
      const id = this.randomId()
      const createdAt = input.createdAt ?? Date.now()
      const record = this.insertEvidence({
        id,
        input,
        scopeType: scope.scopeType,
        scopeMatchKey: scope.scopeMatchKey,
        sourceMatchKey,
        payload,
        metadata,
        createdAt,
      })
      return record
    } catch (error) {
      this.contentKeys.eraseContent(payload.blobId)
      if (metadata) this.contentKeys.eraseContent(metadata.blobId)
      throw error
    }
  }

  /**
   * I6：frontier 以下的可逆不合格行不原地翻活，解密并重新密封成一条新序号 Evidence。
   */
  public reactivate(evidenceId: string, createdAt = Date.now()): ReactivateMemoryEvidenceResultV2 {
    assertNonEmptyStringV2(evidenceId, 'evidenceId')
    assertNonNegativeSafeIntegerV2(createdAt, 'createdAt')
    const row = this.authority.database
      .prepare(`SELECT * FROM memory_evidence WHERE id = ?`)
      .get(evidenceId) as MemoryEvidenceRowV2 | undefined
    if (!row)
      throw new AppError('NOT_FOUND', '待恢复 Evidence 不存在。', undefined, {
        evidenceId,
      })
    if (row.eligibility_state === 'active') {
      throw new AppError('CONFLICT', 'Evidence 已处于 active。', undefined, {
        evidenceId,
      })
    }
    if (row.eligibility_state === 'erased') {
      throw new AppError('VALIDATION', 'erased Evidence 是终态，不得复活。', undefined, {
        evidenceId,
      })
    }
    const frontier = this.readMeta('dream_frontier')
    if (row.ingest_sequence > frontier) {
      const updated = this.authority.database
        .prepare(
          `UPDATE memory_evidence
           SET eligibility_state = 'active'
           WHERE id = ? AND ingest_sequence > ? AND eligibility_state IN ('excluded', 'source_deleted')`
        )
        .run(evidenceId, frontier)
      if (updated.changes !== 1) {
        throw new AppError('CONFLICT', 'Evidence 原地恢复 CAS 失败。', undefined, { evidenceId })
      }
      return {
        mode: 'in_place',
        evidence: mapEvidenceRowV2({ ...row, eligibility_state: 'active' }),
      }
    }
    if (!row.payload_blob_ref || !row.payload_commitment) {
      throw new AppError('INVARIANT', '可逆 Evidence 缺少 payload blob。', undefined, {
        evidenceId,
      })
    }

    const payload = this.contentKeys.openContent(row.payload_blob_ref, row.payload_commitment)
    const metadata =
      row.metadata_blob_ref && row.metadata_commitment
        ? this.contentKeys.openContent(row.metadata_blob_ref, row.metadata_commitment)
        : null
    try {
      const resealedPayload = this.contentKeys.sealContent(payload)
      let resealedMetadata: Nullable<MemorySealedContentV2> = null
      try {
        if (metadata) resealedMetadata = this.contentKeys.sealContent(metadata)
        const record = this.insertEvidence({
          id: this.randomId(),
          input: {
            sourceType: row.source_type,
            trustLevel: this.readTrustLevel(row.id),
            sourceId: row.source_id,
            sessionId: row.session_id,
            executionId: row.execution_id,
            scope: { type: 'global' },
            occurredAt: row.occurred_at,
            payload: Buffer.alloc(0),
            privacyClass: row.privacy_class,
            eligibilityState: 'active',
            createdAt,
          },
          scopeType: row.scope_type,
          scopeMatchKey: row.scope_match_key,
          sourceMatchKey: row.source_match_key,
          payload: resealedPayload,
          metadata: resealedMetadata,
          createdAt,
        })
        return { mode: 'reingested', evidence: record }
      } catch (error) {
        this.contentKeys.eraseContent(resealedPayload.blobId)
        if (resealedMetadata) this.contentKeys.eraseContent(resealedMetadata.blobId)
        throw error
      }
    } finally {
      payload.fill(0)
      metadata?.fill(0)
    }
  }

  /**
   * 崩溃可能发生在密文原子落盘后、authority 引用提交前。只清理没有权威登记的物理 blob。
   */
  public recoverOrphanedBlobs(): number {
    const registered = new Set(
      (
        this.authority.database.prepare(`SELECT blob_id FROM memory_content_blobs`).all() as Array<{
          blob_id: string
        }>
      ).map((row) => row.blob_id)
    )
    let recovered = 0
    for (const blobId of this.blobs.listBlobIds()) {
      if (registered.has(blobId)) continue
      this.contentKeys.eraseContent(blobId)
      recovered += 1
    }
    return recovered
  }

  private insertEvidence(input: {
    id: string
    input: IngestMemoryEvidenceInputV2
    scopeType: string
    scopeMatchKey: Nullable<string>
    sourceMatchKey: Nullable<string>
    payload: MemorySealedContentV2
    metadata: Nullable<MemorySealedContentV2>
    createdAt: number
  }): MemoryEvidenceRecordV2 {
    assertNonNegativeSafeIntegerV2(input.createdAt, 'createdAt')
    const insert = this.authority.database.transaction(() => {
      const sequenceRow = this.authority.database
        .prepare(
          `UPDATE memory_meta
           SET integer_value = integer_value + 1, updated_at = ?
           WHERE key = 'evidence_ingest_sequence'
           RETURNING integer_value`
        )
        .get(input.createdAt) as { integer_value: number } | undefined
      if (!sequenceRow) {
        throw new AppError('INVARIANT', 'evidence_ingest_sequence meta 缺失。')
      }
      registerBlobV2(this.authority, input.payload, input.createdAt)
      if (input.metadata) registerBlobV2(this.authority, input.metadata, input.createdAt)
      this.authority.database
        .prepare(
          `INSERT INTO memory_evidence(
             id, source_type, trust_level, source_id, source_match_key,
             session_id, execution_id, scope_type, scope_match_key, occurred_at,
             payload_blob_ref, payload_commitment, metadata_blob_ref, metadata_commitment,
             privacy_class, eligibility_state, ingest_sequence, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.id,
          input.input.sourceType,
          input.input.trustLevel,
          toNullable(input.input.sourceId),
          input.sourceMatchKey,
          toNullable(input.input.sessionId),
          toNullable(input.input.executionId),
          input.scopeType,
          input.scopeMatchKey,
          input.input.occurredAt,
          input.payload.blobId,
          input.payload.commitment,
          toNullable(input.metadata?.blobId),
          toNullable(input.metadata?.commitment),
          input.input.privacyClass,
          input.input.eligibilityState ?? 'active',
          sequenceRow.integer_value,
          input.createdAt
        )
      return sequenceRow.integer_value
    })
    const ingestSequence = insert()
    return {
      id: input.id,
      ingestSequence,
      sourceType: input.input.sourceType,
      sourceId: toNullable(input.input.sourceId),
      sourceMatchKey: input.sourceMatchKey,
      sessionId: toNullable(input.input.sessionId),
      executionId: toNullable(input.input.executionId),
      scopeType: input.scopeType,
      scopeMatchKey: input.scopeMatchKey,
      occurredAt: input.input.occurredAt,
      payloadBlobRef: input.payload.blobId,
      payloadCommitment: input.payload.commitment,
      metadataBlobRef: toNullable(input.metadata?.blobId),
      metadataCommitment: toNullable(input.metadata?.commitment),
      privacyClass: input.input.privacyClass,
      eligibilityState: input.input.eligibilityState ?? 'active',
      createdAt: input.createdAt,
    }
  }

  private resolveScope(scope: MemoryEvidenceScopeInputV2): {
    scopeType: string
    scopeMatchKey: Nullable<string>
  } {
    if (scope.type === 'global') return { scopeType: 'global', scopeMatchKey: null }
    if (scope.type === 'workspace') {
      const canonicalPath = canonicalizeWorkspacePathV2(scope.rootPath)
      return {
        scopeType: 'workspace',
        scopeMatchKey: this.identityKeys.workspaceScopeMatchKey(canonicalPath),
      }
    }
    const origin = normalizeOriginV2(scope.origin)
    return {
      scopeType: 'origin',
      scopeMatchKey: this.identityKeys.originScopeMatchKey(origin),
    }
  }

  private readMeta(key: string): number {
    const row = this.authority.database
      .prepare(`SELECT integer_value FROM memory_meta WHERE key = ?`)
      .get(key) as { integer_value: number } | undefined
    if (!row) throw new AppError('INVARIANT', `memory_meta 缺少 ${key}。`)
    return row.integer_value
  }

  private readTrustLevel(evidenceId: string): MemoryEvidenceTrustLevelV2 {
    const row = this.authority.database
      .prepare(`SELECT trust_level FROM memory_evidence WHERE id = ?`)
      .get(evidenceId) as { trust_level: string } | undefined
    if (!row) throw new AppError('INVARIANT', 'Evidence trust_level 在复活时消失。')
    if (
      !['user_stated', 'system_observed', 'agent_derived', 'external_content'].includes(
        row.trust_level
      )
    ) {
      throw new AppError('INVARIANT', 'Evidence trust_level 非法。')
    }
    return row.trust_level as MemoryEvidenceTrustLevelV2
  }

  private randomId(): string {
    const value = this.random(16)
    if (!Buffer.isBuffer(value) || value.length !== 16) {
      throw new AppError('INVARIANT', 'Evidence 随机源必须返回 16 字节。')
    }
    return value.toString('hex')
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

function mapEvidenceRowV2(row: MemoryEvidenceRowV2): MemoryEvidenceRecordV2 {
  if (!row.payload_blob_ref || !row.payload_commitment) {
    throw new AppError('INVARIANT', '未擦除 Evidence 缺少 payload blob。')
  }
  return {
    id: row.id,
    ingestSequence: row.ingest_sequence,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceMatchKey: row.source_match_key,
    sessionId: row.session_id,
    executionId: row.execution_id,
    scopeType: row.scope_type,
    scopeMatchKey: row.scope_match_key,
    occurredAt: row.occurred_at,
    payloadBlobRef: row.payload_blob_ref,
    payloadCommitment: row.payload_commitment,
    metadataBlobRef: row.metadata_blob_ref,
    metadataCommitment: row.metadata_commitment,
    privacyClass: row.privacy_class,
    eligibilityState: row.eligibility_state,
    createdAt: row.created_at,
  }
}

function validateIngestInputV2(input: IngestMemoryEvidenceInputV2): void {
  assertNonEmptyStringV2(input.sourceType, 'sourceType')
  assertNonEmptyStringV2(input.trustLevel, 'trustLevel')
  if (
    !['user_stated', 'system_observed', 'agent_derived', 'external_content'].includes(
      input.trustLevel
    )
  ) {
    throw new AppError('VALIDATION', 'trustLevel 非法。')
  }
  assertNonNegativeSafeIntegerV2(input.occurredAt, 'occurredAt')
  if (!['standard', 'personal', 'sensitive'].includes(input.privacyClass)) {
    throw new AppError('VALIDATION', 'privacyClass 非法。')
  }
  if (
    !isUndefined(input.eligibilityState) &&
    !['active', 'source_deleted', 'excluded'].includes(input.eligibilityState)
  ) {
    throw new AppError('VALIDATION', 'eligibilityState 非法。')
  }
}

function assertNonEmptyStringV2(value: unknown, label: string): asserts value is string {
  if (!isString(value) || value.length === 0) {
    throw new AppError('VALIDATION', `${label} 不得为空。`)
  }
}

function assertNonNegativeSafeIntegerV2(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError('VALIDATION', `${label} 必须是非负安全整数。`)
  }
}
