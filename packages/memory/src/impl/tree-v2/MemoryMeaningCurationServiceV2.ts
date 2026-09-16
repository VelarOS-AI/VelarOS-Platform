import { randomBytes } from 'node:crypto'

import { AppError, isEmpty, isNull, toNullable } from '@velaros-ai/core'

import type { MemoryDreamValidationStatsV2 } from '../../types/tree-v2/dream'
import type { MemoryIdRowV2 } from '../../types/tree-v2/erasure'
import type { MemoryClaimStableKeyInputV2 } from '../../types/tree-v2/evidence'
import type {
  AcceptedMeaningProposalV2,
  ActiveIdentityEpochRowV2,
  CurateAndCommitMemoryMeaningInputV2,
  EvidenceTrustRowV2,
  LegacyGovernanceTypeRowV2,
  MemoryClaimCandidateV2,
  MemoryConceptCandidateV2,
  MemoryEpisodeCandidateV2,
  MemoryEvidenceTrustSummaryV2,
  MemoryIdentityCandidateV2,
  MemoryMeaningCandidateDecisionV2,
  MemoryMeaningCurationResultV2,
  MemoryMeaningEntityKindV2,
  MemoryMeaningProposalV2,
  MemoryMeaningScopeV2,
  MemoryRelationCandidateV2,
  PreparedBlobV2,
  PreparedClaimV2,
  PreparedConceptV2,
  PreparedEpisodeV2,
  PreparedIdentityV2,
  PreparedMeaningCommitV2,
  PreparedRelationV2,
  ResolvedMeaningScopeV2,
} from '../../types/tree-v2/meaning'
import type { MemoryTreeAuthorityCommitParticipantV2 } from '../../types/tree-v2/store'
import { registerMemoryContentBlobV2 } from '../../utils/tree-v2/checks'
import { canonicalStringifyV2 } from '../../utils/tree-v2/diff-chain'
import {
  canonicalizeWorkspacePathV2,
  normalizeOriginV2,
} from '../../utils/tree-v2/identity-keys'
import {
  applyExternalContentCapV2,
  buildMeaningTreeNodesV2,
  buildMeaningTreeOpsV2,
  MemoryCandidateLedgerFormatV2,
  MemoryMeaningTrustLevelsV2,
  persistClaimsV2,
  persistConceptsV2,
  persistEpisodesV2,
  persistIdentityV2,
  persistRelationsV2,
  rejectBrokenDependenciesV2,
  requiredMapValueV2,
  validateCandidateShapeV2,
  validateIdentityShapeV2,
} from '../../utils/tree-v2/meaning-curation'

import type { ContentKeyServiceV2Api } from './storage/ContentKeyServiceV2'
import type { MemoryAuthorityDatabaseV2Api } from './MemoryAuthorityDatabaseV2'
import type { MemoryDreamRunCoordinatorV2Api } from './MemoryDreamRunCoordinatorV2'
import type { MemoryIdentityKeyServiceV2Api } from './MemoryIdentityKeyServiceV2'
import type { MemoryTreeStoreV2Api } from './MemoryTreeStoreV2'

/**
 * 意义整理的裁决与发布：模型只提供候选，身份键、信任上限、谱系、密文与树投影都在这里重算。
 *
 * 一次调用要么整体发布成一个新树版本（或空提交），要么把已经封好的密文全部擦掉并让运行失败；
 * 中间不留半成品。实例归 `MemorySystemRuntimeV2`（或探针）所有。
 */
export interface MemoryMeaningCurationServiceV2Api {
  /**
   * 裁决一份提案并原子发布：形态校验 → 信任与治理判据 → 依赖裁剪 → 封密文与算身份键
   * → 记候选账本 → 提交树版本（没有结构变更就空提交）。
   * 中途任何失败都会擦掉本次封的密文、把运行标成 failed，再把原错误抛出去。
   */
  curateAndCommit(input: CurateAndCommitMemoryMeaningInputV2): MemoryMeaningCurationResultV2
}

