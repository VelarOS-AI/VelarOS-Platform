import { isEmpty, isPresent, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { MemorySqliteDatabaseV2 } from '../../types/tree-v2/authority'
import type { MemoryTreeDiffOpV2, MemoryTreeNodeStructV2 } from '../../types/tree-v2/diff'
import type {
  BuildMeaningTreeNodesInputV2,
  MemoryClaimCandidateV2,
  MemoryEpisodeCandidateV2,
  MemoryEvidenceTrustSummaryV2,
  MemoryExternalContentCapResultV2,
  MemoryIdentityCandidateV2,
  MemoryMeaningCandidateDecisionV2,
  MemoryMeaningCandidateV2,
  MemoryRelationCandidateV2,
  PreparedClaimV2,
  PreparedConceptV2,
  PreparedEpisodeV2,
  PreparedIdentityV2,
  PreparedRelationV2,
} from '../../types/tree-v2/meaning'

import { compareCodeUnitV2 } from './checks'
import { canonicalStringifyV2, quantizeTreeScoreV2 } from './diff-chain'
import { MemoryEmptyCommitmentV2 } from './erasure'

/**
 * 意义整理的规则名单、候选形态校验、依赖裁剪、树节点推导与逐表落库语句。
 * 这些都只依赖传进来的连接与数据，用不着实例状态。
 */

/** 允许的概念类型名单。 */
export const MemoryConceptTypesV2 = new Set([
  'user',
  'project',
  'task',
  'goal',
  'interest',
  'preference',
  'procedure',
  'entity',
  'artifact',
])

/** 允许的证据信任级别名单（意义整理侧的判据）。 */
export const MemoryMeaningTrustLevelsV2 = new Set([
  'user_stated',
  'system_observed',
  'agent_derived',
  'external_content',
])

/** 允许的认识状态名单。 */
export const MemoryEpistemicStatusesV2 = new Set([
  'user_confirmed',
  'observed',
  'derived',
  'inferred',
  'disputed',
])

/** 允许的生命周期状态名单。 */
export const MemoryLifecycleStatesV2 = new Set([
  'transient',
  'candidate',
  'active',
  'consolidated',
  'dormant',
  'reactivated',
])

/** 候选账本的格式身份。 */
export const MemoryCandidateLedgerFormatV2 = 'velaros.memory.candidate-ledger.v2'

/** 校验一个候选的形态，返回拒绝理由码（空数组表示通过）。 */
export function validateCandidateShapeV2(candidate: MemoryMeaningCandidateV2): string[] {
  const reasons: string[] = []
  if (!candidate.candidateKey) reasons.push('missing_candidate_key')
  if (isEmpty(candidate.evidenceIds)) reasons.push('missing_evidence')
  if (candidate.kind === 'concept') {
    if (!MemoryConceptTypesV2.has(candidate.conceptType)) reasons.push('invalid_concept_type')
    if (!candidate.name) reasons.push('missing_concept_name')
    if (!MemoryLifecycleStatesV2.has(candidate.lifecycleState)) reasons.push('invalid_lifecycle')
    validateScoreV2(candidate.salience, 'salience', reasons)
    validateScoreV2(candidate.activation, 'activation', reasons)
  }
  if (candidate.kind === 'episode') {
    if (!candidate.episodeType || !candidate.title || !candidate.state || !candidate.phase) {
      reasons.push('missing_episode_structure')
    }
    if (isPresent(candidate.endedAt) && candidate.endedAt < candidate.startedAt) {
      reasons.push('episode_time_reversed')
    }
    validateScoreV2(candidate.salience, 'salience', reasons)
    validateScoreV2(candidate.activation, 'activation', reasons)
  }
  if (candidate.kind === 'claim') {
    if (!candidate.predicate || !candidate.title) reasons.push('missing_claim_structure')
    if (!MemoryEpistemicStatusesV2.has(candidate.epistemicStatus)) {
      reasons.push('invalid_epistemic_status')
    }
    if (!MemoryLifecycleStatesV2.has(candidate.lifecycleState)) reasons.push('invalid_lifecycle')
    validateScoreV2(candidate.confidence, 'confidence', reasons)
    validateScoreV2(candidate.salience, 'salience', reasons)
    validateScoreV2(candidate.consolidationStrength, 'consolidation', reasons)
    validateScoreV2(candidate.activation, 'activation', reasons)
  }
  if (candidate.kind === 'relation') {
    if (!candidate.relationType) reasons.push('missing_relation_type')
    if (!MemoryEpistemicStatusesV2.has(candidate.epistemicStatus)) {
      reasons.push('invalid_epistemic_status')
    }
    validateScoreV2(candidate.confidence, 'confidence', reasons)
    validateScoreV2(candidate.activation, 'activation', reasons)
  }
  return reasons
}

/**
 * 只由外部内容支撑时的信任上限：画像类概念直接拒，主张改判成 inferred 并把置信度压到上限。
 * 返回改写后的候选与「有没有被改写」；上限值由调用方给（它是那个类里固定用的取舍）。
 */
export function applyExternalContentCapV2(
  candidate: MemoryMeaningCandidateV2,
  trust: MemoryEvidenceTrustSummaryV2,
  confidenceCap: number,
  reasons: string[]
): MemoryExternalContentCapResultV2 {
  if (!trust.externalOnly) return { candidate, revised: false }
  if (
    candidate.kind === 'concept' &&
    (candidate.conceptType === 'user' || candidate.conceptType === 'preference')
  ) {
    reasons.push('external_content_cannot_create_profile')
    return { candidate, revised: false }
  }
  if (candidate.kind !== 'claim') return { candidate, revised: false }
  const revisedCandidate: MemoryClaimCandidateV2 = {
    ...candidate,
    epistemicStatus: 'inferred',
    confidence: Math.min(candidate.confidence, confidenceCap),
  }
  return {
    candidate: revisedCandidate,
    revised:
      revisedCandidate.epistemicStatus !== candidate.epistemicStatus ||
      revisedCandidate.confidence !== candidate.confidence,
  }
}

/** 校验身份候选的形态，返回拒绝理由码。 */
export function validateIdentityShapeV2(candidate: MemoryIdentityCandidateV2): string[] {
  const reasons: string[] = []
  if (!candidate.statement || !candidate.globalMainline) reasons.push('missing_identity_content')
  if (isEmpty(candidate.evidenceIds)) reasons.push('missing_evidence')
  validateScoreV2(candidate.confidence, 'confidence', reasons)
  return reasons
}

/** 评分字段必须是 [0,1] 的有限数，不合规就往 reasons 里追一条。 */
export function validateScoreV2(value: number, label: string, reasons: string[]): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) reasons.push(`invalid_${label}`)
}

