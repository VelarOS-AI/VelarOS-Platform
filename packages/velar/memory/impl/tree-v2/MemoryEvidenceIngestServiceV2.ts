import { randomBytes } from 'node:crypto'

import { isUndefined, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  IngestMemoryEvidenceInputV2,
  MemoryBlobIdRowV2,
  MemoryEvidenceRecordV2,
  MemoryEvidenceRowV2,
  MemoryEvidenceScopeInputV2,
  MemoryEvidenceTrustLevelV2,
  MemoryResolvedEvidenceScopeV2,
  MemoryTrustLevelRowV2,
  ReactivateMemoryEvidenceResultV2,
} from '../../types/tree-v2/evidence.js'
import type { MemorySealedContentV2 } from '../../types/tree-v2/storage.js'
import type { MemoryMetaIntegerRowV2 } from '../../types/tree-v2/store.js'
import {
  assertNonEmptyStringV2,
  assertNonNegativeSafeIntegerV2,
  registerMemoryContentBlobV2,
} from '../../utils/tree-v2/checks.js'
import { canonicalStringifyV2 } from '../../utils/tree-v2/diff-chain.js'
import {
  isMemoryEvidenceTrustLevelV2,
  mapEvidenceRowV2,
  validateIngestInputV2,
} from '../../utils/tree-v2/evidence-ingest.js'
import {
  canonicalizeWorkspacePathV2,
  normalizeOriginV2,
} from '../../utils/tree-v2/identity-keys.js'
import { readMemoryMetaV2 } from '../../utils/tree-v2/tree-store.js'

import type { ContentKeyServiceV2Api } from './storage/ContentKeyServiceV2.js'
import type { MemoryBlobStoreV2Api } from './storage/MemoryBlobStoreV2.js'
import type { MemoryAuthorityDatabaseV2Api } from './MemoryAuthorityDatabaseV2.js'
import type { MemoryIdentityKeyServiceV2Api } from './MemoryIdentityKeyServiceV2.js'

/**
 * 证据的唯一采集入口：先密封正文与元数据，再在一个权威事务里分配序号、登记 blob 与写行。
 *
 * 密文先落盘、权威行后提交，所以崩溃窗口里可能留下没人引用的 blob；
 * `recoverOrphanedBlobs` 在打开时把它们擦掉。实例归 `MemorySystemRuntimeV2`（或探针）所有。
 */
export interface MemoryEvidenceIngestServiceV2Api {
  /**
   * 采集一条证据：校验 → 解析作用域 → 封正文与元数据 → 单事务分配序号并写行。
   * 入参不合法抛 VALIDATION；写行失败会把刚封的密文擦掉再上抛。
   */
  ingest(input: IngestMemoryEvidenceInputV2): MemoryEvidenceRecordV2
  /**
   * 恢复一条不合格的证据。
   * 序号在 frontier 之上就原地翻活；已经被消化过的则解密重封成一条新序号的证据（I6）。
   * 证据不存在抛 NOT_FOUND，已是 active 抛 CONFLICT，erased 是终态抛 VALIDATION。
   */
  reactivate(evidenceId: string, createdAt?: number): ReactivateMemoryEvidenceResultV2
  /** 擦掉物理上存在但权威库里没登记的孤儿 blob，返回清掉的个数。 */
  recoverOrphanedBlobs(): number
}

export class MemoryEvidenceIngestServiceV2 implements MemoryEvidenceIngestServiceV2Api {
  /** 证据 id 的随机字节数（128 位）。 */
  private static readonly EvidenceIdByteLength = 16