export class MemoryMeaningCurationServiceV2 implements MemoryMeaningCurationServiceV2Api {
  /** 行 id 的随机字节数（128 位）。 */
  private static readonly EntityIdByteLength = 16

  /** 只有外部内容支撑的主张，置信度最高压到这个值（并改判成 inferred）。 */
  private static readonly ExternalContentConfidenceCap = 0.4

  constructor(
    private readonly authority: MemoryAuthorityDatabaseV2Api,
    private readonly contentKeys: ContentKeyServiceV2Api,
    private readonly identityKeys: MemoryIdentityKeyServiceV2Api,
    private readonly treeStore: MemoryTreeStoreV2Api,
    private readonly dreamRuns: MemoryDreamRunCoordinatorV2Api,
    private readonly random: (byteLength: number) => Buffer = randomBytes
  ) {}

  public curateAndCommit(
    input: CurateAndCommitMemoryMeaningInputV2
  ): MemoryMeaningCurationResultV2 {
    const accepted = this.validateProposal(input.proposal)
    const stats: MemoryDreamValidationStatsV2 = {
      tokenUsage: input.tokenUsage,
      candidateCount: accepted.candidateCount,
      acceptedCount: accepted.decisions.filter((item) => item.decision !== 'rejected').length,
      rejectedCount: accepted.decisions.filter((item) => item.decision === 'rejected').length,
    }
    let prepared: Nullable<PreparedMeaningCommitV2> = null
    try {
      if (stats.acceptedCount > 0) prepared = this.prepareCommit(input.runId, accepted)
      this.dreamRuns.markValidating(
        input.runId,
        {
          format: MemoryCandidateLedgerFormatV2,
          readSet: [
            ...new Set([
              ...input.proposal.candidates.flatMap((candidate) => candidate.evidenceIds),
              ...(input.proposal.identity?.evidenceIds ?? []),
            ]),
          ].sort(),
          decisions: accepted.decisions,
        },
        stats
      )
      if (!prepared) {
        this.dreamRuns.commitNoop(input.runId, stats, input.committedAt ?? Date.now())
      } else if (isEmpty(prepared.ops) && isNull(prepared.identityChange)) {
        this.dreamRuns.commitNoop(
          input.runId,
          stats,
          input.committedAt ?? Date.now(),
          prepared.participant
        )
      } else {
        this.dreamRuns.commitTree(input.runId, {
          ...stats,
          ops: prepared.ops,
          identityChange: prepared.identityChange,
          activeIdentityEpochId: prepared.activeIdentityEpochId,
          globalMainlineNodeId: prepared.globalMainlineNodeId,
          committedAt: input.committedAt,
          authorityCommit: prepared.participant,
        })
      }
      return {
        treeVersion: this.treeStore.version,
        acceptedCount: stats.acceptedCount,
        rejectedCount: stats.rejectedCount,
        decisions: accepted.decisions,
      }
    } catch (error) {
      prepared?.cleanupAfterFailure()
      try {
        this.dreamRuns.failRun(input.runId, 'CURATION_FAILED', input.committedAt ?? Date.now())
      } catch {
        // arch-guard:silent-catch-ok run 可能尚未进入可失败状态或已原子提交；必须保留并抛出原错误。
      }
      throw error
    }
  }