/** 把依赖已被拒绝或缺失的候选一并改判成拒绝：情节看主概念，主张看主体，关系看两端。 */
export function rejectBrokenDependenciesV2(
  episodes: readonly MemoryEpisodeCandidateV2[],
  claims: readonly MemoryClaimCandidateV2[],
  relations: readonly MemoryRelationCandidateV2[],
  acceptedKeys: ReadonlySet<string>,
  decisions: MemoryMeaningCandidateDecisionV2[]
): void {
  const reject = (candidateKey: string, reason: string): void => {
    const index = decisions.findIndex((item) => item.candidateKey === candidateKey)
    const decision = decisions[index]
    if (index < 0 || !decision || decision.decision === 'rejected') return
    decisions[index] = { ...decision, decision: 'rejected', reasons: [reason] }
  }
  for (const episode of episodes) {
    if (!acceptedKeys.has(episode.primaryConceptKey)) {
      reject(episode.candidateKey, 'missing_primary_concept')
    }
  }
  for (const claim of claims) {
    if (!acceptedKeys.has(claim.subjectConceptKey)) {
      reject(claim.candidateKey, 'missing_subject_concept')
    }
  }
  const rejected = new Set(
    decisions.filter((item) => item.decision === 'rejected').map((item) => item.candidateKey)
  )
  for (const relation of relations) {
    if (
      !acceptedKeys.has(relation.source.candidateKey) ||
      !acceptedKeys.has(relation.target.candidateKey) ||
      rejected.has(relation.source.candidateKey) ||
      rejected.has(relation.target.candidateKey)
    ) {
      reject(relation.candidateKey, 'missing_relation_endpoint')
    }
  }
}

