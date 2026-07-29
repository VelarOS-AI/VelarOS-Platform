import { randomBytes } from 'node:crypto'

import { AppError } from '@velaros-ai/core/error'

import type { MemoryAuthorityDatabaseV2 } from './AuthorityDatabase'
import type { MemoryTreeDiffOpV2, MemoryTreeNodeStructV2 } from './DiffChain'
import { canonicalStringifyV2, quantizeTreeScoreV2 } from './DiffChain'
import type {
  MemoryDreamRunCoordinatorV2,
  MemoryDreamValidationStatsV2,
} from './DreamRuns'
import type { MemoryPrivacyClassV2 } from './EvidenceIngest'
import {
  canonicalizeWorkspacePathV2,
  type MemoryClaimStableKeyInputV2,
  type MemoryIdentityKeyServiceV2,
  normalizeOriginV2,
} from './IdentityKeys'
import type { ContentKeyServiceV2, MemorySealedContentV2 } from './storage'
import type {
  MemoryTreeAuthorityCommitParticipantV2,
  MemoryTreeIdentityChangeV2,
  MemoryTreeStoreV2,
} from './TreeStore'

const ConceptTypesV2 = new Set([
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
const TrustLevelsV2 = new Set([
  'user_stated',
  'system_observed',
  'agent_derived',
  'external_content',
])
const EpistemicStatusesV2 = new Set([
  'user_confirmed',
  'observed',
  'derived',
  'inferred',
  'disputed',
])
const LifecycleStatesV2 = new Set([
  'transient',
  'candidate',
  'active',
  'consolidated',
  'dormant',
  'reactivated',
])

export type MemoryMeaningScopeV2 =
  | { readonly type: 'global' }
  | { readonly type: 'workspace'; readonly rootPath: string }
  | { readonly type: 'origin'; readonly origin: string }

interface MemoryMeaningCandidateBaseV2 {
  readonly candidateKey: string
  readonly evidenceIds: readonly string[]
}

export interface MemoryConceptCandidateV2 extends MemoryMeaningCandidateBaseV2 {
  readonly kind: 'concept'
  readonly conceptType: string
  readonly name: string
  readonly description?: string | null
  readonly scope: MemoryMeaningScopeV2
  readonly privacyClass: MemoryPrivacyClassV2
  readonly lifecycleState: string
  readonly firstSeenAt: number
  readonly lastActiveAt: number
  readonly salience: number
  readonly activation: number
}

export interface MemoryEpisodeCandidateV2 extends MemoryMeaningCandidateBaseV2 {
  readonly kind: 'episode'
  readonly episodeType: string
  readonly title: string
  readonly summary?: string | null
  readonly state: string
  readonly startedAt: number
  readonly endedAt?: number | null
  readonly scope: MemoryMeaningScopeV2
  readonly primaryConceptKey: string
  readonly phase: string
  readonly result?: string | null
  readonly salience: number
  readonly activation: number
}

export interface MemoryClaimCandidateV2 extends MemoryMeaningCandidateBaseV2 {
  readonly kind: 'claim'
  readonly subjectConceptKey: string
  readonly predicate: string
  readonly title: string
  readonly value: unknown
  readonly summary?: string | null
  readonly storageMode: 'full' | 'index_only' | 'reference'
  readonly payloadRef?: string | null
  readonly epistemicStatus: string
  readonly confidence: number
  readonly privacyClass: MemoryPrivacyClassV2
  readonly lifecycleState: string
  readonly validFrom: number
  readonly validTo?: number | null
  readonly salience: number
  readonly consolidationStrength: number
  readonly activation: number
}

export type MemoryMeaningEntityKindV2 = 'concept' | 'episode' | 'claim'

export interface MemoryRelationCandidateV2 extends MemoryMeaningCandidateBaseV2 {
  readonly kind: 'relation'
  readonly source: {
    readonly kind: MemoryMeaningEntityKindV2
    readonly candidateKey: string
  }
  readonly target: {
    readonly kind: MemoryMeaningEntityKindV2
    readonly candidateKey: string
  }
  readonly relationType: string
  readonly confidence: number
  readonly epistemicStatus: string
  readonly validFrom: number
  readonly validTo?: number | null
  readonly activation: number
}

export type MemoryMeaningCandidateV2 =
  | MemoryConceptCandidateV2
  | MemoryEpisodeCandidateV2
  | MemoryClaimCandidateV2
  | MemoryRelationCandidateV2

export interface MemoryIdentityCandidateV2 {
  readonly statement: string
  readonly globalMainline: string
  readonly confidence: number
  readonly evidenceIds: readonly string[]
  readonly supportingConceptKeys: readonly string[]
  readonly supportingEpisodeKeys: readonly string[]
  readonly supportingClaimKeys: readonly string[]
}

export interface MemoryMeaningProposalV2 {
  readonly candidates: readonly MemoryMeaningCandidateV2[]
  readonly identity?: MemoryIdentityCandidateV2 | null
}

export interface MemoryMeaningCandidateDecisionV2 {
  readonly candidateKey: string
  readonly kind: MemoryMeaningCandidateV2['kind'] | 'identity'
  readonly decision: 'accepted' | 'rejected' | 'revised'
  readonly reasons: readonly string[]
}

export interface MemoryMeaningCurationResultV2 {
  readonly treeVersion: number
  readonly acceptedCount: number
  readonly rejectedCount: number
  readonly decisions: readonly MemoryMeaningCandidateDecisionV2[]
}

interface EvidenceTrustRowV2 {
  id: string
  trust_level: string
  eligibility_state: string
}

interface AcceptedMeaningProposalV2 {
  concepts: MemoryConceptCandidateV2[]
  episodes: MemoryEpisodeCandidateV2[]
  claims: MemoryClaimCandidateV2[]
  relations: MemoryRelationCandidateV2[]
  identity: MemoryIdentityCandidateV2 | null
  decisions: MemoryMeaningCandidateDecisionV2[]
  candidateCount: number
}

interface ResolvedMeaningScopeV2 {
  scopeType: string
  scopeId: string
  scopeMatchKey: string | null
}

interface PreparedBlobV2 extends MemorySealedContentV2 {
  content: string
}

interface PreparedConceptV2 {
  candidate: MemoryConceptCandidateV2
  id: string
  stableKey: string
  scope: ResolvedMeaningScopeV2
  nameMatchKey: string
  name: PreparedBlobV2
  description: PreparedBlobV2 | null
}

interface PreparedEpisodeV2 {
  candidate: MemoryEpisodeCandidateV2
  id: string
  stableKey: string
  scope: ResolvedMeaningScopeV2
  primaryConcept: PreparedConceptV2
  title: PreparedBlobV2
  summary: PreparedBlobV2 | null
  result: PreparedBlobV2 | null
}

interface PreparedClaimV2 {
  candidate: MemoryClaimCandidateV2
  id: string
  stableKey: string
  groupKey: string
  subjectConcept: PreparedConceptV2
  value: PreparedBlobV2
  summary: PreparedBlobV2 | null
}

interface PreparedRelationV2 {
  candidate: MemoryRelationCandidateV2
  id: string
  sourceId: string
  targetId: string
}

interface PreparedIdentityV2 {
  candidate: MemoryIdentityCandidateV2
  id: string
  sequence: number
  predecessorId: string | null
  statement: PreparedBlobV2
  globalMainline: PreparedBlobV2
  supportingConceptIds: readonly string[]
  supportingEpisodeIds: readonly string[]
  supportingClaimIds: readonly string[]
}

interface PreparedMeaningCommitV2 {
  participant: MemoryTreeAuthorityCommitParticipantV2
  ops: readonly MemoryTreeDiffOpV2[]
  identityChange: MemoryTreeIdentityChangeV2 | null
  activeIdentityEpochId: string
  globalMainlineNodeId: string
  cleanupAfterFailure(): void
}

/**
 * 模型只提供候选；本服务重新计算身份、信任上限、谱系、密文与树投影，并原子发布。
 */
export class MemoryMeaningCurationServiceV2 {
  constructor(
    private readonly authority: MemoryAuthorityDatabaseV2,
    private readonly contentKeys: ContentKeyServiceV2,
    private readonly identityKeys: MemoryIdentityKeyServiceV2,
    private readonly treeStore: MemoryTreeStoreV2,
    private readonly dreamRuns: MemoryDreamRunCoordinatorV2,
    private readonly random: (byteLength: number) => Buffer = randomBytes
  ) {}

  public curateAndCommit(input: {
    runId: string
    proposal: MemoryMeaningProposalV2
    tokenUsage: number
    committedAt?: number
  }): MemoryMeaningCurationResultV2 {
    const accepted = this.validateProposal(input.proposal)
    const stats: MemoryDreamValidationStatsV2 = {
      tokenUsage: input.tokenUsage,
      candidateCount: accepted.candidateCount,
      acceptedCount: accepted.decisions.filter((item) => item.decision !== 'rejected').length,
      rejectedCount: accepted.decisions.filter((item) => item.decision === 'rejected').length,
    }
    let prepared: PreparedMeaningCommitV2 | null = null
    try {
      if (stats.acceptedCount > 0) prepared = this.prepareCommit(input.runId, accepted)
      this.dreamRuns.markValidating(
        input.runId,
        {
          format: 'velaros.memory.candidate-ledger.v2',
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
        this.dreamRuns.commitNoop(
          input.runId,
          stats,
          input.committedAt ?? Date.now()
        )
      } else if (prepared.ops.length === 0 && prepared.identityChange === null) {
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
        // run 可能尚未进入 running/validating，或 tree+run 已原子提交；原错误优先。
      }
      throw error
    }
  }

  private validateProposal(proposal: MemoryMeaningProposalV2): AcceptedMeaningProposalV2 {
    const decisions: MemoryMeaningCandidateDecisionV2[] = []
    const seen = new Set<string>()
    const conceptCandidates = new Map(
      proposal.candidates
        .filter(
          (candidate): candidate is MemoryConceptCandidateV2 =>
            candidate.kind === 'concept'
        )
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
      let revised = false
      let acceptedCandidate: MemoryMeaningCandidateV2 = candidate
      if (trust.externalOnly) {
        if (
          candidate.kind === 'concept' &&
          (candidate.conceptType === 'user' || candidate.conceptType === 'preference')
        ) {
          reasons.push('external_content_cannot_create_profile')
        }
        if (candidate.kind === 'claim') {
          acceptedCandidate = {
            ...candidate,
            epistemicStatus: 'inferred',
            confidence: Math.min(candidate.confidence, 0.4),
          }
          revised =
            acceptedCandidate.epistemicStatus !== candidate.epistemicStatus ||
            acceptedCandidate.confidence !== candidate.confidence
        }
      }
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
        if (governanceType) {
          reasons.push(`legacy_governance_denied:${governanceType}`)
        }
      }
      if (reasons.length > 0) {
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
        decision: revised ? 'revised' : 'accepted',
        reasons: revised ? ['external_content_trust_cap'] : [],
      })
      if (acceptedCandidate.kind === 'concept') concepts.push(acceptedCandidate)
      if (acceptedCandidate.kind === 'episode') episodes.push(acceptedCandidate)
      if (acceptedCandidate.kind === 'claim') claims.push(acceptedCandidate)
      if (acceptedCandidate.kind === 'relation') relations.push(acceptedCandidate)
    }

    const acceptedKeys = new Set([
      ...concepts.map((item) => item.candidateKey),
      ...episodes.map((item) => item.candidateKey),
      ...claims.map((item) => item.candidateKey),
    ])
    rejectBrokenDependenciesV2(episodes, claims, relations, acceptedKeys, decisions)
    const rejectedKeys = new Set(
      decisions
        .filter((item) => item.decision === 'rejected')
        .map((item) => item.candidateKey)
    )
    let identity: MemoryIdentityCandidateV2 | null = null
    if (proposal.identity) {
      const reasons = validateIdentityShapeV2(proposal.identity)
      const trust = this.readEvidenceTrust(proposal.identity.evidenceIds)
      reasons.push(...trust.reasons)
      if (trust.externalOnly) reasons.push('external_content_cannot_support_identity')
      if (
        [...proposal.identity.supportingConceptKeys,
        ...proposal.identity.supportingEpisodeKeys,
        ...proposal.identity.supportingClaimKeys].some((key) => rejectedKeys.has(key))
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
        decision: reasons.length === 0 ? 'accepted' : 'rejected',
        reasons,
      })
      if (reasons.length === 0) identity = proposal.identity
    }

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

  private readEvidenceTrust(evidenceIds: readonly string[]): {
    levels: string[]
    externalOnly: boolean
    reasons: string[]
  } {
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
      if (!TrustLevelsV2.has(row.trust_level)) reasons.push(`unknown_trust_level:${evidenceId}`)
      if (row.eligibility_state !== 'active') reasons.push(`evidence_not_active:${evidenceId}`)
      if (denied.get(evidenceId)) reasons.push(`evidence_denied:${evidenceId}`)
      levels.push(row.trust_level)
    }
    return {
      levels,
      externalOnly: levels.length > 0 && levels.every((level) => level === 'external_content'),
      reasons,
    }
  }

  private readLegacyGovernanceDeny(
    claim: MemoryClaimCandidateV2,
    concept: MemoryConceptCandidateV2 | undefined
  ): 'forgotten' | 'superseded' | 'erased' | null {
    if (!concept) return null
    let scope: ResolvedMeaningScopeV2
    try {
      scope = this.resolveScope(concept.scope)
    } catch {
      return null
    }
    const conceptStableKey = this.identityKeys.conceptStableKey({
      conceptType: concept.conceptType,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      discriminator: concept.name,
    })
    const targetMatchKey = this.identityKeys.claimGovernanceMatchKey({
      conceptStableKey,
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
      .get(targetMatchKey) as
      | { governance_type: 'forgotten' | 'superseded' | 'erased' }
      | undefined
    return row?.governance_type ?? null
  }

  private prepareCommit(
    runId: string,
    proposal: AcceptedMeaningProposalV2
  ): PreparedMeaningCommitV2 {
    const createdAt = Date.now()
    const blobs: PreparedBlobV2[] = []
    const seal = (content: string): PreparedBlobV2 => {
      const sealed = this.contentKeys.sealContent(content)
      const prepared = { ...sealed, content }
      blobs.push(prepared)
      return prepared
    }
    try {
      const concepts = proposal.concepts.map((candidate) => {
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
      const conceptByCandidate = new Map(
        concepts.map((item) => [item.candidate.candidateKey, item])
      )
      const episodes = proposal.episodes.map((candidate) => {
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
      const episodeByCandidate = new Map(
        episodes.map((item) => [item.candidate.candidateKey, item])
      )
      const claims = proposal.claims.map((candidate) => {
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
      const claimByCandidate = new Map(
        claims.map((item) => [item.candidate.candidateKey, item])
      )
      const entityMaps: Record<
        MemoryMeaningEntityKindV2,
        ReadonlyMap<string, { id: string }>
      > = {
        concept: conceptByCandidate,
        episode: episodeByCandidate,
        claim: claimByCandidate,
      }
      const relations = proposal.relations.map((candidate) => {
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
          ) as { id: string } | undefined
        return {
          candidate,
          id: existing?.id ?? this.randomId(),
          sourceId,
          targetId,
        }
      })
      const activeIdentity = this.authority.database
        .prepare(
          `SELECT id, sequence
           FROM memory_identity_epochs
           WHERE ended_at IS NULL
           LIMIT 1`
        )
        .get() as { id: string; sequence: number } | undefined
      let identity: PreparedIdentityV2 | null = null
      if (proposal.identity) {
        identity = {
          candidate: proposal.identity,
          id: this.randomId(),
          sequence: (activeIdentity?.sequence ?? 0) + 1,
          predecessorId: activeIdentity?.id ?? null,
          statement: seal(proposal.identity.statement),
          globalMainline: seal(proposal.identity.globalMainline),
          supportingConceptIds: proposal.identity.supportingConceptKeys.map(
            (key) => requiredMapValueV2(conceptByCandidate, key, 'identity concept').id
          ),
          supportingEpisodeIds: proposal.identity.supportingEpisodeKeys.map(
            (key) => requiredMapValueV2(episodeByCandidate, key, 'identity episode').id
          ),
          supportingClaimIds: proposal.identity.supportingClaimKeys.map(
            (key) => requiredMapValueV2(claimByCandidate, key, 'identity claim').id
          ),
        }
      }
      if (!identity && !activeIdentity) {
        throw new AppError('VALIDATION', '首个意义提交必须建立 Identity Epoch。')
      }

      const activeIdentityEpochId = identity?.id ?? activeIdentity!.id
      const globalMainlineNodeId = `identity:${activeIdentityEpochId}`
      const desiredNodes = buildMeaningTreeNodesV2({
        current: this.treeStore.current.nodes,
        concepts,
        episodes,
        claims,
        identity,
        activeIdentityEpochId,
        globalMainlineNodeId,
        createdAt,
      })
      const ops = buildMeaningTreeOpsV2(this.treeStore.current.nodes, desiredNodes)
      const participant: MemoryTreeAuthorityCommitParticipantV2 = {
        apply: () => {
          for (const blob of blobs) registerBlobV2(this.authority, blob, createdAt)
          persistConceptsV2(this.authority, concepts, runId, createdAt)
          persistEpisodesV2(this.authority, episodes, runId, createdAt)
          persistClaimsV2(this.authority, claims, runId, createdAt)
          persistRelationsV2(this.authority, relations, runId, createdAt)
          if (identity) persistIdentityV2(this.authority, identity, runId, createdAt)
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

  private existingId(table: 'memory_concepts' | 'memory_episodes' | 'memory_claims', stableKey: string): string | null {
    const row = this.authority.database
      .prepare(`SELECT id FROM ${table} WHERE stable_key = ?`)
      .get(stableKey) as { id: string } | undefined
    return row?.id ?? null
  }

  private randomId(): string {
    const value = this.random(16)
    if (!Buffer.isBuffer(value) || value.length !== 16) {
      throw new AppError('INVARIANT', 'Meaning 随机源必须返回 16 字节。')
    }
    return value.toString('hex')
  }
}

function validateCandidateShapeV2(candidate: MemoryMeaningCandidateV2): string[] {
  const reasons: string[] = []
  if (!candidate.candidateKey) reasons.push('missing_candidate_key')
  if (candidate.evidenceIds.length === 0) reasons.push('missing_evidence')
  if (candidate.kind === 'concept') {
    if (!ConceptTypesV2.has(candidate.conceptType)) reasons.push('invalid_concept_type')
    if (!candidate.name) reasons.push('missing_concept_name')
    if (!LifecycleStatesV2.has(candidate.lifecycleState)) reasons.push('invalid_lifecycle')
    validateScoreV2(candidate.salience, 'salience', reasons)
    validateScoreV2(candidate.activation, 'activation', reasons)
  }
  if (candidate.kind === 'episode') {
    if (!candidate.episodeType || !candidate.title || !candidate.state || !candidate.phase) {
      reasons.push('missing_episode_structure')
    }
    if (candidate.endedAt !== null && candidate.endedAt !== undefined && candidate.endedAt < candidate.startedAt) {
      reasons.push('episode_time_reversed')
    }
    validateScoreV2(candidate.salience, 'salience', reasons)
    validateScoreV2(candidate.activation, 'activation', reasons)
  }
  if (candidate.kind === 'claim') {
    if (!candidate.predicate || !candidate.title) reasons.push('missing_claim_structure')
    if (!EpistemicStatusesV2.has(candidate.epistemicStatus)) reasons.push('invalid_epistemic_status')
    if (!LifecycleStatesV2.has(candidate.lifecycleState)) reasons.push('invalid_lifecycle')
    validateScoreV2(candidate.confidence, 'confidence', reasons)
    validateScoreV2(candidate.salience, 'salience', reasons)
    validateScoreV2(candidate.consolidationStrength, 'consolidation', reasons)
    validateScoreV2(candidate.activation, 'activation', reasons)
  }
  if (candidate.kind === 'relation') {
    if (!candidate.relationType) reasons.push('missing_relation_type')
    if (!EpistemicStatusesV2.has(candidate.epistemicStatus)) reasons.push('invalid_epistemic_status')
    validateScoreV2(candidate.confidence, 'confidence', reasons)
    validateScoreV2(candidate.activation, 'activation', reasons)
  }
  return reasons
}

function validateIdentityShapeV2(candidate: MemoryIdentityCandidateV2): string[] {
  const reasons: string[] = []
  if (!candidate.statement || !candidate.globalMainline) reasons.push('missing_identity_content')
  if (candidate.evidenceIds.length === 0) reasons.push('missing_evidence')
  validateScoreV2(candidate.confidence, 'confidence', reasons)
  return reasons
}

function validateScoreV2(value: number, label: string, reasons: string[]): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) reasons.push(`invalid_${label}`)
}

function rejectBrokenDependenciesV2(
  episodes: readonly MemoryEpisodeCandidateV2[],
  claims: readonly MemoryClaimCandidateV2[],
  relations: readonly MemoryRelationCandidateV2[],
  acceptedKeys: Set<string>,
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
    decisions
      .filter((item) => item.decision === 'rejected')
      .map((item) => item.candidateKey)
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

function buildMeaningTreeNodesV2(input: {
  current: readonly MemoryTreeNodeStructV2[]
  concepts: readonly PreparedConceptV2[]
  episodes: readonly PreparedEpisodeV2[]
  claims: readonly PreparedClaimV2[]
  identity: PreparedIdentityV2 | null
  activeIdentityEpochId: string
  globalMainlineNodeId: string
  createdAt: number
}): MemoryTreeNodeStructV2[] {
  const nodes: MemoryTreeNodeStructV2[] = []
  if (!input.current.some((node) => node.stableKey === 'root')) {
    nodes.push({
      stableKey: 'root',
      parentKey: null,
      nodeType: 'root',
      namespace: 'root',
      subjectType: 'root',
      subjectId: 'root',
      content: { blobRef: null, commitment: `c2:${'0'.repeat(64)}`, redacted: false },
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

function buildMeaningTreeOpsV2(
  current: readonly MemoryTreeNodeStructV2[],
  desired: readonly MemoryTreeNodeStructV2[]
): MemoryTreeDiffOpV2[] {
  const currentByKey = new Map(current.map((node) => [node.stableKey, node]))
  return [...desired]
    .sort((left, right) => (left.stableKey < right.stableKey ? -1 : left.stableKey > right.stableKey ? 1 : 0))
    .flatMap((node): MemoryTreeDiffOpV2[] => {
      const existing = currentByKey.get(node.stableKey)
      if (!existing) return [{ type: 'add', before: [], after: [node] }]
      if (canonicalStringifyV2(existing) === canonicalStringifyV2(node)) return []
      return [{ type: 'update', before: [existing], after: [node] }]
    })
}

function persistConceptsV2(
  authority: MemoryAuthorityDatabaseV2,
  concepts: readonly PreparedConceptV2[],
  runId: string,
  createdAt: number
): void {
  for (const item of concepts) {
    authority.database
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
        item.description?.blobId ?? null,
        item.description?.commitment ?? null,
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
    const persisted = authority.database
      .prepare(`SELECT id FROM memory_concepts WHERE stable_key = ?`)
      .pluck()
      .get(item.stableKey) as string
    for (const evidenceId of item.candidate.evidenceIds) {
      authority.database
        .prepare(
          `INSERT INTO memory_concept_evidence(concept_id, evidence_id, weight, created_at)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(concept_id, evidence_id) DO NOTHING`
        )
        .run(persisted, evidenceId, createdAt)
    }
    authority.database
      .prepare(
        `UPDATE memory_concepts
         SET evidence_count = (
           SELECT count(*) FROM memory_concept_evidence WHERE concept_id = ?
         )
         WHERE id = ?`
      )
      .run(persisted, persisted)
    void runId
  }
}

function persistEpisodesV2(
  authority: MemoryAuthorityDatabaseV2,
  episodes: readonly PreparedEpisodeV2[],
  runId: string,
  createdAt: number
): void {
  for (const item of episodes) {
    authority.database
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
        item.summary?.blobId ?? null,
        item.summary?.commitment ?? null,
        item.candidate.state,
        item.candidate.startedAt,
        item.candidate.endedAt ?? null,
        item.scope.scopeType,
        item.scope.scopeMatchKey,
        item.primaryConcept.id,
        item.result?.blobId ?? null,
        item.result?.commitment ?? null,
        runId,
        item.candidate.salience,
        item.candidate.activation,
        item.candidate.endedAt ?? item.candidate.startedAt,
        createdAt,
        createdAt
      )
    const persisted = authority.database
      .prepare(`SELECT id FROM memory_episodes WHERE stable_key = ?`)
      .pluck()
      .get(item.stableKey) as string
    authority.database
      .prepare(
        `INSERT INTO memory_episode_concepts(episode_id, concept_id, role, weight)
         VALUES (?, ?, 'primary', 1)
         ON CONFLICT(episode_id, concept_id, role) DO UPDATE SET weight = excluded.weight`
      )
      .run(persisted, item.primaryConcept.id)
    for (const evidenceId of item.candidate.evidenceIds) {
      authority.database
        .prepare(
          `INSERT INTO memory_episode_evidence(episode_id, evidence_id, weight, created_at)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(episode_id, evidence_id) DO NOTHING`
        )
        .run(persisted, evidenceId, createdAt)
    }
  }
}

function persistClaimsV2(
  authority: MemoryAuthorityDatabaseV2,
  claims: readonly PreparedClaimV2[],
  runId: string,
  createdAt: number
): void {
  for (const item of claims) {
    authority.database
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
        item.candidate.payloadRef ?? null,
        item.summary?.blobId ?? null,
        item.summary?.commitment ?? null,
        item.candidate.epistemicStatus,
        item.candidate.confidence,
        item.candidate.privacyClass,
        item.candidate.lifecycleState,
        item.candidate.validFrom,
        item.candidate.validTo ?? null,
        runId,
        item.candidate.salience,
        item.candidate.consolidationStrength,
        item.candidate.activation,
        item.candidate.validTo ?? item.candidate.validFrom,
        createdAt,
        createdAt
      )
    const persisted = authority.database
      .prepare(`SELECT id FROM memory_claims WHERE stable_key = ?`)
      .pluck()
      .get(item.stableKey) as string
    for (const evidenceId of item.candidate.evidenceIds) {
      authority.database
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

function persistRelationsV2(
  authority: MemoryAuthorityDatabaseV2,
  relations: readonly PreparedRelationV2[],
  runId: string,
  createdAt: number
): void {
  for (const item of relations) {
    authority.database
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
        item.candidate.validTo ?? null,
        runId,
        item.candidate.activation,
        item.candidate.validTo ?? item.candidate.validFrom,
        createdAt,
        createdAt
      )
    const persisted = authority.database
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
      authority.database
        .prepare(
          `INSERT INTO memory_relation_evidence(relation_id, evidence_id, weight)
           VALUES (?, ?, 1)
           ON CONFLICT(relation_id, evidence_id) DO UPDATE SET weight = excluded.weight`
        )
        .run(persisted, evidenceId)
    }
  }
}

function persistIdentityV2(
  authority: MemoryAuthorityDatabaseV2,
  identity: PreparedIdentityV2,
  runId: string,
  createdAt: number
): void {
  if (identity.predecessorId) {
    const ended = authority.database
      .prepare(`UPDATE memory_identity_epochs SET ended_at = ? WHERE id = ? AND ended_at IS NULL`)
      .run(createdAt, identity.predecessorId)
    if (ended.changes !== 1) throw new AppError('CONFLICT', 'Identity predecessor CAS 失败。')
  }
  authority.database
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

function requiredMapValueV2<T>(
  map: ReadonlyMap<string, T>,
  key: string,
  label: string
): T {
  const value = map.get(key)
  if (!value) throw new AppError('VALIDATION', `${label} 引用了未接受候选。`, undefined, { key })
  return value
}