  /** 逐候选裁决：形态、证据信任、外部内容上限、敏感主张门槛、旧库治理拒绝，再裁剪断链依赖。 */
  private validateProposal(proposal: MemoryMeaningProposalV2): AcceptedMeaningProposalV2 {
    const decisions: MemoryMeaningCandidateDecisionV2[] = []
    const seen = new Set<string>()
    const conceptCandidates = new Map(
      proposal.candidates
        .filter((candidate): candidate is MemoryConceptCandidateV2 => candidate.kind === 'concept')
        .map((candidate) => [candidate.candidateKey, candidate])
    )
    const concepts: MemoryConceptCandidateV2[] = []
    const episodes: MemoryEpisodeCandidateV2[] = []
    const claims: MemoryClaimCandidateV2[] = []
    const relations: MemoryRelationCandidateV2[] = []

    for (const candidate of proposal.candidates) {
      const reasons = validateCandidateShapeV2(candidate)
      if (seen.has(candidate.candidateKey)) reasons.push('duplicate_candidate_key')
      seen.add(candidate.candidateKey)
      const trust = this.readEvidenceTrust(candidate.evidenceIds)
      reasons.push(...trust.reasons)
      const capped = applyExternalContentCapV2(
        candidate,
        trust,
        MemoryMeaningCurationServiceV2.ExternalContentConfidenceCap,
        reasons
      )
      if (
        candidate.kind === 'claim' &&
        candidate.privacyClass === 'sensitive' &&
        !trust.levels.some((level) => level === 'user_stated' || level === 'system_observed')
      ) {
        reasons.push('sensitive_claim_requires_high_trust_evidence')
      }
      if (candidate.kind === 'claim') {
        const governanceType = this.readLegacyGovernanceDeny(
          candidate,
          conceptCandidates.get(candidate.subjectConceptKey)
        )
        if (governanceType) reasons.push(`legacy_governance_denied:${governanceType}`)
      }
      if (!isEmpty(reasons)) {
        decisions.push({
          candidateKey: candidate.candidateKey,
          kind: candidate.kind,
          decision: 'rejected',
          reasons,
        })
        continue
      }
      decisions.push({
        candidateKey: candidate.candidateKey,
        kind: candidate.kind,
        decision: capped.revised ? 'revised' : 'accepted',
        reasons: capped.revised ? ['external_content_trust_cap'] : [],
      })
      if (capped.candidate.kind === 'concept') concepts.push(capped.candidate)
      if (capped.candidate.kind === 'episode') episodes.push(capped.candidate)
      if (capped.candidate.kind === 'claim') claims.push(capped.candidate)
      if (capped.candidate.kind === 'relation') relations.push(capped.candidate)
    }

    const acceptedKeys = new Set([
      ...concepts.map((item) => item.candidateKey),
      ...episodes.map((item) => item.candidateKey),
      ...claims.map((item) => item.candidateKey),
    ])
    rejectBrokenDependenciesV2(episodes, claims, relations, acceptedKeys, decisions)
    const rejectedKeys = new Set(
      decisions.filter((item) => item.decision === 'rejected').map((item) => item.candidateKey)
    )
    const identity = this.decideIdentity(proposal, concepts, episodes, claims, rejectedKeys, decisions)

    return {
      concepts: concepts.filter((item) => !rejectedKeys.has(item.candidateKey)),
      episodes: episodes.filter((item) => !rejectedKeys.has(item.candidateKey)),
      claims: claims.filter((item) => !rejectedKeys.has(item.candidateKey)),
      relations: relations.filter((item) => !rejectedKeys.has(item.candidateKey)),
      identity,
      decisions,
      candidateCount: proposal.candidates.length + (proposal.identity ? 1 : 0),
    }
  }

  /** 裁决身份候选：形态、证据信任，以及它引用的支撑候选有没有被拒或缺席。 */
  private decideIdentity(
    proposal: MemoryMeaningProposalV2,
    concepts: readonly MemoryConceptCandidateV2[],
    episodes: readonly MemoryEpisodeCandidateV2[],
    claims: readonly MemoryClaimCandidateV2[],
    rejectedKeys: ReadonlySet<string>,
    decisions: MemoryMeaningCandidateDecisionV2[]
  ): Nullable<MemoryIdentityCandidateV2> {
    if (!proposal.identity) return null
    const reasons = validateIdentityShapeV2(proposal.identity)
    const trust = this.readEvidenceTrust(proposal.identity.evidenceIds)
    reasons.push(...trust.reasons)
    if (trust.externalOnly) reasons.push('external_content_cannot_support_identity')
    if (
      [
        ...proposal.identity.supportingConceptKeys,
        ...proposal.identity.supportingEpisodeKeys,
        ...proposal.identity.supportingClaimKeys,
      ].some((key) => rejectedKeys.has(key))
    ) {
      reasons.push('identity_depends_on_rejected_candidate')
    }
    if (
      proposal.identity.supportingConceptKeys.some(
        (key) => !concepts.some((item) => item.candidateKey === key)
      ) ||
      proposal.identity.supportingEpisodeKeys.some(
        (key) => !episodes.some((item) => item.candidateKey === key)
      ) ||
      proposal.identity.supportingClaimKeys.some(
        (key) => !claims.some((item) => item.candidateKey === key)
      )
    ) {
      reasons.push('identity_depends_on_missing_candidate')
    }
    decisions.push({
      candidateKey: 'identity',
      kind: 'identity',
      decision: isEmpty(reasons) ? 'accepted' : 'rejected',
      reasons,
    })
    return isEmpty(reasons) ? proposal.identity : null
  }