/** 由准备好的实体推出这一轮希望树长成的样子：根、身份主线、概念、情节、主张。 */
export function buildMeaningTreeNodesV2(
  input: BuildMeaningTreeNodesInputV2
): MemoryTreeNodeStructV2[] {
  const nodes: MemoryTreeNodeStructV2[] = []
  if (!input.current.some((node) => node.stableKey === 'root')) {
    nodes.push({
      stableKey: 'root',
      parentKey: null,
      nodeType: 'root',
      namespace: 'root',
      subjectType: 'root',
      subjectId: 'root',
      content: {
        blobRef: null,
        commitment: MemoryEmptyCommitmentV2,
        redacted: false,
      },
      mainlineScore: 1,
      confidence: 1,
      activation: 1,
      firstSeenAt: input.createdAt,
      lastActiveAt: input.createdAt,
      visibilityState: 'active',
    })
  }
  if (input.identity) {
    nodes.push({
      stableKey: input.globalMainlineNodeId,
      parentKey: 'root',
      nodeType: 'mainline',
      namespace: 'identity',
      subjectType: 'identity_epoch',
      subjectId: input.activeIdentityEpochId,
      content: {
        blobRef: input.identity.globalMainline.blobId,
        commitment: input.identity.globalMainline.commitment,
        redacted: false,
      },
      mainlineScore: 1,
      confidence: quantizeTreeScoreV2(input.identity.candidate.confidence),
      activation: 1,
      firstSeenAt: input.createdAt,
      lastActiveAt: input.createdAt,
      visibilityState: 'active',
    })
  }
  for (const concept of input.concepts) {
    nodes.push({
      stableKey: `concept:${concept.stableKey}`,
      parentKey: input.globalMainlineNodeId,
      nodeType: concept.candidate.conceptType,
      namespace: 'concept',
      subjectType: 'concept',
      subjectId: concept.id,
      content: {
        blobRef: concept.name.blobId,
        commitment: concept.name.commitment,
        redacted: false,
      },
      mainlineScore: quantizeTreeScoreV2(concept.candidate.salience),
      confidence: quantizeTreeScoreV2(concept.candidate.salience),
      activation: quantizeTreeScoreV2(concept.candidate.activation),
      firstSeenAt: concept.candidate.firstSeenAt,
      lastActiveAt: concept.candidate.lastActiveAt,
      visibilityState: concept.candidate.lifecycleState === 'dormant' ? 'dormant' : 'active',
    })
  }
  for (const episode of input.episodes) {
    const content = episode.summary ?? episode.title
    nodes.push({
      stableKey: `episode:${episode.stableKey}`,
      parentKey: `concept:${episode.primaryConcept.stableKey}`,
      nodeType: 'episode',
      namespace: 'episode',
      subjectType: 'episode',
      subjectId: episode.id,
      content: {
        blobRef: content.blobId,
        commitment: content.commitment,
        redacted: false,
      },
      mainlineScore: quantizeTreeScoreV2(episode.candidate.salience),
      confidence: quantizeTreeScoreV2(episode.candidate.salience),
      activation: quantizeTreeScoreV2(episode.candidate.activation),
      firstSeenAt: episode.candidate.startedAt,
      lastActiveAt: episode.candidate.endedAt ?? episode.candidate.startedAt,
      visibilityState: 'active',
    })
  }
  for (const claim of input.claims) {
    const content = claim.summary ?? claim.value
    nodes.push({
      stableKey: `claim:${claim.stableKey}`,
      parentKey: `concept:${claim.subjectConcept.stableKey}`,
      nodeType: 'claim',
      namespace: 'claim',
      subjectType: 'claim',
      subjectId: claim.id,
      content: {
        blobRef: content.blobId,
        commitment: content.commitment,
        redacted: false,
      },
      mainlineScore: quantizeTreeScoreV2(claim.candidate.salience),
      confidence: quantizeTreeScoreV2(claim.candidate.confidence),
      activation: quantizeTreeScoreV2(claim.candidate.activation),
      firstSeenAt: claim.candidate.validFrom,
      lastActiveAt: claim.candidate.validTo ?? claim.candidate.validFrom,
      visibilityState: claim.candidate.lifecycleState === 'dormant' ? 'dormant' : 'active',
    })
  }
  return nodes
}

