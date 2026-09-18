import { createHash, randomBytes } from 'node:crypto'

import { isEmpty, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { MemoryTreeDiffOpV2 } from '../../types/tree-v2/diff.js'
import type {
  ActiveIdentityRowV2,
  MemoryErasureClosureV2,
  MemoryErasureConfirmedV2,
  MemoryErasureFirstPhaseInputV2,
  MemoryErasurePreviewV2,
  MemoryErasureRequestRowV2,
  MemoryErasureStatusV2,
  MemoryErasureTargetTypeV2,
  MemoryErasureTargetV2,
  MemoryIdentitySupportRowV2,
  MemoryIdRowV2,
  ReplacementIdentityV2,
} from '../../types/tree-v2/erasure.js'
import type { MemoryBlobStateRowV2, MemoryTreeIdentityChangeV2 } from '../../types/tree-v2/store.js'
import type { MemoryTreeAuthorityCommitParticipantV2 } from '../../types/tree-v2/store.js'
import {
  assertNonEmptyStringV2,
  assertNonNegativeSafeIntegerV2,
  registerMemoryContentBlobV2,
} from '../../utils/tree-v2/checks.js'
import { buildRedactTreeDiffOpV2, canonicalStringifyV2 } from '../../utils/tree-v2/diff-chain.js'
import {
  addCandidateLedgerBlobsV2,
  addColumnValuesV2,
  addLinkedEvidenceV2,
  addSolelySupportedObjectsV2,
  applyAuthorityTombstonesV2,
  assertTargetExistsV2,
  closureTargetEntriesV2,
  collectClosureBlobIdsV2,
  createIdentityMainlineAddOpV2,
  createRootAddOpV2,
  intersectsJsonIdsV2,
  mapErasureStatusV2,
  MemoryErasureClosureFormatV2,
  parseClosureV2,
  placeholdersV2,
  sortedV2,
  validateTargetV2,
} from '../../utils/tree-v2/erasure.js'
import { readMemoryMetaV2 } from '../../utils/tree-v2/tree-store.js'

import type { ContentKeyServiceV2Api } from './storage/ContentKeyServiceV2.js'
import type { MemoryKeyringStoreV2Api } from './storage/MemoryKeyringStoreV2.js'
import type { MemoryAuthorityDatabaseV2Api } from './MemoryAuthorityDatabaseV2.js'
import type { MemoryTreeStoreV2Api } from './MemoryTreeStoreV2.js'

/**
 * 彻底清除的两段式 saga owner。
 *
 * 第一段在一个权威事务里落 deny-set、墓碑、隐私代与 redact 树版本；
 * 第二段幂等地 crypto-shred、轮换派生代并验证——第一段成功以后，第二段随时可以重跑。
 * 实例归 `MemorySystemRuntimeV2`（或探针）所有。
 */
export interface MemoryErasureServiceV2Api {
  /**
   * 算一个目标的牵连闭包与摘要，不改任何东西。
   * 目标形态非法抛 VALIDATION，目标不存在抛 NOT_FOUND。
   */
  preview(target: MemoryErasureTargetV2): MemoryErasurePreviewV2
  /**
   * 第一段：重算闭包核对没变，然后在一个权威事务里提交 redact 树版本、deny-set、
   * 墓碑与隐私代；牵连到当前身份时顺带换一个中性接续身份。
   * 闭包在确认前变了抛 CONFLICT。
   */
  confirm(preview: MemoryErasurePreviewV2, confirmedAt?: number): MemoryErasureConfirmedV2
  /**
   * 第二段：幂等 crypto-shred 全部 blob、必要时重建派生投影，再验证并收口成 verified。
   * 已 verified 直接返回；中途失败把请求标成 stalled 并上抛，之后可以重跑。
   */
  purge(requestId: string, purgedAt?: number): MemoryErasureStatusV2
  /** 把所有还没 verified 的请求按创建序重跑一遍第二段，返回各自的最终状态。 */
  resumePending(resumedAt?: number): readonly MemoryErasureStatusV2[]
  /** 读一次擦除请求的当前状态；请求不存在抛 NOT_FOUND。 */
  status(requestId: string): MemoryErasureStatusV2
  /** 这个目标是不是已经在 deny-set 里或已经打上墓碑（两条判据取或）。 */
  isDenied(target: MemoryErasureTargetV2): boolean
}

export class MemoryErasureServiceV2 implements MemoryErasureServiceV2Api {
  /** 请求 id 的随机字节数（128 位）。 */
  private static readonly RequestIdByteLength = 16

  /** 换身份时顶上去的中性身份陈述。 */
  private static readonly NeutralIdentityStatement = '我是持续帮助用户的 AI 助手'

  /** 换身份时顶上去的中性全局主线。 */
  private static readonly NeutralGlobalMainline = '继续根据用户当前目标提供帮助'

  constructor(
    private readonly authority: MemoryAuthorityDatabaseV2Api,
    private readonly contentKeys: ContentKeyServiceV2Api,
    private readonly keyring: MemoryKeyringStoreV2Api,
    private readonly treeStore: MemoryTreeStoreV2Api,
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
    assertNonNegativeSafeIntegerV2(confirmedAt, 'confirmedAt')
    const refreshed = this.preview(preview.closure.target)
    if (
      refreshed.digest !== preview.digest ||
      canonicalStringifyV2(refreshed.closure) !== canonicalStringifyV2(preview.closure)
    ) {
      throw new AppError('CONFLICT', '擦除闭包在确认前已变化，请重新确认。')
    }
    const requestId = this.randomId()
    const currentPrivacyGeneration = readMemoryMetaV2(this.authority.database, 'privacy_generation')
    const privacyGeneration = currentPrivacyGeneration + 1
    const nextVersion = this.treeStore.version + 1
    const activeIdentity = this.readActiveIdentity()
    const identityAffected =
      !activeIdentity || preview.closure.identityEpochIds.includes(activeIdentity.id)
    let replacement: Nullable<ReplacementIdentityV2> = null
    try {
      if (identityAffected) replacement = this.prepareReplacementIdentity(activeIdentity)
      const ops = this.buildRedactOps(preview.closure, replacement, confirmedAt)

      const activeIdentityEpochId = replacement?.id ?? activeIdentity?.id
      if (!activeIdentityEpochId) {
        throw new AppError('INVARIANT', 'Erasure 无法确定提交后的 active identity。')
      }
      const identityChange: Nullable<MemoryTreeIdentityChangeV2> = replacement
        ? {
            epochId: replacement.id,
            sequence: replacement.sequence,
            predecessorId: replacement.predecessorId,
          }
        : null
      this.treeStore.commitVersion({
        expectedBaseVersion: this.treeStore.version,
        ops,
        identityChange,
        activeIdentityEpochId,
        globalMainlineNodeId: `identity:${activeIdentityEpochId}`,
        frontierEvidenceSequence: readMemoryMetaV2(this.authority.database, 'dream_frontier'),
        createdByRunId: `erasure:${requestId}`,
        createdAt: confirmedAt,
        authorityCommit: this.buildFirstPhaseParticipant({
          requestId,
          closure: preview.closure,
          nextVersion,
          currentPrivacyGeneration,
          privacyGeneration,
          replacement,
          confirmedAt,
        }),
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
    assertNonEmptyStringV2(requestId, 'requestId')
    assertNonNegativeSafeIntegerV2(purgedAt, 'purgedAt')
    const row = this.readRequest(requestId)
    if (row.state === 'verified') return mapErasureStatusV2(row)
    const closure = parseClosureV2(row.closure_json)
    const database = this.authority.database
    database
      .prepare(
        `UPDATE memory_erasure_requests
         SET state = 'purging'
         WHERE id = ? AND state IN ('confirmed', 'stalled', 'purging')`
      )
      .run(requestId)
    try {
      for (const blobId of closure.blobIds) {
        this.contentKeys.eraseContent(blobId)
        database
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
      const verify = database.transaction(() => {
        database
          .prepare(
            `UPDATE memory_erasure_targets
             SET state = 'retired'
             WHERE request_id = ? AND state = 'active'`
          )
          .run(requestId)
        const updated = database
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
      database
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
      .all() as MemoryIdRowV2[]
    return pending.map((row) => this.purge(row.id, resumedAt))
  }

  public status(requestId: string): MemoryErasureStatusV2 {
    return mapErasureStatusV2(this.readRequest(requestId))
  }

  public isDenied(target: MemoryErasureTargetV2): boolean {
    validateTargetV2(target)
    const database = this.authority.database
    if (
      database
        .prepare(
          `SELECT 1
           FROM memory_erasure_targets
           WHERE target_type = ? AND target_id = ? AND state = 'active'
           LIMIT 1`
        )
        .get(target.type, target.id)
    ) return true
    if (target.type === 'relation') return !database.prepare(`SELECT 1 FROM memory_relations WHERE id = ?`).get(target.id)
    if (target.type === 'tree_node') return (
        this.treeStore.current.nodes.find((node) => node.stableKey === target.id)
          ?.visibilityState === 'redacted'
      )
    const tombstoneQueries: Partial<Record<MemoryErasureTargetTypeV2, string>> = {
      evidence: `SELECT 1 FROM memory_evidence WHERE id = ? AND eligibility_state = 'erased'`,
      concept: `SELECT 1 FROM memory_concepts WHERE id = ? AND lifecycle_state = 'erased'`,
      episode: `SELECT 1 FROM memory_episodes WHERE id = ? AND state = 'erased'`,
      claim: `SELECT 1 FROM memory_claims WHERE id = ? AND lifecycle_state = 'erased'`,
      identity_epoch: `SELECT 1 FROM memory_identity_epochs
                       WHERE id = ? AND identity_statement_blob_ref IS NULL`,
    }
    const query = tombstoneQueries[target.type]
    return query ? Boolean(database.prepare(query).get(target.id)) : false
  }

  /**
   * 从一个目标扩张出全部牵连对象：概念带出情节与主张，证据带出只靠它支撑的对象，
   * 再收关系、身份纪元、树节点，最后把这些对象引用到的密文与候选账本一并收进来。
   */
  private computeClosure(target: MemoryErasureTargetV2): MemoryErasureClosureV2 {
    const database = this.authority.database
    assertTargetExistsV2(database, target)
    if (
      target.type === 'tree_node' &&
      !this.treeStore.current.nodes.some((node) => node.stableKey === target.id)
    ) {
      throw new AppError('NOT_FOUND', '擦除目标树节点不存在。', undefined, { ...target })
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

    this.expandConceptDependents(concepts, episodes, claims)
    if (target.type === 'evidence') {
      addSolelySupportedObjectsV2(database, target.id, concepts, episodes, claims, relations)
    }
    this.expandConceptDependents(concepts, episodes, claims)
    addLinkedEvidenceV2(database, 'memory_concept_evidence', 'concept_id', concepts, evidence)
    addLinkedEvidenceV2(database, 'memory_episode_evidence', 'episode_id', episodes, evidence)
    addLinkedEvidenceV2(database, 'memory_claim_evidence', 'claim_id', claims, evidence)
    addLinkedEvidenceV2(database, 'memory_relation_evidence', 'relation_id', relations, evidence)

    this.expandIncidentRelations(concepts, episodes, claims, relations)
    addLinkedEvidenceV2(database, 'memory_relation_evidence', 'relation_id', relations, evidence)
    this.expandAffectedIdentities(concepts, episodes, claims, identities)
    this.expandAffectedTreeNodes(concepts, episodes, claims, identities, treeStableKeys)

    const blobIds = collectClosureBlobIdsV2(database, {
      evidence,
      concepts,
      episodes,
      claims,
      identities,
    })
    addCandidateLedgerBlobsV2(database, this.contentKeys, evidence, blobIds)
    for (const node of this.treeStore.current.nodes) {
      if (treeStableKeys.has(node.stableKey) && node.content.blobRef) {
        blobIds.add(node.content.blobRef)
      }
    }
    return {
      format: MemoryErasureClosureFormatV2,
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

  /** 概念没了，挂在它下面的情节与主张也就没有主体了，一并收进闭包。 */
  private expandConceptDependents(
    concepts: ReadonlySet<string>,
    episodes: Set<string>,
    claims: Set<string>
  ): void {
    if (concepts.size === 0) return
    const database = this.authority.database
    addColumnValuesV2(
      database,
      episodes,
      `SELECT id FROM memory_episodes WHERE primary_concept_id IN (${placeholdersV2(concepts)})`,
      [...concepts]
    )
    addColumnValuesV2(
      database,
      claims,
      `SELECT id FROM memory_claims WHERE subject_concept_id IN (${placeholdersV2(concepts)})`,
      [...concepts]
    )
  }

  /** 收走以这些对象为任一端点的关系：端点没了，关系也不该留着。 */
  private expandIncidentRelations(
    concepts: ReadonlySet<string>,
    episodes: ReadonlySet<string>,
    claims: ReadonlySet<string>,
    relations: Set<string>
  ): void {
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
      for (const row of relationLookup.all(kind, id, kind, id) as MemoryIdRowV2[]) {
        relations.add(row.id)
      }
    }
  }

  /** 支撑集与闭包有交集的身份纪元也要一起擦：它的自述已经不成立了。 */
  private expandAffectedIdentities(
    concepts: ReadonlySet<string>,
    episodes: ReadonlySet<string>,
    claims: ReadonlySet<string>,
    identities: Set<string>
  ): void {
    const rows = this.authority.database
      .prepare(
        `SELECT id, supporting_concept_ids_json,
                supporting_episode_ids_json, supporting_claim_ids_json
         FROM memory_identity_epochs`
      )
      .all() as MemoryIdentitySupportRowV2[]
    for (const identity of rows) {
      if (
        intersectsJsonIdsV2(identity.supporting_concept_ids_json, concepts) ||
        intersectsJsonIdsV2(identity.supporting_episode_ids_json, episodes) ||
        intersectsJsonIdsV2(identity.supporting_claim_ids_json, claims)
      ) {
        identities.add(identity.id)
      }
    }
  }

  /** 投影到闭包里这些实体上的树节点全部收进来，第一段要对它们落 redact。 */
  private expandAffectedTreeNodes(
    concepts: ReadonlySet<string>,
    episodes: ReadonlySet<string>,
    claims: ReadonlySet<string>,
    identities: ReadonlySet<string>,
    treeStableKeys: Set<string>
  ): void {
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
  }

  /** 拼第一段要提交的结构事件：redact 命中节点，空树补根，换身份补中性主线。 */
  private buildRedactOps(
    closure: MemoryErasureClosureV2,
    replacement: Nullable<ReplacementIdentityV2>,
    confirmedAt: number
  ): MemoryTreeDiffOpV2[] {
    const redactionTargets = this.treeStore.current.nodes.filter(
      (node) =>
        closure.treeStableKeys.includes(node.stableKey) && node.visibilityState !== 'redacted'
    )
    const ops: MemoryTreeDiffOpV2[] = []
    if (!isEmpty(redactionTargets)) ops.push(buildRedactTreeDiffOpV2(redactionTargets))
    if (this.treeStore.version === 0) ops.push(createRootAddOpV2(confirmedAt))
    if (replacement) ops.push(createIdentityMainlineAddOpV2(replacement, confirmedAt))
    return ops
  }

  /** 先把中性身份的两段正文封好；封第二段失败就把第一段擦掉，不留孤儿密文。 */
  private prepareReplacementIdentity(active: Nullable<ActiveIdentityRowV2>): ReplacementIdentityV2 {
    const statement = this.contentKeys.sealContent(
      MemoryErasureServiceV2.NeutralIdentityStatement
    )
    try {
      return {
        id: this.randomId(),
        sequence: (active?.sequence ?? 0) + 1,
        predecessorId: toNullable(active?.id),
        statement,
        globalMainline: this.contentKeys.sealContent(
          MemoryErasureServiceV2.NeutralGlobalMainline
        ),
      }
    } catch (error) {
      this.contentKeys.eraseContent(statement.blobId)
      throw error
    }
  }

  /**
   * 第一段的权威事务参与者：推隐私代（CAS）、打墓碑、登记接续身份，
   * 再在 snapshot 之后写擦除请求与 deny-set。抛错即整棵树的提交事务回滚。
   */
  private buildFirstPhaseParticipant(
    input: MemoryErasureFirstPhaseInputV2
  ): MemoryTreeAuthorityCommitParticipantV2 {
    const database = this.authority.database
    return {
      apply: () => {
        const privacy = database
          .prepare(
            `UPDATE memory_meta
             SET integer_value = ?, updated_at = ?
             WHERE key = 'privacy_generation' AND integer_value = ?`
          )
          .run(input.privacyGeneration, input.confirmedAt, input.currentPrivacyGeneration)
        if (privacy.changes !== 1) {
          throw new AppError('CONFLICT', 'privacy_generation CAS 失败。')
        }
        applyAuthorityTombstonesV2(database, input.closure)
        if (input.replacement) this.insertReplacementIdentity(input, input.replacement)
      },
      applyAfterSnapshot: () => {
        database
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
        const targetInsert = database.prepare(
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

  /** 登记接续身份：两个 blob 进账本、前一个纪元收尾、写新纪元行（置信度 0）。 */
  private insertReplacementIdentity(
    input: MemoryErasureFirstPhaseInputV2,
    replacement: ReplacementIdentityV2
  ): void {
    const database = this.authority.database
    registerMemoryContentBlobV2(database, replacement.statement, input.confirmedAt)
    registerMemoryContentBlobV2(database, replacement.globalMainline, input.confirmedAt)
    if (replacement.predecessorId) {
      database
        .prepare(
          `UPDATE memory_identity_epochs
           SET ended_at = COALESCE(ended_at, ?)
           WHERE id = ?`
        )
        .run(input.confirmedAt, replacement.predecessorId)
    }
    database
      .prepare(
        `INSERT INTO memory_identity_epochs(
           id, sequence,
           identity_statement_blob_ref, identity_statement_commitment,
           global_mainline_blob_ref, global_mainline_commitment,
           confidence, predecessor_id, started_at, created_by_run_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
      )
      .run(
        replacement.id,
        replacement.sequence,
        replacement.statement.blobId,
        replacement.statement.commitment,
        replacement.globalMainline.blobId,
        replacement.globalMainline.commitment,
        replacement.predecessorId,
        input.confirmedAt,
        `erasure:${input.requestId}`,
        input.confirmedAt
      )
  }

  /** 验证第二段：每个 blob 都打了墓碑、DEK 都取不出来了，且派生投影与权威会合。 */
  private verifyPurge(closure: MemoryErasureClosureV2): void {
    for (const blobId of closure.blobIds) {
      const row = this.authority.database
        .prepare(`SELECT state FROM memory_content_blobs WHERE blob_id = ?`)
        .get(blobId) as MemoryBlobStateRowV2 | undefined
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

  /** 读当前还没收尾的身份纪元；一个都没有就是还没建过身份。 */
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

  /** 读一条擦除请求；不存在抛 NOT_FOUND。 */
  private readRequest(requestId: string): MemoryErasureRequestRowV2 {
    const row = this.authority.database
      .prepare(`SELECT * FROM memory_erasure_requests WHERE id = ?`)
      .get(requestId) as MemoryErasureRequestRowV2 | undefined
    if (!row) {
      throw new AppError('NOT_FOUND', 'Erasure request 不存在。', undefined, { requestId })
    }
    return row
  }

  /** 从注入的随机源取请求 id；长度不对就是随机源坏了。 */
  private randomId(): string {
    const value = this.random(MemoryErasureServiceV2.RequestIdByteLength)
    if (!Buffer.isBuffer(value) || value.length !== MemoryErasureServiceV2.RequestIdByteLength) {
      throw new AppError('INVARIANT', 'Erasure 随机源必须返回 16 字节。')
    }
    return value.toString('hex')
  }
}