  /** 读一批证据的信任级别，顺带查它们在不在、还可用不可用、有没有进擦除名单。 */
  private readEvidenceTrust(evidenceIds: readonly string[]): MemoryEvidenceTrustSummaryV2 {
    const reasons: string[] = []
    if (evidenceIds.length === 0) return { levels: [], externalOnly: false, reasons: ['missing_evidence'] }
    const lookup = this.authority.database.prepare(
      `SELECT id, trust_level, eligibility_state
       FROM memory_evidence
       WHERE id = ?`
    )
    const denied = this.authority.database.prepare(
      `SELECT 1
       FROM memory_erasure_targets
       WHERE target_type = 'evidence' AND target_id = ? AND state = 'active'
       LIMIT 1`
    )
    const levels: string[] = []
    for (const evidenceId of [...new Set(evidenceIds)]) {
      const row = lookup.get(evidenceId) as EvidenceTrustRowV2 | undefined
      if (!row) {
        reasons.push(`evidence_not_found:${evidenceId}`)
        continue
      }
      if (!MemoryMeaningTrustLevelsV2.has(row.trust_level)) {
        reasons.push(`unknown_trust_level:${evidenceId}`)
      }
      if (row.eligibility_state !== 'active') reasons.push(`evidence_not_active:${evidenceId}`)
      if (denied.get(evidenceId)) reasons.push(`evidence_denied:${evidenceId}`)
      levels.push(row.trust_level)
    }
    return {
      levels,
      externalOnly: !isEmpty(levels) && levels.every((level) => level === 'external_content'),
      reasons,
    }
  }

  /**
   * 旧库治理拒绝：同一语义身份在旧库里被 forgotten / superseded / erased 过，就不许写回。
   * 比的是治理匹配键，不看旧的稳定键，也不依赖模型写的标题。
   */
  private readLegacyGovernanceDeny(
    claim: MemoryClaimCandidateV2,
    concept: Optional<MemoryConceptCandidateV2>
  ): Nullable<'forgotten' | 'superseded' | 'erased'> {
    if (!concept) return null
    let scope: ResolvedMeaningScopeV2
    try {
      scope = this.resolveScope(concept.scope)
    } catch {
      // arch-guard:silent-catch-ok 遗留治理项的 scope 不可解析时按“未命中 deny”处理。
      return null
    }
    const targetMatchKey = this.identityKeys.claimGovernanceMatchKey({
      conceptStableKey: this.identityKeys.conceptStableKey({
        conceptType: concept.conceptType,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        discriminator: concept.name,
      }),
      predicate: claim.predicate,
      content: canonicalStringifyV2(claim.value),
    })
    const row = this.authority.database
      .prepare(
        `SELECT governance_type
         FROM memory_replay_governance
         WHERE target_match_key = ?
           AND governance_type IN ('forgotten', 'superseded', 'erased')
           AND disposition = 'applied'
           AND deny_generation IS NOT NULL
           AND deny_generation <= (
             SELECT integer_value FROM memory_meta WHERE key = 'privacy_generation'
           )
         ORDER BY deny_generation DESC, governance_type
         LIMIT 1`
      )
      .get(targetMatchKey) as LegacyGovernanceTypeRowV2 | undefined
    return toNullable(row?.governance_type)
  }