/** 把「当前树」和「希望的样子」比成结构事件：没有的 add，变了的 update，一样的不动。 */
export function buildMeaningTreeOpsV2(
  current: readonly MemoryTreeNodeStructV2[],
  desired: readonly MemoryTreeNodeStructV2[]
): MemoryTreeDiffOpV2[] {
  const currentByKey = new Map(current.map((node) => [node.stableKey, node]))
  return [...desired]
    .sort((left, right) => compareCodeUnitV2(left.stableKey, right.stableKey))
    .flatMap((node): MemoryTreeDiffOpV2[] => {
      const existing = currentByKey.get(node.stableKey)
      if (!existing) return [{ type: 'add', before: [], after: [node] }]
      if (canonicalStringifyV2(existing) === canonicalStringifyV2(node)) return []
      return [{ type: 'update', before: [existing], after: [node] }]
    })
}

/** 落库概念：按稳定键 upsert、补证据关联、重算证据计数。 */
export function persistConceptsV2(
  database: MemorySqliteDatabaseV2,
  concepts: readonly PreparedConceptV2[],
  createdAt: number
): void {
  for (const item of concepts) {
    database
      .prepare(
        `INSERT INTO memory_concepts(
           id, stable_key, concept_type,
           name_blob_ref, name_commitment, name_match_key,
           description_blob_ref, description_commitment,
           scope_type, scope_match_key, privacy_class, lifecycle_state,
           first_seen_at, last_active_at, evidence_count,
           salience, activation, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(stable_key) DO UPDATE SET
           name_blob_ref = excluded.name_blob_ref,
           name_commitment = excluded.name_commitment,
           name_match_key = excluded.name_match_key,
           description_blob_ref = excluded.description_blob_ref,
           description_commitment = excluded.description_commitment,
           lifecycle_state = excluded.lifecycle_state,
           last_active_at = MAX(memory_concepts.last_active_at, excluded.last_active_at),
           salience = MAX(memory_concepts.salience, excluded.salience),
           activation = excluded.activation,
           updated_at = excluded.updated_at`
      )
      .run(
        item.id,
        item.stableKey,
        item.candidate.conceptType,
        item.name.blobId,
        item.name.commitment,
        item.nameMatchKey,
        toNullable(item.description?.blobId),
        toNullable(item.description?.commitment),
        item.scope.scopeType,
        item.scope.scopeMatchKey,
        item.candidate.privacyClass,
        item.candidate.lifecycleState,
        item.candidate.firstSeenAt,
        item.candidate.lastActiveAt,
        item.candidate.evidenceIds.length,
        item.candidate.salience,
        item.candidate.activation,
        createdAt,
        createdAt
      )
    const persisted = database
      .prepare(`SELECT id FROM memory_concepts WHERE stable_key = ?`)
      .pluck()
      .get(item.stableKey) as string
    for (const evidenceId of item.candidate.evidenceIds) {
      database
        .prepare(
          `INSERT INTO memory_concept_evidence(concept_id, evidence_id, weight, created_at)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(concept_id, evidence_id) DO NOTHING`
        )
        .run(persisted, evidenceId, createdAt)
    }
    database
      .prepare(
        `UPDATE memory_concepts
         SET evidence_count = (
           SELECT count(*) FROM memory_concept_evidence WHERE concept_id = ?
         )
         WHERE id = ?`
      )
      .run(persisted, persisted)
  }
}

