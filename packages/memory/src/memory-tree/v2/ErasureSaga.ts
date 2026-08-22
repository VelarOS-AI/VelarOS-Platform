import { createHash, randomBytes } from 'node:crypto'

import {
  isArray,
  isEmpty,
  isPlainObject,
  isString,
  isUndefined,
  toNullable,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { MemoryAuthorityDatabaseV2 } from './AuthorityDatabase'
import {
  buildRedactTreeDiffOpV2,
  canonicalStringifyV2,
  type MemoryTreeDiffOpV2,
  type MemoryTreeNodeStructV2,
} from './DiffChain'
import type { ContentKeyServiceV2, MemoryKeyringStoreV2, MemorySealedContentV2 } from './storage'
import type {
  MemoryTreeAuthorityCommitParticipantV2,
  MemoryTreeIdentityChangeV2,
  MemoryTreeStoreV2,
} from './TreeStore'

export type MemoryErasureTargetTypeV2 =
  'evidence' | 'concept' | 'episode' | 'claim' | 'relation' | 'identity_epoch' | 'tree_node'

export interface MemoryErasureTargetV2 {
  readonly type: MemoryErasureTargetTypeV2
  readonly id: string
}

export interface MemoryErasureClosureV2 {
  readonly format: 'velaros.memory.erasure-closure.v2'
  readonly target: MemoryErasureTargetV2
  readonly evidenceIds: readonly string[]
  readonly conceptIds: readonly string[]
  readonly episodeIds: readonly string[]
  readonly claimIds: readonly string[]
  readonly relationIds: readonly string[]
  readonly identityEpochIds: readonly string[]
  readonly treeStableKeys: readonly string[]
  readonly blobIds: readonly string[]
}

export interface MemoryErasurePreviewV2 {
  readonly closure: MemoryErasureClosureV2
  readonly digest: string
  readonly counts: Readonly<Record<string, number>>
}

export interface MemoryErasureConfirmedV2 {
  readonly requestId: string
  readonly redactVersion: number
  readonly privacyGeneration: number
  readonly state: 'confirmed'
}

export interface MemoryErasureStatusV2 {
  readonly requestId: string
  readonly state: 'confirmed' | 'purging' | 'verified' | 'stalled'
  readonly redactVersion: number
  readonly privacyGeneration: number
  readonly verifiedAt: Nullable<number>
}

interface MemoryErasureRequestRowV2 {
  id: string
  closure_json: string
  redact_version: number
  privacy_generation: number
  state: MemoryErasureStatusV2['state']
  verified_at: Nullable<number>
}

interface ActiveIdentityRowV2 {
  id: string
  sequence: number
  supporting_concept_ids_json: string
  supporting_episode_ids_json: string
  supporting_claim_ids_json: string
}

interface ReplacementIdentityV2 {
  id: string
  sequence: number
  predecessorId: Nullable<string>
  statement: MemorySealedContentV2
  globalMainline: MemorySealedContentV2
}

/**
 * 两段式擦除 owner：
 * 1. authority 事务提交 deny-set、墓碑、privacy generation 与 redact tree version；
 * 2. 幂等 crypto-shred、派生代轮换与验证。
 */
export class MemoryErasureServiceV2 {
  constructor(
    private readonly authority: MemoryAuthorityDatabaseV2,
    private readonly contentKeys: ContentKeyServiceV2,
    private readonly keyring: MemoryKeyringStoreV2,
    private readonly treeStore: MemoryTreeStoreV2,
    private readonly random: (byteLength: number) => Buffer = randomBytes
  ) {}

  public preview(target: MemoryErasureTargetV2): MemoryErasurePreviewV2 {
    validateTargetV2(target)
    const closure = this.computeClosure(target)
    const canonical = canonicalStringifyV2(closure)
    return {
      closure,
      digest: createHash('sha256').update(canonical, 'utf8').digest('hex'),
      counts: {
        evidence: closure.evidenceIds.length,
        concept: closure.conceptIds.length,
        episode: closure.episodeIds.length,
        claim: closure.claimIds.length,
        relation: closure.relationIds.length,
        identityEpoch: closure.identityEpochIds.length,
        treeNode: closure.treeStableKeys.length,
        blob: closure.blobIds.length,
      },
    }
  }

  public confirm(
    preview: MemoryErasurePreviewV2,
    confirmedAt = Date.now()
  ): MemoryErasureConfirmedV2 {
    assertNonNegativeIntegerV2(confirmedAt, 'confirmedAt')
    const refreshed = this.preview(preview.closure.target)
    if (
      refreshed.digest !== preview.digest ||
      canonicalStringifyV2(refreshed.closure) !== canonicalStringifyV2(preview.closure)
    ) {
      throw new AppError('CONFLICT', '擦除闭包在确认前已变化，请重新确认。')
    }
    const requestId = this.randomId()
    const currentPrivacyGeneration = this.readMeta('privacy_generation')
    const privacyGeneration = currentPrivacyGeneration + 1
    const nextVersion = this.treeStore.version + 1
    const activeIdentity = this.readActiveIdentity()
    const identityAffected =
      !activeIdentity || preview.closure.identityEpochIds.includes(activeIdentity.id)
    let replacement: Nullable<ReplacementIdentityV2> = null
    try {
      if (identityAffected) replacement = this.prepareReplacementIdentity(activeIdentity)
      const currentNodes = this.treeStore.current.nodes
      const redactionTargets = currentNodes.filter(
        (node) =>
          preview.closure.treeStableKeys.includes(node.stableKey) &&
          node.visibilityState !== 'redacted'
      )
      const ops: MemoryTreeDiffOpV2[] = []
      if (!isEmpty(redactionTargets)) ops.push(buildRedactTreeDiffOpV2(redactionTargets))
      if (this.treeStore.version === 0) ops.push(createRootAddOpV2(confirmedAt))
      if (replacement) ops.push(createIdentityMainlineAddOpV2(replacement, confirmedAt))

      const activeIdentityEpochId = replacement?.id ?? activeIdentity?.id
      if (!activeIdentityEpochId) {
        throw new AppError('INVARIANT', 'Erasure 无法确定提交后的 active identity。')
      }
      const globalMainlineNodeId = `identity:${activeIdentityEpochId}`
      const identityChange: Nullable<MemoryTreeIdentityChangeV2> = replacement
        ? {
            epochId: replacement.id,
            sequence: replacement.sequence,
            predecessorId: replacement.predecessorId,
          }
        : null
      const participant = this.buildFirstPhaseParticipant({
        requestId,
        closure: preview.closure,
        nextVersion,
        currentPrivacyGeneration,
        privacyGeneration,
        replacement,
        confirmedAt,
      })
      this.treeStore.commitVersion({
        expectedBaseVersion: this.treeStore.version,
        ops,
        identityChange,
        activeIdentityEpochId,
        globalMainlineNodeId,
        frontierEvidenceSequence: this.readMeta('dream_frontier'),
        createdByRunId: `erasure:${requestId}`,
        createdAt: confirmedAt,
        authorityCommit: participant,
        erasureCommit: true,
      })
      return {
        requestId,
        redactVersion: nextVersion,
        privacyGeneration,
        state: 'confirmed',
      }
    } catch (error) {
      if (replacement) {
        this.contentKeys.eraseContent(replacement.statement.blobId)
        this.contentKeys.eraseContent(replacement.globalMainline.blobId)
      }
      throw error
    }
  }

  public purge(requestId: string, purgedAt = Date.now()): MemoryErasureStatusV2 {
    assertNonEmptyV2(requestId, 'requestId')
    assertNonNegativeIntegerV2(purgedAt, 'purgedAt')
    const row = this.readRequest(requestId)
    if (row.state === 'verified') return mapErasureStatusV2(row)
    const closure = parseClosureV2(row.closure_json)
    this.authority.database
      .prepare(
        `UPDATE memory_erasure_requests
         SET state = 'purging'
         WHERE id = ? AND state IN ('confirmed', 'stalled', 'purging')`
      )
      .run(requestId)
    try {
      for (const blobId of closure.blobIds) {
        this.contentKeys.eraseContent(blobId)
        this.authority.database
          .prepare(
            `UPDATE memory_content_blobs
             SET state = 'erased', erased_at = COALESCE(erased_at, ?)
             WHERE blob_id = ?`
          )
          .run(purgedAt, blobId)
      }
      const projection = this.treeStore.inspectProjection()
      if (!projection?.matchesAuthority) this.treeStore.rebuildProjection()
      this.verifyPurge(closure)
      const verify = this.authority.database.transaction(() => {
        this.authority.database
          .prepare(
            `UPDATE memory_erasure_targets
             SET state = 'retired'
             WHERE request_id = ? AND state = 'active'`
          )
          .run(requestId)
        const updated = this.authority.database
          .prepare(
            `UPDATE memory_erasure_requests
             SET state = 'verified', verified_at = ?
             WHERE id = ? AND state = 'purging'`
          )
          .run(purgedAt, requestId)
        if (updated.changes !== 1) {
          throw new AppError('CONFLICT', 'Erasure verified 状态 CAS 失败。')
        }
      })
      verify()
    } catch (error) {
      this.authority.database
        .prepare(
          `UPDATE memory_erasure_requests
           SET state = 'stalled'
           WHERE id = ? AND state <> 'verified'`
        )
        .run(requestId)
      throw error
    }
    return this.status(requestId)
  }

  public resumePending(resumedAt = Date.now()): readonly MemoryErasureStatusV2[] {
    const pending = this.authority.database
      .prepare(
        `SELECT id FROM memory_erasure_requests
         WHERE state IN ('confirmed', 'purging', 'stalled')
         ORDER BY created_at, id`
      )
      .all() as Array<{ id: string }>
    return pending.map((row) => this.purge(row.id, resumedAt))
  }

  public status(requestId: string): MemoryErasureStatusV2 {
    return mapErasureStatusV2(this.readRequest(requestId))
  }

  public isDenied(target: MemoryErasureTargetV2): boolean {
    validateTargetV2(target)
    if (
      this.authority.database
        .prepare(
          `SELECT 1
           FROM memory_erasure_targets
           WHERE target_type = ? AND target_id = ? AND state = 'active'
           LIMIT 1`
        )
        .get(target.type, target.id)
    )
      return true
    const tombstoneQueries: Partial<Record<MemoryErasureTargetTypeV2, string>> = {
      evidence: `SELECT 1 FROM memory_evidence WHERE id = ? AND eligibility_state = 'erased'`,
      concept: `SELECT 1 FROM memory_concepts WHERE id = ? AND lifecycle_state = 'erased'`,
      episode: `SELECT 1 FROM memory_episodes WHERE id = ? AND state = 'erased'`,
      claim: `SELECT 1 FROM memory_claims WHERE id = ? AND lifecycle_state = 'erased'`,
      identity_epoch: `SELECT 1 FROM memory_identity_epochs
                       WHERE id = ? AND identity_statement_blob_ref IS NULL`,
    }
    if (target.type === 'relation')
      return !this.authority.database
        .prepare(`SELECT 1 FROM memory_relations WHERE id = ?`)
        .get(target.id)
    if (target.type === 'tree_node')
      return (
        this.treeStore.current.nodes.find((node) => node.stableKey === target.id)
          ?.visibilityState === 'redacted'
      )
    const query = tombstoneQueries[target.type]
    return query ? Boolean(this.authority.database.prepare(query).get(target.id)) : false
  }

  private computeClosure(target: MemoryErasureTargetV2): MemoryErasureClosureV2 {
    assertTargetExistsV2(this.authority, target)
    if (
      target.type === 'tree_node' &&
      !this.treeStore.current.nodes.some((node) => node.stableKey === target.id)
    ) {
      throw new AppError('NOT_FOUND', '擦除目标树节点不存在。', undefined, {
        ...target,
      })
    }
    const evidence = new Set<string>()
    const concepts = new Set<string>()
    const episodes = new Set<string>()
    const claims = new Set<string>()
    const relations = new Set<string>()
    const identities = new Set<string>()
    const treeStableKeys = new Set<string>()

    if (target.type === 'evidence') evidence.add(target.id)
    if (target.type === 'concept') concepts.add(target.id)
    if (target.type === 'episode') episodes.add(target.id)
    if (target.type === 'claim') claims.add(target.id)
    if (target.type === 'relation') relations.add(target.id)
    if (target.type === 'identity_epoch') identities.add(target.id)
    if (target.type === 'tree_node') {
      treeStableKeys.add(target.id)
      const node = this.treeStore.current.nodes.find(
        (candidate) => candidate.stableKey === target.id
      )
      if (node?.subjectType === 'concept') concepts.add(node.subjectId)
      if (node?.subjectType === 'episode') episodes.add(node.subjectId)
      if (node?.subjectType === 'claim') claims.add(node.subjectId)
      if (node?.subjectType === 'identity_epoch') identities.add(node.subjectId)
    }

    if (concepts.size > 0) {
      addColumnValuesV2(
        this.authority,
        episodes,
        `SELECT id FROM memory_episodes WHERE primary_concept_id IN (${placeholdersV2(concepts)})`,
        [...concepts]
      )
      addColumnValuesV2(
        this.authority,
        claims,
        `SELECT id FROM memory_claims WHERE subject_concept_id IN (${placeholdersV2(concepts)})`,
        [...concepts]
      )
    }
    if (target.type === 'evidence') {
      addSolelySupportedObjectsV2(this.authority, target.id, concepts, episodes, claims, relations)
    }
    if (concepts.size > 0) {
      addColumnValuesV2(
        this.authority,
        episodes,
        `SELECT id FROM memory_episodes WHERE primary_concept_id IN (${placeholdersV2(concepts)})`,
        [...concepts]
      )
      addColumnValuesV2(
        this.authority,
        claims,
        `SELECT id FROM memory_claims WHERE subject_concept_id IN (${placeholdersV2(concepts)})`,
        [...concepts]
      )
    }
    addLinkedEvidenceV2(this.authority, 'memory_concept_evidence', 'concept_id', concepts, evidence)
    addLinkedEvidenceV2(this.authority, 'memory_episode_evidence', 'episode_id', episodes, evidence)
    addLinkedEvidenceV2(this.authority, 'memory_claim_evidence', 'claim_id', claims, evidence)
    addLinkedEvidenceV2(
      this.authority,
      'memory_relation_evidence',
      'relation_id',
      relations,
      evidence
    )

    const endpoints = [
      ...[...concepts].map((id) => ['concept', id] as const),
      ...[...episodes].map((id) => ['episode', id] as const),
      ...[...claims].map((id) => ['claim', id] as const),
    ]
    const relationLookup = this.authority.database.prepare(
      `SELECT id FROM memory_relations
       WHERE (source_type = ? AND source_id = ?)
          OR (target_type = ? AND target_id = ?)`
    )
    for (const [kind, id] of endpoints) {
      for (const row of relationLookup.all(kind, id, kind, id) as Array<{
        id: string
      }>) {
        relations.add(row.id)
      }
    }
    addLinkedEvidenceV2(
      this.authority,
      'memory_relation_evidence',
      'relation_id',
      relations,
      evidence
    )

    for (const identity of this.authority.database
      .prepare(
        `SELECT id, supporting_concept_ids_json,
                supporting_episode_ids_json, supporting_claim_ids_json
         FROM memory_identity_epochs`
      )
      .all() as Array<{
      id: string
      supporting_concept_ids_json: string
      supporting_episode_ids_json: string
      supporting_claim_ids_json: string
    }>) {
      if (
        intersectsJsonIdsV2(identity.supporting_concept_ids_json, concepts) ||
        intersectsJsonIdsV2(identity.supporting_episode_ids_json, episodes) ||
        intersectsJsonIdsV2(identity.supporting_claim_ids_json, claims)
      ) {
        identities.add(identity.id)
      }
    }
    for (const node of this.treeStore.current.nodes) {
      if (
        treeStableKeys.has(node.stableKey) ||
        (node.subjectType === 'concept' && concepts.has(node.subjectId)) ||
        (node.subjectType === 'episode' && episodes.has(node.subjectId)) ||
        (node.subjectType === 'claim' && claims.has(node.subjectId)) ||
        (node.subjectType === 'identity_epoch' && identities.has(node.subjectId))
      ) {
        treeStableKeys.add(node.stableKey)
      }
    }

    const blobIds = collectClosureBlobIdsV2(this.authority, {
      evidence,
      concepts,
      episodes,
      claims,
      identities,
    })
    addCandidateLedgerBlobsV2(this.authority, this.contentKeys, evidence, blobIds)
    for (const node of this.treeStore.current.nodes) {
      if (treeStableKeys.has(node.stableKey) && node.content.blobRef) {
        blobIds.add(node.content.blobRef)
      }
    }
    return {
      format: 'velaros.memory.erasure-closure.v2',
      target,
      evidenceIds: sortedV2(evidence),
      conceptIds: sortedV2(concepts),
      episodeIds: sortedV2(episodes),
      claimIds: sortedV2(claims),
      relationIds: sortedV2(relations),
      identityEpochIds: sortedV2(identities),
      treeStableKeys: sortedV2(treeStableKeys),
      blobIds: sortedV2(blobIds),
    }
  }

  private prepareReplacementIdentity(active: Nullable<ActiveIdentityRowV2>): ReplacementIdentityV2 {
    const statement = this.contentKeys.sealContent('我是持续帮助用户的 AI 助手')
    try {
      return {
        id: this.randomId(),
        sequence: (active?.sequence ?? 0) + 1,
        predecessorId: toNullable(active?.id),
        statement,
        globalMainline: this.contentKeys.sealContent('继续根据用户当前目标提供帮助'),
      }
    } catch (error) {
      this.contentKeys.eraseContent(statement.blobId)
      throw error
    }
  }

  private buildFirstPhaseParticipant(input: {
    requestId: string
    closure: MemoryErasureClosureV2
    nextVersion: number
    currentPrivacyGeneration: number
    privacyGeneration: number
    replacement: Nullable<ReplacementIdentityV2>
    confirmedAt: number
  }): MemoryTreeAuthorityCommitParticipantV2 {
    return {
      apply: () => {
        const privacy = this.authority.database
          .prepare(
            `UPDATE memory_meta
             SET integer_value = ?, updated_at = ?
             WHERE key = 'privacy_generation' AND integer_value = ?`
          )
          .run(input.privacyGeneration, input.confirmedAt, input.currentPrivacyGeneration)
        if (privacy.changes !== 1) {
          throw new AppError('CONFLICT', 'privacy_generation CAS 失败。')
        }
        applyAuthorityTombstonesV2(this.authority, input.closure)
        if (input.replacement) {
          registerBlobV2(this.authority, input.replacement.statement, input.confirmedAt)
          registerBlobV2(this.authority, input.replacement.globalMainline, input.confirmedAt)
          if (input.replacement.predecessorId) {
            this.authority.database
              .prepare(
                `UPDATE memory_identity_epochs
                 SET ended_at = COALESCE(ended_at, ?)
                 WHERE id = ?`
              )
              .run(input.confirmedAt, input.replacement.predecessorId)
          }
          this.authority.database
            .prepare(
              `INSERT INTO memory_identity_epochs(
                 id, sequence,
                 identity_statement_blob_ref, identity_statement_commitment,
                 global_mainline_blob_ref, global_mainline_commitment,
                 confidence, predecessor_id, started_at, created_by_run_id, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
            )
            .run(
              input.replacement.id,
              input.replacement.sequence,
              input.replacement.statement.blobId,
              input.replacement.statement.commitment,
              input.replacement.globalMainline.blobId,
              input.replacement.globalMainline.commitment,
              input.replacement.predecessorId,
              input.confirmedAt,
              `erasure:${input.requestId}`,
              input.confirmedAt
            )
        }
      },
      applyAfterSnapshot: () => {
        this.authority.database
          .prepare(
            `INSERT INTO memory_erasure_requests(
               id, target_type, target_id, closure_json,
               redact_version, privacy_generation, state, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?)`
          )
          .run(
            input.requestId,
            input.closure.target.type,
            input.closure.target.id,
            canonicalStringifyV2(input.closure),
            input.nextVersion,
            input.privacyGeneration,
            input.confirmedAt
          )
        const targetInsert = this.authority.database.prepare(
          `INSERT INTO memory_erasure_targets(
             request_id, target_type, target_id, deny_generation, state
           ) VALUES (?, ?, ?, ?, 'active')`
        )
        for (const [targetType, ids] of closureTargetEntriesV2(input.closure)) {
          for (const id of ids) {
            targetInsert.run(input.requestId, targetType, id, input.privacyGeneration)
          }
        }
      },
    }
  }

  private verifyPurge(closure: MemoryErasureClosureV2): void {
    for (const blobId of closure.blobIds) {
      const row = this.authority.database
        .prepare(`SELECT state FROM memory_content_blobs WHERE blob_id = ?`)
        .get(blobId) as { state: string } | undefined
      if (row?.state !== 'erased') {
        throw new AppError('INVARIANT', 'Erasure blob 墓碑验证失败。', undefined, { blobId })
      }
      try {
        this.keyring.getContentDek(blobId).fill(0)
        throw new AppError('INVARIANT', 'Erasure blob 的 DEK 仍可恢复。', undefined, { blobId })
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'MEMORY_DEK_DESTROYED') {
          throw error
        }
      }
    }
    const projection = this.treeStore.inspectProjection()
    if (!projection?.matchesAuthority) {
      throw new AppError('INVARIANT', 'Erasure 后派生树投影未与 authority 会合。')
    }
  }

  private readActiveIdentity(): Nullable<ActiveIdentityRowV2> {
    return toNullable(
      this.authority.database
        .prepare(
          `SELECT id, sequence,
                  supporting_concept_ids_json,
                  supporting_episode_ids_json,
                  supporting_claim_ids_json
           FROM memory_identity_epochs
           WHERE ended_at IS NULL
           LIMIT 1`
        )
        .get() as ActiveIdentityRowV2 | undefined
    )
  }

  private readMeta(key: string): number {
    const value = this.authority.database
      .prepare(`SELECT integer_value FROM memory_meta WHERE key = ?`)
      .pluck()
      .get(key) as number | undefined
    if (isUndefined(value)) throw new AppError('INVARIANT', `memory_meta 缺少 ${key}。`)
    return value
  }

  private readRequest(requestId: string): MemoryErasureRequestRowV2 {
    const row = this.authority.database
      .prepare(`SELECT * FROM memory_erasure_requests WHERE id = ?`)
      .get(requestId) as MemoryErasureRequestRowV2 | undefined
    if (!row)
      throw new AppError('NOT_FOUND', 'Erasure request 不存在。', undefined, {
        requestId,
      })
    return row
  }

  private randomId(): string {
    const value = this.random(16)
    if (!Buffer.isBuffer(value) || value.length !== 16) {
      throw new AppError('INVARIANT', 'Erasure 随机源必须返回 16 字节。')
    }
    return value.toString('hex')
  }
}

function applyAuthorityTombstonesV2(
  authority: MemoryAuthorityDatabaseV2,
  closure: MemoryErasureClosureV2
): void {
  runForIdsV2(
    authority,
    `UPDATE memory_evidence
     SET eligibility_state = 'erased',
         source_match_key = NULL, scope_match_key = NULL,
         payload_blob_ref = NULL, payload_commitment = NULL,
         metadata_blob_ref = NULL, metadata_commitment = NULL
     WHERE id IN`,
    closure.evidenceIds
  )
  runForIdsV2(
    authority,
    `DELETE FROM memory_concept_aliases WHERE concept_id IN`,
    closure.conceptIds
  )
  runForIdsV2(
    authority,
    `UPDATE memory_concepts
     SET lifecycle_state = 'erased',
         name_blob_ref = NULL, name_commitment = NULL, name_match_key = NULL,
         description_blob_ref = NULL, description_commitment = NULL
     WHERE id IN`,
    closure.conceptIds
  )
  runForIdsV2(
    authority,
    `UPDATE memory_episodes
     SET state = 'erased',
         title_blob_ref = NULL, title_commitment = NULL,
         summary_blob_ref = NULL, summary_commitment = NULL,
         result_blob_ref = NULL, result_commitment = NULL
     WHERE id IN`,
    closure.episodeIds
  )
  runForIdsV2(
    authority,
    `UPDATE memory_claims
     SET lifecycle_state = 'erased',
         value_blob_ref = NULL, value_commitment = NULL,
         summary_blob_ref = NULL, summary_commitment = NULL
     WHERE id IN`,
    closure.claimIds
  )
  runForIdsV2(
    authority,
    `UPDATE memory_identity_epochs
     SET identity_statement_blob_ref = NULL,
         identity_statement_commitment = NULL,
         global_mainline_blob_ref = NULL,
         global_mainline_commitment = NULL,
         supporting_concept_ids_json = '[]',
         supporting_episode_ids_json = '[]',
         supporting_claim_ids_json = '[]'
     WHERE id IN`,
    closure.identityEpochIds
  )
  runForIdsV2(authority, `DELETE FROM memory_relations WHERE id IN`, closure.relationIds)
}

function addSolelySupportedObjectsV2(
  authority: MemoryAuthorityDatabaseV2,
  evidenceId: string,
  concepts: Set<string>,
  episodes: Set<string>,
  claims: Set<string>,
  relations: Set<string>
): void {
  const definitions = [
    ['memory_concept_evidence', 'concept_id', concepts],
    ['memory_episode_evidence', 'episode_id', episodes],
    ['memory_claim_evidence', 'claim_id', claims],
    ['memory_relation_evidence', 'relation_id', relations],
  ] as const
  for (const [table, idColumn, target] of definitions) {
    const rows = authority.database
      .prepare(
        `SELECT ${idColumn} AS id
         FROM ${table}
         WHERE evidence_id = ?
           AND (SELECT count(*) FROM ${table} all_links
                WHERE all_links.${idColumn} = ${table}.${idColumn}) = 1`
      )
      .all(evidenceId) as Array<{ id: string }>
    for (const row of rows) target.add(row.id)
  }
}

function addLinkedEvidenceV2(
  authority: MemoryAuthorityDatabaseV2,
  table: string,
  idColumn: string,
  ids: ReadonlySet<string>,
  evidence: Set<string>
): void {
  if (ids.size === 0) return
  const rows = authority.database
    .prepare(
      `SELECT evidence_id AS id FROM ${table}
       WHERE ${idColumn} IN (${placeholdersV2(ids)})`
    )
    .all(...ids) as Array<{ id: string }>
  for (const row of rows) evidence.add(row.id)
}

function collectClosureBlobIdsV2(
  authority: MemoryAuthorityDatabaseV2,
  sets: {
    evidence: ReadonlySet<string>
    concepts: ReadonlySet<string>
    episodes: ReadonlySet<string>
    claims: ReadonlySet<string>
    identities: ReadonlySet<string>
  }
): Set<string> {
  const blobs = new Set<string>()
  collectBlobColumnsV2(
    authority,
    'memory_evidence',
    'id',
    sets.evidence,
    ['payload_blob_ref', 'metadata_blob_ref'],
    blobs
  )
  collectBlobColumnsV2(
    authority,
    'memory_concepts',
    'id',
    sets.concepts,
    ['name_blob_ref', 'description_blob_ref'],
    blobs
  )
  collectBlobColumnsV2(
    authority,
    'memory_concept_aliases',
    'concept_id',
    sets.concepts,
    ['alias_blob_ref'],
    blobs
  )
  collectBlobColumnsV2(
    authority,
    'memory_episodes',
    'id',
    sets.episodes,
    ['title_blob_ref', 'summary_blob_ref', 'result_blob_ref'],
    blobs
  )
  collectBlobColumnsV2(
    authority,
    'memory_claims',
    'id',
    sets.claims,
    ['value_blob_ref', 'summary_blob_ref'],
    blobs
  )
  collectBlobColumnsV2(
    authority,
    'memory_identity_epochs',
    'id',
    sets.identities,
    ['identity_statement_blob_ref', 'global_mainline_blob_ref'],
    blobs
  )
  return blobs
}

function addCandidateLedgerBlobsV2(
  authority: MemoryAuthorityDatabaseV2,
  contentKeys: ContentKeyServiceV2,
  evidenceIds: ReadonlySet<string>,
  blobIds: Set<string>
): void {
  if (evidenceIds.size === 0) return
  const ledgers = authority.database
    .prepare(
      `SELECT candidate_ledger_blob_ref AS blob_ref,
              candidate_ledger_commitment AS commitment
       FROM memory_dream_runs run
       JOIN memory_content_blobs blob
         ON blob.blob_id = run.candidate_ledger_blob_ref
        AND blob.state = 'active'
       WHERE candidate_ledger_blob_ref IS NOT NULL
         AND candidate_ledger_commitment IS NOT NULL`
    )
    .all() as Array<{ blob_ref: string; commitment: string }>
  for (const ledger of ledgers) {
    const plaintext = contentKeys.openContent(ledger.blob_ref, ledger.commitment)
    try {
      let parsed: unknown
      try {
        parsed = JSON.parse(plaintext.toString('utf8'))
      } catch (error) {
        throw new AppError('INVARIANT', 'Candidate ledger JSON 损坏。', error)
      }
      if (
        isPlainObject(parsed) &&
        isArray((parsed as Record<string, unknown>)['readSet']) &&
        ((parsed as Record<string, unknown>)['readSet'] as unknown[]).some(
          (id) => isString(id) && evidenceIds.has(id)
        )
      ) {
        blobIds.add(ledger.blob_ref)
      }
    } finally {
      plaintext.fill(0)
    }
  }
}

function collectBlobColumnsV2(
  authority: MemoryAuthorityDatabaseV2,
  table: string,
  idColumn: string,
  ids: ReadonlySet<string>,
  columns: readonly string[],
  target: Set<string>
): void {
  if (ids.size === 0) return
  const rows = authority.database
    .prepare(
      `SELECT ${columns.join(', ')} FROM ${table}
       WHERE ${idColumn} IN (${placeholdersV2(ids)})`
    )
    .all(...ids) as Array<Record<string, Nullable<string>>>
  for (const row of rows) {
    for (const column of columns) {
      const value = row[column]
      if (value) target.add(value)
    }
  }
}

function createRootAddOpV2(createdAt: number): MemoryTreeDiffOpV2 {
  return {
    type: 'add',
    before: [],
    after: [
      {
        stableKey: 'root',
        parentKey: null,
        nodeType: 'root',
        namespace: 'root',
        subjectType: 'root',
        subjectId: 'root',
        content: {
          blobRef: null,
          commitment: `c2:${'0'.repeat(64)}`,
          redacted: false,
        },
        mainlineScore: 1,
        confidence: 1,
        activation: 1,
        firstSeenAt: createdAt,
        lastActiveAt: createdAt,
        visibilityState: 'active',
      },
    ],
  }
}

function createIdentityMainlineAddOpV2(
  identity: ReplacementIdentityV2,
  createdAt: number
): MemoryTreeDiffOpV2 {
  const node: MemoryTreeNodeStructV2 = {
    stableKey: `identity:${identity.id}`,
    parentKey: 'root',
    nodeType: 'mainline',
    namespace: 'identity',
    subjectType: 'identity_epoch',
    subjectId: identity.id,
    content: {
      blobRef: identity.globalMainline.blobId,
      commitment: identity.globalMainline.commitment,
      redacted: false,
    },
    mainlineScore: 1,
    confidence: 0,
    activation: 1,
    firstSeenAt: createdAt,
    lastActiveAt: createdAt,
    visibilityState: 'active',
  }
  return { type: 'add', before: [], after: [node] }
}

function closureTargetEntriesV2(
  closure: MemoryErasureClosureV2
): ReadonlyArray<readonly [string, readonly string[]]> {
  return [
    ['evidence', closure.evidenceIds],
    ['concept', closure.conceptIds],
    ['episode', closure.episodeIds],
    ['claim', closure.claimIds],
    ['relation', closure.relationIds],
    ['identity_epoch', closure.identityEpochIds],
    ['tree_node', closure.treeStableKeys],
    ['blob', closure.blobIds],
  ]
}

function assertTargetExistsV2(
  authority: MemoryAuthorityDatabaseV2,
  target: MemoryErasureTargetV2
): void {
  const tableByType: Partial<Record<MemoryErasureTargetTypeV2, string>> = {
    evidence: 'memory_evidence',
    concept: 'memory_concepts',
    episode: 'memory_episodes',
    claim: 'memory_claims',
    relation: 'memory_relations',
    identity_epoch: 'memory_identity_epochs',
  }
  if (target.type === 'tree_node') return
  const table = tableByType[target.type]
  if (!table || !authority.database.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(target.id)) {
    throw new AppError('NOT_FOUND', '擦除目标不存在。', undefined, {
      ...target,
    })
  }
}

function isMemoryErasureTargetV2(value: unknown): value is MemoryErasureTargetV2 {
  if (!isPlainObject(value) || !isString(value['id'])) return false
  switch (value['type']) {
    case 'evidence':
    case 'concept':
    case 'episode':
    case 'claim':
    case 'relation':
    case 'identity_epoch':
    case 'tree_node':
      return true
    default:
      return false
  }
}

function isStringArrayV2(value: unknown): value is readonly string[] {
  return isArray(value) && value.every(isString)
}

function isMemoryErasureClosureV2(value: unknown): value is MemoryErasureClosureV2 {
  return (
    isPlainObject(value) &&
    value['format'] === 'velaros.memory.erasure-closure.v2' &&
    isMemoryErasureTargetV2(value['target']) &&
    isStringArrayV2(value['evidenceIds']) &&
    isStringArrayV2(value['conceptIds']) &&
    isStringArrayV2(value['episodeIds']) &&
    isStringArrayV2(value['claimIds']) &&
    isStringArrayV2(value['relationIds']) &&
    isStringArrayV2(value['identityEpochIds']) &&
    isStringArrayV2(value['treeStableKeys']) &&
    isStringArrayV2(value['blobIds'])
  )
}

function parseClosureV2(raw: string): MemoryErasureClosureV2 {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new AppError('INVARIANT', 'Erasure closure JSON 损坏。', error)
  }
  if (!isMemoryErasureClosureV2(parsed)) {
    throw new AppError('INVARIANT', 'Erasure closure 格式非法。')
  }
  if (raw !== canonicalStringifyV2(parsed)) {
    throw new AppError('INVARIANT', 'Erasure closure 不是 canonical 字节。')
  }
  return parsed
}

function mapErasureStatusV2(row: MemoryErasureRequestRowV2): MemoryErasureStatusV2 {
  return {
    requestId: row.id,
    state: row.state,
    redactVersion: row.redact_version,
    privacyGeneration: row.privacy_generation,
    verifiedAt: row.verified_at,
  }
}

function addColumnValuesV2(
  authority: MemoryAuthorityDatabaseV2,
  target: Set<string>,
  sql: string,
  params: readonly string[]
): void {
  if (params.length === 0) return
  for (const row of authority.database.prepare(sql).all(...params) as Array<{
    id: string
  }>) {
    target.add(row.id)
  }
}

function runForIdsV2(
  authority: MemoryAuthorityDatabaseV2,
  sqlPrefix: string,
  ids: readonly string[]
): void {
  if (ids.length === 0) return
  authority.database.prepare(`${sqlPrefix} (${placeholdersV2(ids)})`).run(...ids)
}

function placeholdersV2(values: ReadonlySet<string> | readonly string[]): string {
  return [...values].map(() => '?').join(', ')
}

function intersectsJsonIdsV2(raw: string, values: ReadonlySet<string>): boolean {
  if (values.size === 0) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new AppError('INVARIANT', 'Identity support ids JSON 损坏。', error)
  }
  if (!isArray(parsed) || !parsed.every((item) => isString(item))) {
    throw new AppError('INVARIANT', 'Identity support ids 必须是字符串数组。')
  }
  return parsed.some((item) => values.has(item))
}

function registerBlobV2(
  authority: MemoryAuthorityDatabaseV2,
  blob: MemorySealedContentV2,
  createdAt: number
): void {
  authority.database
    .prepare(
      `INSERT INTO memory_content_blobs(blob_id, byte_length, state, created_at)
       VALUES (?, ?, 'active', ?)`
    )
    .run(blob.blobId, blob.byteLength, createdAt)
}

function sortedV2(values: ReadonlySet<string>): readonly string[] {
  return [...values].sort()
}

function validateTargetV2(target: MemoryErasureTargetV2): void {
  const types: readonly string[] = [
    'evidence',
    'concept',
    'episode',
    'claim',
    'relation',
    'identity_epoch',
    'tree_node',
  ]
  if (!types.includes(target.type) || !target.id) {
    throw new AppError('VALIDATION', '擦除目标形态非法。')
  }
}

function assertNonEmptyV2(value: string, label: string): void {
  if (!value) throw new AppError('VALIDATION', `${label} 不得为空。`)
}

function assertNonNegativeIntegerV2(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError('VALIDATION', `${label} 必须是非负安全整数。`)
  }
}