  /**
   * 把通过裁决的候选变成可提交的东西：算身份键、封密文、推出目标树节点与结构事件，
   * 并把落库动作打包成权威事务的参与者。任何一步失败都把已封的密文擦掉。
   */
  private prepareCommit(
    runId: string,
    proposal: AcceptedMeaningProposalV2
  ): PreparedMeaningCommitV2 {
    const createdAt = Date.now()
    const blobs: PreparedBlobV2[] = []
    const seal = (content: string): PreparedBlobV2 => {
      const prepared = { ...this.contentKeys.sealContent(content), content }
      blobs.push(prepared)
      return prepared
    }
    try {
      const concepts = this.prepareConcepts(proposal.concepts, seal)
      const conceptByCandidate = new Map(
        concepts.map((item) => [item.candidate.candidateKey, item])
      )
      const episodes = this.prepareEpisodes(proposal.episodes, conceptByCandidate, seal)
      const episodeByCandidate = new Map(
        episodes.map((item) => [item.candidate.candidateKey, item])
      )
      const claims = this.prepareClaims(proposal.claims, conceptByCandidate, seal)
      const claimByCandidate = new Map(claims.map((item) => [item.candidate.candidateKey, item]))
      const entityMaps: Record<MemoryMeaningEntityKindV2, ReadonlyMap<string, { id: string }>> = {
        concept: conceptByCandidate,
        episode: episodeByCandidate,
        claim: claimByCandidate,
      }
      const relations = this.prepareRelations(proposal.relations, entityMaps)
      const activeIdentity = this.readActiveIdentityEpoch()
      const identity = proposal.identity
        ? this.prepareIdentity(
            proposal.identity,
            activeIdentity,
            conceptByCandidate,
            episodeByCandidate,
            claimByCandidate,
            seal
          )
        : null
      if (!identity && !activeIdentity) {
        throw new AppError('VALIDATION', '首个意义提交必须建立 Identity Epoch。')
      }

      const activeIdentityEpochId = identity?.id ?? (activeIdentity as ActiveIdentityEpochRowV2).id
      const globalMainlineNodeId = `identity:${activeIdentityEpochId}`
      const ops = buildMeaningTreeOpsV2(
        this.treeStore.current.nodes,
        buildMeaningTreeNodesV2({
          current: this.treeStore.current.nodes,
          concepts,
          episodes,
          claims,
          identity,
          activeIdentityEpochId,
          globalMainlineNodeId,
          createdAt,
        })
      )
      const participant: MemoryTreeAuthorityCommitParticipantV2 = {
        apply: () => {
          const database = this.authority.database
          for (const blob of blobs) registerMemoryContentBlobV2(database, blob, createdAt)
          persistConceptsV2(database, concepts, createdAt)
          persistEpisodesV2(database, episodes, runId, createdAt)
          persistClaimsV2(database, claims, runId, createdAt)
          persistRelationsV2(database, relations, runId, createdAt)
          if (identity) persistIdentityV2(database, identity, runId, createdAt)
        },
      }
      return {
        participant,
        ops,
        identityChange: identity
          ? {
              epochId: identity.id,
              sequence: identity.sequence,
              predecessorId: identity.predecessorId,
            }
          : null,
        activeIdentityEpochId,
        globalMainlineNodeId,
        cleanupAfterFailure: () => {
          for (const blob of blobs) this.contentKeys.eraseContent(blob.blobId)
        },
      }
    } catch (error) {
      for (const blob of blobs) this.contentKeys.eraseContent(blob.blobId)
      throw error
    }
  }