/** 落库情节：按稳定键 upsert、挂主概念、补证据关联。 */
export function persistEpisodesV2(
  database: MemorySqliteDatabaseV2,
  episodes: readonly PreparedEpisodeV2[],
  runId: string,
  createdAt: number
): void {
  for (const item of episodes) {
    database
      .prepare(
        `INSERT INTO memory_episodes(
           id, stable_key, episode_type, title_blob_ref, title_commitment,
           summary_blob_ref, summary_commitment, state, started_at, ended_at,
           scope_type, scope_match_key, primary_concept_id,
           result_blob_ref, result_commitment, created_by_run_id,
           salience, activation, last_reinforced_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(stable_key) DO UPDATE SET
           title_blob_ref = excluded.title_blob_ref,
           title_commitment = excluded.title_commitment,
           summary_blob_ref = excluded.summary_blob_ref,
           summary_commitment = excluded.summary_commitment,
           state = excluded.state,
           ended_at = excluded.ended_at,
           result_blob_ref = excluded.result_blob_ref,
           result_commitment = excluded.result_commitment,
           salience = MAX(memory_episodes.salience, excluded.salience),
           activation = excluded.activation,
           last_reinforced_at = excluded.last_reinforced_at,
           updated_at = excluded.updated_at`
      )
      .run(
        item.id,
        item.stableKey,
        item.candidate.episodeType,
        item.title.blobId,
        item.title.commitment,
        toNullable(item.summary?.blobId),
        toNullable(item.summary?.commitment),
        item.candidate.state,
        item.candidate.startedAt,
        toNullable(item.candidate.endedAt),
        item.scope.scopeType,
        item.scope.scopeMatchKey,
        item.primaryConcept.id,
        toNullable(item.result?.blobId),
        toNullable(item.result?.commitment),
        runId,
        item.candidate.salience,
        item.candidate.activation,
        item.candidate.endedAt ?? item.candidate.startedAt,
        createdAt,
        createdAt
      )
    const persisted = database
      .prepare(`SELECT id FROM memory_episodes WHERE stable_key = ?`)
      .pluck()
      .get(item.stableKey) as string
    database
      .prepare(
        `INSERT INTO memory_episode_concepts(episode_id, concept_id, role, weight)
         VALUES (?, ?, 'primary', 1)
         ON CONFLICT(episode_id, concept_id, role) DO UPDATE SET weight = excluded.weight`
      )
      .run(persisted, item.primaryConcept.id)
    for (const evidenceId of item.candidate.evidenceIds) {
      database
        .prepare(
          `INSERT INTO memory_episode_evidence(episode_id, evidence_id, weight, created_at)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(episode_id, evidence_id) DO NOTHING`
        )
        .run(persisted, evidenceId, createdAt)
    }
  }
}

/** 落库主张：按稳定键 upsert、补证据关联。 */
export function persistClaimsV2(
  database: MemorySqliteDatabaseV2,
  claims: readonly PreparedClaimV2[],
  runId: string,
  createdAt: number
): void {
  for (const item of claims) {
    database
      .prepare(
        `INSERT INTO memory_claims(
           id, stable_key, claim_group_key, subject_concept_id, predicate,
           value_blob_ref, value_commitment, storage_mode, payload_ref,
           summary_blob_ref, summary_commitment, epistemic_status, confidence,
           privacy_class, lifecycle_state, valid_from, valid_to,
           created_by_run_id, salience, consolidation_strength, activation,
           last_reinforced_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(stable_key) DO UPDATE SET
           value_blob_ref = excluded.value_blob_ref,
           value_commitment = excluded.value_commitment,
           summary_blob_ref = excluded.summary_blob_ref,
           summary_commitment = excluded.summary_commitment,
           epistemic_status = excluded.epistemic_status,
           confidence = excluded.confidence,
           lifecycle_state = excluded.lifecycle_state,
           valid_to = excluded.valid_to,
           salience = MAX(memory_claims.salience, excluded.salience),
           consolidation_strength = MAX(
             memory_claims.consolidation_strength,
             excluded.consolidation_strength
           ),
           activation = excluded.activation,
           last_reinforced_at = excluded.last_reinforced_at,
           updated_at = excluded.updated_at`
      )
      .run(
        item.id,
        item.stableKey,
        item.groupKey,
        item.subjectConcept.id,
        item.candidate.predicate,
        item.value.blobId,
        item.value.commitment,
        item.candidate.storageMode,
        toNullable(item.candidate.payloadRef),
        toNullable(item.summary?.blobId),
        toNullable(item.summary?.commitment),
        item.candidate.epistemicStatus,
        item.candidate.confidence,
        item.candidate.privacyClass,
        item.candidate.lifecycleState,
        item.candidate.validFrom,
        toNullable(item.candidate.validTo),
        runId,
        item.candidate.salience,
        item.candidate.consolidationStrength,
        item.candidate.activation,
        item.candidate.validTo ?? item.candidate.validFrom,
        createdAt,
        createdAt
      )
    const persisted = database
      .prepare(`SELECT id FROM memory_claims WHERE stable_key = ?`)
      .pluck()
      .get(item.stableKey) as string
    for (const evidenceId of item.candidate.evidenceIds) {
      database
        .prepare(
          `INSERT INTO memory_claim_evidence(
             claim_id, evidence_id, relation, weight, created_at
           )
           VALUES (?, ?, 'supports', 1, ?)
           ON CONFLICT(claim_id, evidence_id) DO UPDATE SET weight = excluded.weight`
        )
        .run(persisted, evidenceId, createdAt)
    }
  }
}

