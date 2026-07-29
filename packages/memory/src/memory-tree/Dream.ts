import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'

import { first, isEmpty, last, toNullable,trimmedStringOrEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import type {
  MemoryClaimRow,
  MemoryConceptRow,
  MemoryEpisodeRow,
  MemoryIdentityEpochRow,
} from './Repository'
import { type MemoryTreeRepository } from './Repository'
import {
  extractDeterministicSemanticCandidates,
  type MemorySemanticCandidate,
} from './SemanticExtraction'
import {
  buildTreeOps,
  hashTreeEvent,
  hashTreeNodes,
  validateTreeProjection,
} from './TreeProjection'
import type {
  MemoryConceptType,
  MemoryDreamRunOptions,
  MemoryDreamRunResult,
  MemoryEvidenceCategory,
  MemoryEvidenceRecord,
  MemoryTreeNodeRecord,
} from './Types'

const log = logRuntime.tag('MemoryDream')
const DefaultDreamBatchSize = 200

interface ConsolidationResult {
  evidence: MemoryEvidenceRecord
  concept: MemoryConceptRow
  episode: MemoryEpisodeRow
  claim: MemoryClaimRow
}

interface ConsolidationViewOptions {
  semantic?: MemorySemanticCandidate
  sharedEpisode?: MemoryEpisodeRow
}

interface ConceptDescriptor {
  type: MemoryConceptType
  name: string
  stableDiscriminator: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${sha256(value).slice(0, 24)}`
}

function normalizeIdentityText(value: string): string {
  // 保留字母/数字与 + # . 等区分性符号，其余标点/空白折叠为单空格。
  // 旧实现剥掉全部 \p{P}\p{S}，会让 C++ / C# / C 归一成同一 stable_key 而被错误合并。
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, ' ')
    .trim()
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function readMetadataString(evidence: MemoryEvidenceRecord, key: string): string {
  const value = evidence.metadata[key]
  return trimmedStringOrEmpty(value)
}

function evidenceTitle(evidence: MemoryEvidenceRecord): string {
  return (
    evidence.title.trim() ||
    readMetadataString(evidence, 'sessionTitle') ||
    truncate(first(evidence.content.split('\n')) ?? evidence.content, 72) ||
    '未命名记忆'
  )
}

function resolveConceptDescriptor(evidence: MemoryEvidenceRecord): ConceptDescriptor {
  const title = evidenceTitle(evidence)
  const projectName = evidence.workspaceRoot ? basename(evidence.workspaceRoot) : ''
  switch (evidence.category) {
    case 'preference':
      return { type: 'user', name: '用户偏好', stableDiscriminator: 'user:preferences' }
    case 'feedback':
      return { type: 'user', name: '协作方式', stableDiscriminator: 'user:collaboration' }
    case 'interest':
      return { type: 'interest', name: title, stableDiscriminator: title }
    case 'procedure':
      return { type: 'procedure', name: title, stableDiscriminator: title }
    case 'goal':
      return { type: 'goal', name: title, stableDiscriminator: title }
    case 'task':
      return {
        type: 'task',
        name: title,
        stableDiscriminator: readMetadataString(evidence, 'taskKey') || title,
      }
    case 'project':
      return {
        type: 'project',
        name: projectName || title,
        stableDiscriminator: evidence.workspaceRoot || title,
      }
    case 'entity':
      return { type: 'entity', name: title, stableDiscriminator: title }
    case 'artifact':
      return { type: 'artifact', name: title, stableDiscriminator: title }
    case 'conversation': {
      const sessionTitle = readMetadataString(evidence, 'sessionTitle')
      if (evidence.workspaceRoot) return {
          type: 'task',
          name: sessionTitle || title,
          stableDiscriminator: evidence.sessionId || sessionTitle || title,
        }
      return {
        type: 'conversation',
        name: sessionTitle || title,
        stableDiscriminator: evidence.sessionId || sessionTitle || title,
      }
    }
    case 'fact':
    default:
      if (evidence.workspaceRoot) return {
          type: 'project',
          name: projectName || title,
          stableDiscriminator: evidence.workspaceRoot,
        }
      return { type: 'entity', name: title, stableDiscriminator: title }
  }
}

function predicateForCategory(category: MemoryEvidenceCategory): string {
  const predicates: Record<MemoryEvidenceCategory, string> = {
    conversation: 'conversation_observation',
    fact: 'has_fact',
    preference: 'prefers',
    feedback: 'collaboration_feedback',
    procedure: 'uses_procedure',
    project: 'works_on',
    task: 'performs_task',
    goal: 'pursues_goal',
    interest: 'interested_in',
    entity: 'knows_entity',
    artifact: 'produces_artifact',
  }
  return predicates[category]
}

function confidenceForEvidence(evidence: MemoryEvidenceRecord): number {
  switch (evidence.trustLevel) {
    case 'user_stated':
      return 0.96
    case 'system_observed':
      return 0.88
    case 'agent_derived':
      return 0.68
    case 'external_content':
      return 0.42
  }
}

function epistemicStatusForEvidence(evidence: MemoryEvidenceRecord): string {
  switch (evidence.trustLevel) {
    case 'user_stated':
      return 'user_confirmed'
    case 'system_observed':
      return 'observed'
    case 'agent_derived':
    case 'external_content':
      return 'inferred'
  }
}

function salienceForEvidence(evidence: MemoryEvidenceRecord): number {
  const categoryWeight: Record<MemoryEvidenceCategory, number> = {
    conversation: 0.46,
    fact: 0.62,
    preference: 0.82,
    feedback: 0.86,
    procedure: 0.72,
    project: 0.76,
    task: 0.7,
    goal: 0.88,
    interest: 0.68,
    entity: 0.58,
    artifact: 0.66,
  }
  return Math.min(1, categoryWeight[evidence.category] + (evidence.trustLevel === 'user_stated' ? 0.06 : 0))
}

export class MemoryDream {
  private running = false
  constructor(private readonly repository: MemoryTreeRepository) {}

  /** 不消费新 Evidence，只把当前意义模型重新投影为一个新树版本。 */
  public reproject(runId: string = randomUUID()): number {
    const currentEpoch = this.repository.getActiveIdentityEpoch()
    if (!currentEpoch) return this.repository.getMetaInteger('tree_version')
    return this.repository.transaction(() =>
      this.projectTree({
        runId,
        frontierAfter: this.repository.getMetaInteger('dream_frontier'),
        // 重投影是维护/治理动作（衰减、遗忘、来源失效后重算），只刷新支撑不推动身份跃迁。
        activeEpoch: isEmpty(this.repository.getTopActiveConcepts(1))
          ? currentEpoch
          : this.reconcileIdentity(runId, [], false),
        consolidated: [],
      })
    )
  }

  public run(options: MemoryDreamRunOptions): MemoryDreamRunResult {
    if (this.running) {
      const frontier = this.repository.getMetaInteger('dream_frontier')
      const version = this.repository.getMetaInteger('tree_version')
      return {
        runId: '',
        state: 'skipped',
        frontierBefore: frontier,
        frontierAfter: frontier,
        candidateCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        treeVersionBefore: version,
        treeVersionAfter: version,
      }
    }
    // running 标志的复位统一交给这里的 finally：run() 与 try 之间任何读操作抛错（如
    // listPendingEvidence）都不会再把标志永久卡死、让此后所有 Dream 静默 skipped。
    this.running = true
    try {
      return this.runBatch(options)
    } finally {
      this.running = false
    }
  }

  private runBatch(options: MemoryDreamRunOptions): MemoryDreamRunResult {
    const frontierBefore = this.repository.getMetaInteger('dream_frontier')
    const treeVersionBefore = this.repository.getMetaInteger('tree_version')
    const evidence = this.repository.listPendingEvidence(
      Math.max(1, options.maxEvidence ?? DefaultDreamBatchSize)
    )
    if (isEmpty(evidence)) {
      if (options.trigger === 'idle') return this.runIdleMaintenance(options, frontierBefore, treeVersionBefore)
      return {
        runId: '',
        state: 'skipped',
        frontierBefore,
        frontierAfter: frontierBefore,
        candidateCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        treeVersionBefore,
        treeVersionAfter: treeVersionBefore,
      }
    }

    const frontierAfter = last(evidence)!.ingestSequence
    const fingerprint = sha256(
      JSON.stringify({
        frontierBefore,
        frontierAfter,
        evidenceIds: evidence.map((item) => item.id),
        projector: 'deterministic-v2-semantic',
      })
    )
    const existing = this.repository.findDreamRunByFingerprint(fingerprint)
    if (existing?.state === 'committed') {
      this.repository.transaction(() => {
        this.repository.markEvidenceProcessed(
          evidence.map((item) => item.id),
          existing.id
        )
        this.repository.setMetaInteger('dream_frontier', Math.max(frontierBefore, frontierAfter))
      })
      return {
        runId: existing.id,
        state: 'skipped',
        frontierBefore: existing.frontier_before,
        frontierAfter: existing.frontier_after,
        candidateCount: existing.candidate_count,
        acceptedCount: existing.accepted_count,
        rejectedCount: existing.rejected_count,
        treeVersionBefore: existing.tree_version_before,
        treeVersionAfter: existing.tree_version_after,
      }
    }

    const runId = this.repository.startDreamRun({
      id: randomUUID(),
      trigger: options.trigger,
      fingerprint,
      frontierBefore,
      frontierAfter,
      candidateCount: evidence.length,
      treeVersionBefore,
      startedAt: Date.now(),
    })

    try {
      return this.repository.transaction(() => {
        options.abortSignal?.throwIfAborted()
        const consolidated = evidence.flatMap((item) => {
          options.abortSignal?.throwIfAborted()
          return this.consolidateEvidence(item, runId)
        })
        options.abortSignal?.throwIfAborted()
        // 即时整理不得推动身份跃迁：全局主线翻转是「量变到质变」的重大变化（R-008/R-038），
        // 只在批量整理（startup/idle 积压）时允许，否则单条消息就能让主干身份抖动。
        const activeEpoch = this.reconcileIdentity(runId, consolidated, options.trigger !== 'immediate')
        const treeVersionAfter = this.projectTree({
          runId,
          frontierAfter,
          activeEpoch,
          consolidated,
        })
        this.repository.markEvidenceProcessed(
          evidence.map((item) => item.id),
          runId
        )
        this.repository.setMetaInteger('dream_frontier', Math.max(frontierBefore, frontierAfter))
        this.repository.finishDreamRun({
          id: runId,
          state: 'committed',
          acceptedCount: evidence.length,
          rejectedCount: 0,
          frontierAfter,
          treeVersionAfter,
        })
        return {
          runId,
          state: 'committed',
          frontierBefore,
          frontierAfter,
          candidateCount: evidence.length,
          acceptedCount: evidence.length,
          rejectedCount: 0,
          treeVersionBefore,
          treeVersionAfter,
        }
      })
    } catch (error) {
      const message = AppError.getMessage(error)
      const cancelled = !!options.abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')
      this.repository.finishDreamRun({
        id: runId,
        state: cancelled ? 'cancelled' : 'failed',
        acceptedCount: 0,
        rejectedCount: evidence.length,
        frontierAfter: frontierBefore,
        treeVersionAfter: treeVersionBefore,
        error: message,
      })
      if (cancelled) return {
          runId,
          state: 'cancelled',
          frontierBefore,
          frontierAfter: frontierBefore,
          candidateCount: evidence.length,
          acceptedCount: 0,
          rejectedCount: evidence.length,
          treeVersionBefore,
          treeVersionAfter: treeVersionBefore,
        }
      log.error('memory dream failed', { runId, error })
      throw error
    }
  }

  private runIdleMaintenance(
    options: MemoryDreamRunOptions,
    frontier: number,
    treeVersionBefore: number
  ): MemoryDreamRunResult {
    const dayBucket = Math.floor(Date.now() / 86_400_000)
    const fingerprint = sha256(
      JSON.stringify({
        kind: 'natural-decay',
        dayBucket,
        frontier,
        treeVersionBefore,
        projector: 'deterministic-v1',
      })
    )
    const existing = this.repository.findDreamRunByFingerprint(fingerprint)
    if (existing?.state === 'committed' || existing?.state === 'skipped') return {
        runId: existing.id,
        state: 'skipped',
        frontierBefore: frontier,
        frontierAfter: frontier,
        candidateCount: 0,
        acceptedCount: existing.accepted_count,
        rejectedCount: 0,
        treeVersionBefore,
        treeVersionAfter: existing.tree_version_after,
      }

    const runId = this.repository.startDreamRun({
      id: randomUUID(),
      trigger: 'idle',
      fingerprint,
      frontierBefore: frontier,
      frontierAfter: frontier,
      candidateCount: 0,
      treeVersionBefore,
      startedAt: Date.now(),
    })
    try {
      return this.repository.transaction(() => {
        options.abortSignal?.throwIfAborted()
        const decayedCount = this.repository.applyNaturalDecay(Date.now())
        const treeVersionAfter = decayedCount > 0 ? this.reproject(runId) : treeVersionBefore
        const state = decayedCount > 0 ? 'committed' : 'skipped'
        this.repository.finishDreamRun({
          id: runId,
          state,
          acceptedCount: decayedCount,
          rejectedCount: 0,
          frontierAfter: frontier,
          treeVersionAfter,
        })
        return {
          runId,
          state,
          frontierBefore: frontier,
          frontierAfter: frontier,
          candidateCount: 0,
          acceptedCount: decayedCount,
          rejectedCount: 0,
          treeVersionBefore,
          treeVersionAfter,
        }
      })
    } catch (error) {
      const cancelled = !!options.abortSignal?.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      this.repository.finishDreamRun({
        id: runId,
        state: cancelled ? 'cancelled' : 'failed',
        acceptedCount: 0,
        rejectedCount: 0,
        frontierAfter: frontier,
        treeVersionAfter: treeVersionBefore,
        error: AppError.getMessage(error),
      })
      if (!cancelled) throw error
      return {
        runId,
        state: 'cancelled',
        frontierBefore: frontier,
        frontierAfter: frontier,
        candidateCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        treeVersionBefore,
        treeVersionAfter: treeVersionBefore,
      }
    }
  }

  private consolidateEvidence(evidence: MemoryEvidenceRecord, runId: string): ConsolidationResult[] {
    const primary = this.consolidateEvidenceView(evidence, runId)
    const semantic = extractDeterministicSemanticCandidates(evidence).map((candidate) => {
      const semanticEvidence: MemoryEvidenceRecord = {
        ...evidence,
        category: candidate.category,
        title: candidate.title,
        content: candidate.content,
      }
      const descriptor = candidate.descriptor ?? resolveConceptDescriptor(semanticEvidence)
      const sharesEpisode = ['user', 'interest'].includes(descriptor.type)
      return this.consolidateEvidenceView(semanticEvidence, runId, {
        semantic: candidate,
        sharedEpisode: sharesEpisode ? primary.episode : undefined,
      })
    })
    return [primary, ...semantic]
  }

  private consolidateEvidenceView(
    evidence: MemoryEvidenceRecord,
    runId: string,
    options: ConsolidationViewOptions = {}
  ): ConsolidationResult {
    const descriptor = options.semantic?.descriptor ?? resolveConceptDescriptor(evidence)
    const conceptKey = [
      descriptor.type,
      evidence.scopeType,
      evidence.scopeId,
      normalizeIdentityText(descriptor.stableDiscriminator),
    ].join(':')
    const confidence = Math.min(
      1,
      confidenceForEvidence(evidence) * (options.semantic?.confidenceScale ?? 1)
    )
    const salience = salienceForEvidence(evidence)
    const concept = this.repository.upsertConcept({
      id: stableId('concept', conceptKey),
      stableKey: conceptKey,
      conceptType: descriptor.type,
      canonicalName: descriptor.name,
      description: truncate(evidence.content, 320),
      scopeType: evidence.scopeType,
      scopeId: evidence.scopeId,
      privacyClass: evidence.privacyClass,
      occurredAt: evidence.occurredAt,
      salience,
      activation: salience,
    })
    this.repository.upsertConceptAlias({
      conceptId: concept.id,
      alias: descriptor.name,
      source: evidence.sourceType,
      confidence,
      validFrom: evidence.occurredAt,
    })

    const episodeRoot =
      evidence.sessionId ||
      evidence.executionId ||
      `${evidence.scopeId}:${Math.floor(evidence.occurredAt / 86_400_000)}`
    const episodePhase = options.semantic
      ? `semantic:${options.semantic.category}:${sha256(normalizeIdentityText(options.semantic.content)).slice(0, 16)}`
      : readMetadataString(evidence, 'phase') || evidence.sourceType
    const episodeDiscriminator = `${episodeRoot}:${normalizeIdentityText(episodePhase)}`
    // concept.id 是 episode key 的一部分：一个 episode 永远只归属它的主概念。少了它，同会话同
    // phase 但不同概念的两条证据会撞同一 episodeKey，主概念在 upsert 中被后者顶掉（可能翻成
    // user/interest 这类不可见类型），episode 被树投影跳过而叶子仍指向它 → 悬空父节点 → Dream
    // 永久卡死。把概念身份并入键，从源头消除碰撞——同概念的证据仍共享 episode(延续性不变)。
    const episodeKey = `episode:${evidence.scopeType}:${evidence.scopeId}:${concept.id}:${episodeDiscriminator}`
    const episode = options.sharedEpisode ?? this.repository.upsertEpisode({
        id: stableId('episode', episodeKey),
        stableKey: episodeKey,
        episodeType: evidence.category === 'conversation' ? 'conversation' : 'activity',
        title: options.semantic?.title || readMetadataString(evidence, 'sessionTitle') || descriptor.name,
        summary: truncate(evidence.content, 360),
        scopeType: evidence.scopeType,
        scopeId: evidence.scopeId,
        primaryConceptId: concept.id,
        sessionId: evidence.sessionId,
        executionId: evidence.executionId,
        runId,
        occurredAt: evidence.occurredAt,
        salience,
        activation: salience,
      })
    this.repository.linkEpisodeConcept(
      episode.id,
      concept.id,
      options.sharedEpisode ? 'semantic' : 'primary',
      confidence
    )

    const predicate = predicateForCategory(evidence.category)
    const claimTopic = normalizeIdentityText(evidenceTitle(evidence)) || 'untitled'
    const claimPrefix = `${concept.id}:${predicate}:${claimTopic}:`
    const claimKey = `${claimPrefix}${sha256(normalizeIdentityText(evidence.content)).slice(0, 24)}`
    const competingClaims = this.repository
      .listClaimsByStableKeyPrefix(claimPrefix)
      .filter((candidate) => candidate.stable_key !== claimKey)
    const claim = this.repository.upsertClaim({
      id: stableId('claim', claimKey),
      stableKey: claimKey,
      conceptId: concept.id,
      predicate,
      value: evidence.content,
      summary: truncate(evidence.content, 420),
      epistemicStatus: epistemicStatusForEvidence(evidence),
      confidence,
      privacyClass: evidence.privacyClass,
      runId,
      occurredAt: evidence.occurredAt,
      salience,
      activation: salience,
    })
    this.repository.linkClaimEvidence(claim.id, evidence.id, 'supports', confidence)
    this.repository.linkClaimEpisode(claim.id, episode.id)
    if (!isEmpty(competingClaims) && evidence.category !== 'conversation') {
      for (const competing of competingClaims) {
        const relationType = evidence.sourceType === 'user_correction' ? 'supersedes' : 'contradicts'
        if (relationType === 'supersedes') {
          this.repository.supersedeClaim(competing.id, evidence.occurredAt)
        }
        this.repository.ensureRelation({
          id: randomUUID(),
          sourceType: 'claim',
          sourceId: claim.id,
          targetType: 'claim',
          targetId: competing.id,
          relationType,
          confidence,
          epistemicStatus: epistemicStatusForEvidence(evidence),
          runId,
          evidenceId: evidence.id,
          occurredAt: evidence.occurredAt,
        })
      }
    }
    this.repository.ensureRelation({
      id: randomUUID(),
      sourceType: 'episode',
      sourceId: episode.id,
      targetType: 'concept',
      targetId: concept.id,
      relationType: 'about',
      confidence,
      epistemicStatus: epistemicStatusForEvidence(evidence),
      runId,
      evidenceId: evidence.id,
      occurredAt: evidence.occurredAt,
    })

    this.linkWorkspaceHierarchy(evidence, concept, runId, confidence)
    this.linkEpisodeContinuity(evidence, concept, episode, runId, confidence)
    return { evidence, concept, episode, claim }
  }

  private linkWorkspaceHierarchy(
    evidence: MemoryEvidenceRecord,
    concept: MemoryConceptRow,
    runId: string,
    confidence: number
  ): void {
    if (!evidence.workspaceRoot || concept.concept_type === 'project') return
    const projectName = basename(evidence.workspaceRoot) || evidence.workspaceRoot
    const projectKey = `project:workspace:${normalizeIdentityText(evidence.workspaceRoot)}`
    const project = this.repository.upsertConcept({
      id: stableId('concept', projectKey),
      stableKey: projectKey,
      conceptType: 'project',
      canonicalName: projectName,
      description: `工作区 ${evidence.workspaceRoot}`,
      scopeType: 'workspace',
      scopeId: evidence.scopeId,
      privacyClass: evidence.privacyClass,
      occurredAt: evidence.occurredAt,
      salience: 0.78,
      activation: 0.78,
    })
    this.repository.ensureRelation({
      id: randomUUID(),
      sourceType: 'concept',
      sourceId: concept.id,
      targetType: 'concept',
      targetId: project.id,
      relationType: 'part_of',
      confidence,
      epistemicStatus: 'observed',
      runId,
      evidenceId: evidence.id,
      occurredAt: evidence.occurredAt,
    })
  }

  private linkEpisodeContinuity(
    evidence: MemoryEvidenceRecord,
    concept: MemoryConceptRow,
    episode: MemoryEpisodeRow,
    runId: string,
    confidence: number
  ): void {
    const previous = first(this.repository
      .listActiveEpisodes()
      .filter(
        (candidate) =>
          candidate.id !== episode.id &&
          candidate.primary_concept_id === concept.id &&
          candidate.started_at <= episode.started_at
      )
      .sort((left, right) => right.started_at - left.started_at))
    if (!previous) return
    this.repository.ensureRelation({
      id: randomUUID(),
      sourceType: 'episode',
      sourceId: episode.id,
      targetType: 'episode',
      targetId: previous.id,
      relationType: 'continues',
      confidence,
      epistemicStatus: 'observed',
      runId,
      evidenceId: evidence.id,
      occurredAt: evidence.occurredAt,
    })
  }

  private reconcileIdentity(
    runId: string,
    consolidated: ConsolidationResult[],
    allowAdvance: boolean = true
  ): MemoryIdentityEpochRow {
    const topConcepts = this.repository.getTopActiveConcepts(8)
    const identityCandidates = topConcepts.filter(
      (concept) => !['user', 'interest'].includes(concept.concept_type)
    )
    const mainline = first(identityCandidates) ?? first(topConcepts)
    if (!mainline) throw new AppError('INTERNAL', 'MemoryDream 无法从证据提炼全局主线。')
    const identityStatement = `我正在逐渐成为一个围绕“${mainline.canonical_name}”持续学习和协作的 AI。`
    const nutrientEvidence = topConcepts
      .filter((concept) => ['user', 'interest'].includes(concept.concept_type))
      .reduce((sum, concept) => sum + concept.evidence_count, 0)
    const confidence = Math.min(
      0.95,
      0.48 + Math.log2(mainline.evidence_count + 1) * 0.1 + Math.min(0.08, nutrientEvidence * 0.01)
    )
    const support = topConcepts.slice(0, 5).map((item) => item.id)
    const current = this.repository.getActiveIdentityEpoch()
    if (!current) return this.repository.createIdentityEpoch({
        id: stableId(
          'identity',
          `root:${normalizeIdentityText(mainline.canonical_name)}:${first(consolidated)?.evidence.occurredAt ?? 0}`
        ),
        identityStatement,
        globalMainline: mainline.canonical_name,
        confidence,
        supportingConceptIds: support,
        supportingEpisodeIds: consolidated.map((item) => item.episode.id),
        supportingClaimIds: consolidated.map((item) => item.claim.id),
        predecessorId: null,
        runId,
        startedAt: first(consolidated)?.evidence.occurredAt ?? Date.now(),
      })

    const shouldAdvance =
      allowAdvance &&
      current.global_mainline !== mainline.canonical_name &&
      mainline.evidence_count >= 5
    if (shouldAdvance) {
      const now = last(consolidated)?.evidence.occurredAt ?? mainline.last_active_at
      this.repository.closeIdentityEpoch(current.id, now)
      return this.repository.createIdentityEpoch({
        id: stableId(
          'identity',
          `${current.id}:${normalizeIdentityText(mainline.canonical_name)}:${now}`
        ),
        identityStatement,
        globalMainline: mainline.canonical_name,
        confidence,
        supportingConceptIds: support,
        supportingEpisodeIds: consolidated.map((item) => item.episode.id),
        supportingClaimIds: consolidated.map((item) => item.claim.id),
        predecessorId: current.id,
        runId,
        startedAt: now,
      })
    }

    this.repository.updateIdentitySupport({
      id: current.id,
      identityStatement:
        current.global_mainline === mainline.canonical_name
          ? identityStatement
          : current.identity_statement,
      globalMainline:
        current.global_mainline === mainline.canonical_name
          ? mainline.canonical_name
          : current.global_mainline,
      confidence: Math.max(current.confidence, confidence),
      supportingConceptIds: support,
    })
    return this.repository.getActiveIdentityEpoch()!
  }

  private projectTree(input: {
    runId: string
    frontierAfter: number
    activeEpoch: MemoryIdentityEpochRow
    consolidated: ConsolidationResult[]
  }): number {
    const previous = this.repository.getCurrentTreeNodes()
    const previousSnapshot = this.repository.getLatestSnapshot()
    const version = (previousSnapshot?.version ?? 0) + 1
    const concepts = this.repository.listActiveConcepts()
    const claims = this.repository.listActiveClaims()
    const episodes = this.repository.listActiveEpisodes()
    const visibleConcepts = concepts.filter(
      (concept) => !['user', 'interest'].includes(concept.concept_type)
    )
    const conceptById = new Map(visibleConcepts.map((concept) => [concept.id, concept]))
    const claimEpisodeIds = this.repository.getClaimEpisodeIds()
    const rootId = stableId('node', 'memory-tree-root')
    const trunkId = stableId('node', `identity:${input.activeEpoch.id}`)
    const now = Math.max(
      input.activeEpoch.started_at,
      ...concepts.map((concept) => concept.last_active_at),
      ...episodes.map((episode) => episode.last_reinforced_at)
    )
    const nodes: MemoryTreeNodeRecord[] = [
      {
        id: rootId,
        stableKey: 'root',
        parentId: null,
        nodeType: 'root',
        namespace: 'velaros.memory',
        title: 'Velar 记忆',
        summary: '所有可追溯经历与认知的根。',
        subjectType: 'tree',
        subjectId: 'root',
        mainlineScore: 1,
        confidence: 1,
        firstSeenAt: input.activeEpoch.started_at,
        lastActiveAt: now,
        projectionVersion: version,
        activation: 1,
        visibilityState: 'active',
      },
      {
        id: trunkId,
        stableKey: `trunk:${input.activeEpoch.id}`,
        parentId: rootId,
        nodeType: 'trunk',
        namespace: 'velaros.identity',
        title: input.activeEpoch.global_mainline,
        summary: input.activeEpoch.identity_statement,
        subjectType: 'identity_epoch',
        subjectId: input.activeEpoch.id,
        mainlineScore: 1,
        confidence: input.activeEpoch.confidence,
        firstSeenAt: input.activeEpoch.started_at,
        lastActiveAt: now,
        projectionVersion: version,
        activation: 1,
        visibilityState: 'active',
      },
    ]

    const rankedConcepts = visibleConcepts
      .map((concept) => ({
        concept,
        score:
          concept.activation * 0.45 +
          concept.salience * 0.25 +
          Math.min(concept.evidence_count, 20) / 20 * 0.3,
      }))
      .sort((left, right) => right.score - left.score)
    for (const { concept, score } of rankedConcepts) {
      nodes.push({
        id: stableId('node', `concept:${concept.id}`),
        stableKey: `concept:${concept.id}`,
        parentId: trunkId,
        nodeType: ['project', 'task', 'goal'].includes(concept.concept_type)
          ? 'task_branch'
          : 'experience_branch',
        namespace: `velaros.${concept.concept_type}`,
        title: concept.canonical_name,
        summary: concept.description,
        subjectType: 'concept',
        subjectId: concept.id,
        mainlineScore: score,
        confidence: Math.min(0.98, 0.5 + concept.evidence_count * 0.06),
        firstSeenAt: concept.first_seen_at,
        lastActiveAt: concept.last_active_at,
        projectionVersion: version,
        activation: concept.activation,
        visibilityState: concept.lifecycle_state === 'active' ? 'active' : 'dormant',
      })
    }

    const projectedEpisodeNodeIds = new Set<string>()
    for (const episode of episodes) {
      const conceptNodeId = stableId('node', `concept:${episode.primary_concept_id}`)
      if (!conceptById.has(episode.primary_concept_id)) continue
      projectedEpisodeNodeIds.add(episode.id)
      nodes.push({
        id: stableId('node', `episode:${episode.id}`),
        stableKey: `episode:${episode.id}`,
        parentId: conceptNodeId,
        nodeType: 'stage',
        namespace: 'velaros.episode',
        title: episode.title,
        summary: episode.summary,
        subjectType: 'episode',
        subjectId: episode.id,
        mainlineScore: episode.activation * 0.7,
        confidence: 0.82,
        firstSeenAt: episode.started_at,
        lastActiveAt: episode.last_reinforced_at,
        projectionVersion: version,
        activation: episode.activation,
        visibilityState: episode.state === 'active' ? 'active' : 'dormant',
      })
    }

    for (const claim of claims) {
      const concept = conceptById.get(claim.subject_concept_id)
      if (!concept) continue
      const episodeId = claimEpisodeIds.get(claim.id)
      // 只能挂到确实被投影出的 episode 节点上。概念碰撞已由 episodeKey 纳入概念身份根治，这里
      // 兜的是生命周期错位：dormant claim 仍在投影集(listActiveClaims 含 dormant)、而它的 episode
      // 已 dormant 被 listActiveEpisodes 排除时，回退到概念节点，避免悬空父节点。
      const parentId = episodeId && projectedEpisodeNodeIds.has(episodeId)
        ? stableId('node', `episode:${episodeId}`)
        : stableId('node', `concept:${concept.id}`)
      nodes.push({
        id: stableId('node', `claim:${claim.id}`),
        stableKey: `claim:${claim.id}`,
        parentId,
        nodeType: 'leaf',
        namespace: `velaros.claim.${claim.predicate}`,
        title: truncate(claim.summary, 80),
        summary: claim.summary,
        subjectType: 'claim',
        subjectId: claim.id,
        mainlineScore: claim.activation * 0.65 + claim.salience * 0.35,
        confidence: claim.confidence,
        firstSeenAt: claim.valid_from,
        lastActiveAt: claim.last_reinforced_at,
        projectionVersion: version,
        activation: claim.activation,
        visibilityState: claim.lifecycle_state === 'active' ? 'active' : 'dormant',
      })
    }

    const treeHash = hashTreeNodes(nodes)
    const ops = buildTreeOps(previous, nodes)
    const previousEventHash = previousSnapshot?.eventHeadHash ?? ''
    const eventHash = hashTreeEvent({ previousEventHash, version, ops })
    const mainlineConcept = first(rankedConcepts)?.concept
    const mainlineNodeId = mainlineConcept
      ? stableId('node', `concept:${mainlineConcept.id}`)
      : trunkId
    const identityChanged = previousSnapshot?.activeIdentityEpochId !== input.activeEpoch.id
    validateTreeProjection(nodes, {
      rootNodeId: rootId,
      globalMainlineNodeId: mainlineNodeId,
    })
    this.repository.replaceTreeProjection({
      nodes,
      snapshot: {
        version,
        rootNodeId: rootId,
        activeIdentityEpochId: input.activeEpoch.id,
        globalMainlineNodeId: mainlineNodeId,
        frontierEvidenceSequence: input.frontierAfter,
        treeHash,
        eventHeadHash: eventHash,
        createdAt: now,
      },
      baseVersion: previousSnapshot?.version ?? 0,
      ops,
      identityChange: identityChanged
        ? {
            previousIdentityEpochId: toNullable(previousSnapshot?.activeIdentityEpochId),
            nextIdentityEpochId: input.activeEpoch.id,
            globalMainline: input.activeEpoch.global_mainline,
          }
        : null,
      previousEventHash,
      eventHash,
      runId: input.runId,
    })
    return version
  }
}