  /** 为每个概念候选算作用域、稳定键与名字盲索引键，并封好名称与描述。 */
  private prepareConcepts(
    candidates: readonly MemoryConceptCandidateV2[],
    seal: (content: string) => PreparedBlobV2
  ): PreparedConceptV2[] {
    return candidates.map((candidate) => {
      const scope = this.resolveScope(candidate.scope)
      const stableKey = this.identityKeys.conceptStableKey({
        conceptType: candidate.conceptType,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        discriminator: candidate.name,
      })
      return {
        candidate,
        id: this.existingId('memory_concepts', stableKey) ?? this.randomId(),
        stableKey,
        scope,
        nameMatchKey: this.identityKeys.conceptNameMatchKey(candidate.name),
        name: seal(candidate.name),
        description: candidate.description ? seal(candidate.description) : null,
      }
    })
  }

  /** 为每个情节候选找到它挂的概念，算稳定键并封好标题、摘要与结果。 */
  private prepareEpisodes(
    candidates: readonly MemoryEpisodeCandidateV2[],
    conceptByCandidate: ReadonlyMap<string, PreparedConceptV2>,
    seal: (content: string) => PreparedBlobV2
  ): PreparedEpisodeV2[] {
    return candidates.map((candidate) => {
      const primaryConcept = requiredMapValueV2(
        conceptByCandidate,
        candidate.primaryConceptKey,
        'episode primary concept'
      )
      const scope = this.resolveScope(candidate.scope)
      const stableKey = this.identityKeys.episodeStableKey({
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        conceptStableKey: primaryConcept.stableKey,
        episodeRoot: candidate.candidateKey,
        phase: candidate.phase,
      })
      return {
        candidate,
        id: this.existingId('memory_episodes', stableKey) ?? this.randomId(),
        stableKey,
        scope,
        primaryConcept,
        title: seal(candidate.title),
        summary: candidate.summary ? seal(candidate.summary) : null,
        result: candidate.result ? seal(candidate.result) : null,
      }
    })
  }

  /** 为每条主张候选算稳定键与分组键，并封好值与摘要。 */
  private prepareClaims(
    candidates: readonly MemoryClaimCandidateV2[],
    conceptByCandidate: ReadonlyMap<string, PreparedConceptV2>,
    seal: (content: string) => PreparedBlobV2
  ): PreparedClaimV2[] {
    return candidates.map((candidate) => {
      const subjectConcept = requiredMapValueV2(
        conceptByCandidate,
        candidate.subjectConceptKey,
        'claim subject concept'
      )
      const stableInput: MemoryClaimStableKeyInputV2 = {
        conceptStableKey: subjectConcept.stableKey,
        predicate: candidate.predicate,
        title: candidate.title,
        content: canonicalStringifyV2(candidate.value),
      }
      const stableKey = this.identityKeys.claimStableKey(stableInput)
      return {
        candidate,
        id: this.existingId('memory_claims', stableKey) ?? this.randomId(),
        stableKey,
        groupKey: this.identityKeys.claimGroupKey({
          conceptStableKey: subjectConcept.stableKey,
          predicate: candidate.predicate,
          title: candidate.title,
        }),
        subjectConcept,
        value: seal(canonicalStringifyV2(candidate.value)),
        summary: candidate.summary ? seal(candidate.summary) : null,
      }
    })
  }

  /** 把关系两端的候选键解析成行 id；同样两端同类型的关系已存在就复用它的 id。 */
  private prepareRelations(
    candidates: readonly MemoryRelationCandidateV2[],
    entityMaps: Record<MemoryMeaningEntityKindV2, ReadonlyMap<string, { id: string }>>
  ): PreparedRelationV2[] {
    return candidates.map((candidate) => {
      const sourceId = requiredMapValueV2(
        entityMaps[candidate.source.kind],
        candidate.source.candidateKey,
        'relation source'
      ).id
      const targetId = requiredMapValueV2(
        entityMaps[candidate.target.kind],
        candidate.target.candidateKey,
        'relation target'
      ).id
      const existing = this.authority.database
        .prepare(
          `SELECT id FROM memory_relations
           WHERE source_type = ? AND source_id = ?
             AND target_type = ? AND target_id = ? AND relation_type = ?`
        )
        .get(
          candidate.source.kind,
          sourceId,
          candidate.target.kind,
          targetId,
          candidate.relationType
        ) as MemoryIdRowV2 | undefined
      return { candidate, id: existing?.id ?? this.randomId(), sourceId, targetId }
    })
  }