/** 落库关系：按两端与类型 upsert、补证据关联。 */
export function persistRelationsV2(
  database: MemorySqliteDatabaseV2,
  relations: readonly PreparedRelationV2[],
  runId: string,
  createdAt: number
): void {
  for (const item of relations) {
    database
      .prepare(
        `INSERT INTO memory_relations(
           id, source_type, source_id, target_type, target_id, relation_type,
           confidence, epistemic_status, valid_from, valid_to,
           created_by_run_id, activation, last_reinforced_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_type, source_id, target_type, target_id, relation_type)
         DO UPDATE SET
           confidence = excluded.confidence,
           epistemic_status = excluded.epistemic_status,
           valid_to = excluded.valid_to,
           activation = excluded.activation,
           last_reinforced_at = excluded.last_reinforced_at,
           updated_at = excluded.updated_at`
      )
      .run(
        item.id,
        item.candidate.source.kind,
        item.sourceId,
        item.candidate.target.kind,
        item.targetId,
        item.candidate.relationType,
        item.candidate.confidence,
        item.candidate.epistemicStatus,
        item.candidate.validFrom,
        toNullable(item.candidate.validTo),
        runId,
        item.candidate.activation,
        item.candidate.validTo ?? item.candidate.validFrom,
        createdAt,
        createdAt
      )
    const persisted = database
      .prepare(
        `SELECT id FROM memory_relations
         WHERE source_type = ? AND source_id = ?
           AND target_type = ? AND target_id = ? AND relation_type = ?`
      )
      .pluck()
      .get(
        item.candidate.source.kind,
        item.sourceId,
        item.candidate.target.kind,
        item.targetId,
        item.candidate.relationType
      ) as string
    for (const evidenceId of item.candidate.evidenceIds) {
      database
        .prepare(
          `INSERT INTO memory_relation_evidence(relation_id, evidence_id, weight)
           VALUES (?, ?, 1)
           ON CONFLICT(relation_id, evidence_id) DO UPDATE SET weight = excluded.weight`
        )
        .run(persisted, evidenceId)
    }
  }
}

/** 落库身份纪元：先给前一个纪元收尾（CAS），再写新纪元行。 */
export function persistIdentityV2(
  database: MemorySqliteDatabaseV2,
  identity: PreparedIdentityV2,
  runId: string,
  createdAt: number
): void {
  if (identity.predecessorId) {
    const ended = database
      .prepare(`UPDATE memory_identity_epochs SET ended_at = ? WHERE id = ? AND ended_at IS NULL`)
      .run(createdAt, identity.predecessorId)
    if (ended.changes !== 1) throw new AppError('CONFLICT', 'Identity predecessor CAS 失败。')
  }
  database
    .prepare(
      `INSERT INTO memory_identity_epochs(
         id, sequence,
         identity_statement_blob_ref, identity_statement_commitment,
         global_mainline_blob_ref, global_mainline_commitment,
         confidence, supporting_concept_ids_json,
         supporting_episode_ids_json, supporting_claim_ids_json,
         predecessor_id, started_at, created_by_run_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      identity.id,
      identity.sequence,
      identity.statement.blobId,
      identity.statement.commitment,
      identity.globalMainline.blobId,
      identity.globalMainline.commitment,
      identity.candidate.confidence,
      canonicalStringifyV2(identity.supportingConceptIds),
      canonicalStringifyV2(identity.supportingEpisodeIds),
      canonicalStringifyV2(identity.supportingClaimIds),
      identity.predecessorId,
      createdAt,
      runId,
      createdAt
    )
}

/** 从映射里取一个必须存在的值；取不到说明候选引用了没被接受的东西。 */
export function requiredMapValueV2<T>(
  map: ReadonlyMap<string, T>,
  key: string,
  label: string
): T {
  const value = map.get(key)
  if (!value) {
    throw new AppError('VALIDATION', `${label} 引用了未接受候选。`, undefined, { key })
  }
  return value
}