  constructor(
    private readonly authority: MemoryAuthorityDatabaseV2Api,
    private readonly contentKeys: ContentKeyServiceV2Api,
    private readonly identityKeys: MemoryIdentityKeyServiceV2Api,
    private readonly blobs: MemoryBlobStoreV2Api,
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
      return this.insertEvidence({
        id: this.randomId(),
        input,
        scopeType: scope.scopeType,
        scopeMatchKey: scope.scopeMatchKey,
        sourceMatchKey,
        payload,
        metadata,
        createdAt: input.createdAt ?? Date.now(),
      })
    } catch (error) {
      this.contentKeys.eraseContent(payload.blobId)
      if (metadata) this.contentKeys.eraseContent(metadata.blobId)
      throw error
    }
  }

  public reactivate(evidenceId: string, createdAt = Date.now()): ReactivateMemoryEvidenceResultV2 {
    assertNonEmptyStringV2(evidenceId, 'evidenceId')
    assertNonNegativeSafeIntegerV2(createdAt, 'createdAt')
    const row = this.authority.database
      .prepare(`SELECT * FROM memory_evidence WHERE id = ?`)
      .get(evidenceId) as MemoryEvidenceRowV2 | undefined
    if (!row) {
      throw new AppError('NOT_FOUND', '待恢复 Evidence 不存在。', undefined, {
        evidenceId,
      })
    }
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
    const frontier = readMemoryMetaV2(this.authority.database, 'dream_frontier')
    if (row.ingest_sequence > frontier) return this.reactivateInPlace(row, frontier)
    if (!row.payload_blob_ref || !row.payload_commitment) {
      throw new AppError('INVARIANT', '可逆 Evidence 缺少 payload blob。', undefined, {
        evidenceId,
      })
    }
    return this.reingestFromCiphertext(row, createdAt)
  }

  public recoverOrphanedBlobs(): number {
    const registered = new Set(
      (
        this.authority.database
          .prepare(`SELECT blob_id FROM memory_content_blobs`)
          .all() as MemoryBlobIdRowV2[]
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

  /** frontier 之上的不合格行还没被消化过，直接 CAS 改回 active 即可。 */
  private reactivateInPlace(
    row: MemoryEvidenceRowV2,
    frontier: number
  ): ReactivateMemoryEvidenceResultV2 {
    const updated = this.authority.database
      .prepare(
        `UPDATE memory_evidence
         SET eligibility_state = 'active'
         WHERE id = ? AND ingest_sequence > ? AND eligibility_state IN ('excluded', 'source_deleted')`
      )
      .run(row.id, frontier)
    if (updated.changes !== 1) {
      throw new AppError('CONFLICT', 'Evidence 原地恢复 CAS 失败。', undefined, {
        evidenceId: row.id,
      })
    }
    return {
      mode: 'in_place',
      evidence: mapEvidenceRowV2({ ...row, eligibility_state: 'active' }),
    }
  }

  /**
   * I6：frontier 以下的行不原地翻活——解开密文重新密封成一条新序号证据，
   * 让它像新证据一样重新排队被消化。旧行保持原状，历史不被改写。
   */
  private reingestFromCiphertext(
    row: MemoryEvidenceRowV2,
    createdAt: number
  ): ReactivateMemoryEvidenceResultV2 {
    const payload = this.contentKeys.openContent(
      row.payload_blob_ref as string,
      row.payload_commitment as string
    )
    const metadata =
      row.metadata_blob_ref && row.metadata_commitment
        ? this.contentKeys.openContent(row.metadata_blob_ref, row.metadata_commitment)
        : null
    try {
      const resealedPayload = this.contentKeys.sealContent(payload)
      let resealedMetadata: Nullable<MemorySealedContentV2> = null
      try {
        if (metadata) resealedMetadata = this.contentKeys.sealContent(metadata)
        return {
          mode: 'reingested',
          evidence: this.insertEvidence({
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
          }),
        }
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

  /** 单事务：递增采集序号、登记两个 blob、写证据行；序号 meta 缺失就是库被动过。 */
  private insertEvidence(input: MemoryEvidenceIngestServiceV2InsertInput): MemoryEvidenceRecordV2 {
    assertNonNegativeSafeIntegerV2(input.createdAt, 'createdAt')
    const database = this.authority.database
    const eligibilityState = input.input.eligibilityState ?? 'active'
    const insert = database.transaction(() => {
      const sequenceRow = database
        .prepare(
          `UPDATE memory_meta
           SET integer_value = integer_value + 1, updated_at = ?
           WHERE key = 'evidence_ingest_sequence'
           RETURNING integer_value`
        )
        .get(input.createdAt) as MemoryMetaIntegerRowV2 | undefined
      if (!sequenceRow) {
        throw new AppError('INVARIANT', 'evidence_ingest_sequence meta 缺失。')
      }
      registerMemoryContentBlobV2(database, input.payload, input.createdAt)
      if (input.metadata) registerMemoryContentBlobV2(database, input.metadata, input.createdAt)
      database
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
          eligibilityState,
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
      eligibilityState,
      createdAt: input.createdAt,
    }
  }

  /** 把采集入参里的作用域解析成落库的类型名与盲索引键。 */
  private resolveScope(scope: MemoryEvidenceScopeInputV2): MemoryResolvedEvidenceScopeV2 {
    if (scope.type === 'global') return { scopeType: 'global', scopeMatchKey: null }
    if (scope.type === 'workspace') return {
        scopeType: 'workspace',
        scopeMatchKey: this.identityKeys.workspaceScopeMatchKey(
          canonicalizeWorkspacePathV2(scope.rootPath)
        ),
      }
    return {
      scopeType: 'origin',
      scopeMatchKey: this.identityKeys.originScopeMatchKey(normalizeOriginV2(scope.origin)),
    }
  }

  /** 重封时把旧行的信任级别读回来；读不到或值非法都是不变量破坏。 */
  private readTrustLevel(evidenceId: string): MemoryEvidenceTrustLevelV2 {
    const row = this.authority.database
      .prepare(`SELECT trust_level FROM memory_evidence WHERE id = ?`)
      .get(evidenceId) as MemoryTrustLevelRowV2 | undefined
    if (!row) throw new AppError('INVARIANT', 'Evidence trust_level 在复活时消失。')
    if (!isMemoryEvidenceTrustLevelV2(row.trust_level)) {
      throw new AppError('INVARIANT', 'Evidence trust_level 非法。')
    }
    return row.trust_level
  }

  /** 从注入的随机源取证据 id；长度不对就是随机源坏了。 */
  private randomId(): string {
    const value = this.random(MemoryEvidenceIngestServiceV2.EvidenceIdByteLength)
    if (
      !Buffer.isBuffer(value) ||
      value.length !== MemoryEvidenceIngestServiceV2.EvidenceIdByteLength
    ) {
      throw new AppError('INVARIANT', 'Evidence 随机源必须返回 16 字节。')
    }
    return value.toString('hex')
  }
}

/** 写一行证据要的全部材料（已经封好的密文引用加上解析好的作用域）。 */
export interface MemoryEvidenceIngestServiceV2InsertInput {
  /** 新证据的 id。 */
  readonly id: string
  /** 原始采集入参（正文字段此时已经封好，不再使用）。 */
  readonly input: IngestMemoryEvidenceInputV2
  /** 解析后的作用域类型。 */
  readonly scopeType: string
  /** 解析后的作用域盲索引键。 */
  readonly scopeMatchKey: Nullable<string>
  /** 来源引用的盲索引键。 */
  readonly sourceMatchKey: Nullable<string>
  /** 封好的正文。 */
  readonly payload: MemorySealedContentV2
  /** 封好的元数据；没有就是 null。 */
  readonly metadata: Nullable<MemorySealedContentV2>
  /** 落库时刻（毫秒）。 */
  readonly createdAt: number
}