  /** 为身份候选分配新纪元、解析它的支撑实体行 id，并封好自述与主线。 */
  private prepareIdentity(
    candidate: MemoryIdentityCandidateV2,
    activeIdentity: Nullable<ActiveIdentityEpochRowV2>,
    conceptByCandidate: ReadonlyMap<string, PreparedConceptV2>,
    episodeByCandidate: ReadonlyMap<string, PreparedEpisodeV2>,
    claimByCandidate: ReadonlyMap<string, PreparedClaimV2>,
    seal: (content: string) => PreparedBlobV2
  ): PreparedIdentityV2 {
    return {
      candidate,
      id: this.randomId(),
      sequence: (activeIdentity?.sequence ?? 0) + 1,
      predecessorId: toNullable(activeIdentity?.id),
      statement: seal(candidate.statement),
      globalMainline: seal(candidate.globalMainline),
      supportingConceptIds: candidate.supportingConceptKeys.map(
        (key) => requiredMapValueV2(conceptByCandidate, key, 'identity concept').id
      ),
      supportingEpisodeIds: candidate.supportingEpisodeKeys.map(
        (key) => requiredMapValueV2(episodeByCandidate, key, 'identity episode').id
      ),
      supportingClaimIds: candidate.supportingClaimKeys.map(
        (key) => requiredMapValueV2(claimByCandidate, key, 'identity claim').id
      ),
    }
  }

  /** 读当前还没收尾的身份纪元；一个都没有就是这个库还没建过身份。 */
  private readActiveIdentityEpoch(): Nullable<ActiveIdentityEpochRowV2> {
    return toNullable(
      this.authority.database
        .prepare(
          `SELECT id, sequence
           FROM memory_identity_epochs
           WHERE ended_at IS NULL
           LIMIT 1`
        )
        .get() as ActiveIdentityEpochRowV2 | undefined
    )
  }

  /** 把意义候选的作用域解析成「类型 + 作用域 id + 盲索引键」。 */
  private resolveScope(scope: MemoryMeaningScopeV2): ResolvedMeaningScopeV2 {
    if (scope.type === 'global') return { scopeType: 'global', scopeId: 'global', scopeMatchKey: null }
    if (scope.type === 'workspace') {
      const scopeId = canonicalizeWorkspacePathV2(scope.rootPath)
      return {
        scopeType: 'workspace',
        scopeId,
        scopeMatchKey: this.identityKeys.workspaceScopeMatchKey(scopeId),
      }
    }
    const scopeId = normalizeOriginV2(scope.origin)
    return {
      scopeType: 'origin',
      scopeId,
      scopeMatchKey: this.identityKeys.originScopeMatchKey(scopeId),
    }
  }

  /** 同一个稳定键已经有行就复用它的 id，让 upsert 不至于造出第二行。 */
  private existingId(
    table: 'memory_concepts' | 'memory_episodes' | 'memory_claims',
    stableKey: string
  ): Nullable<string> {
    const row = this.authority.database
      .prepare(`SELECT id FROM ${table} WHERE stable_key = ?`)
      .get(stableKey) as MemoryIdRowV2 | undefined
    return toNullable(row?.id)
  }

  /** 从注入的随机源取行 id；长度不对就是随机源坏了。 */
  private randomId(): string {
    const value = this.random(MemoryMeaningCurationServiceV2.EntityIdByteLength)
    if (
      !Buffer.isBuffer(value) ||
      value.length !== MemoryMeaningCurationServiceV2.EntityIdByteLength
    ) {
      throw new AppError('INVARIANT', 'Meaning 随机源必须返回 16 字节。')
    }
    return value.toString('hex')
  }
}
