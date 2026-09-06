import { randomUUID } from 'node:crypto'

import type BetterSqlite3 from 'better-sqlite3'

import { first,isArray, isBlank, isEmpty, isPlainObject,isString, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import { buildProjectMemoryScope } from '../MemoryScope'
import type { MemoryDatabaseProvider } from '../Types'

import { inferEvidenceScope } from './Sanitizer'
import {
  applyTreeOps,
  hashTreeEvent,
  hashTreeNodes,
  isMemoryTreeDiffOp,
  type MemoryTreeDiffOp,
} from './TreeProjection'
import type {
  MemoryCaptureResult,
  MemoryDreamRunOptions,
  MemoryEvidenceEligibilityState,
  MemoryEvidenceInput,
  MemoryEvidenceRecord,
  MemoryRecallItem,
  MemoryRecallOptions,
  MemoryTreeDiagnostics,
  MemoryTreeIntegrityReport,
  MemoryTreeNodeRecord,
  MemoryTreeSnapshotRecord,
  MemoryTreeState,
} from './Types'

const log = logRuntime.tag('MemoryTreeRepository')

type SQLiteDatabase = InstanceType<typeof BetterSqlite3>

interface EvidenceRow {
  id: string
  source_type: MemoryEvidenceRecord['sourceType']
  trust_level: MemoryEvidenceRecord['trustLevel']
  source_id: string
  session_id: string
  execution_id: string
  workspace_root: string
  scope_type: MemoryEvidenceRecord['scopeType']
  scope_id: string
  occurred_at: number
  title: string
  content: string
  category: MemoryEvidenceRecord['category']
  privacy_class: MemoryEvidenceRecord['privacyClass']
  eligibility_state: MemoryEvidenceRecord['eligibilityState']
  metadata_json: string
  ingest_sequence: number
  created_at: number
  processed_at: Nullable<number>
  processed_by_run_id: string
}

export interface MemoryConceptRow {
  id: string
  stable_key: string
  concept_type: MemoryRecallItem['conceptType']
  canonical_name: string
  description: string
  scope_type: MemoryEvidenceRecord['scopeType']
  scope_id: string
  privacy_class: MemoryEvidenceRecord['privacyClass']
  lifecycle_state: string
  first_seen_at: number
  last_active_at: number
  evidence_count: number
  salience: number
  activation: number
  created_at: number
  updated_at: number
}

export interface MemoryClaimRow {
  id: string
  stable_key: string
  subject_concept_id: string
  predicate: string
  value_json: string
  summary: string
  epistemic_status: string
  confidence: number
  privacy_class: MemoryEvidenceRecord['privacyClass']
  lifecycle_state: string
  lifecycle_reason: string
  valid_from: number
  valid_to: Nullable<number>
  salience: number
  consolidation_strength: number
  activation: number
  last_reinforced_at: number
  created_at: number
  updated_at: number
}

export interface MemoryIdentityEpochRow {
  id: string
  sequence: number
  identity_statement: string
  global_mainline: string
  confidence: number
  supporting_concept_ids_json: string
  supporting_episode_ids_json: string
  supporting_claim_ids_json: string
  predecessor_id: Nullable<string>
  started_at: number
  ended_at: Nullable<number>
  created_by_run_id: string
  created_at: number
}

export interface MemoryEpisodeRow {
  id: string
  stable_key: string
  episode_type: string
  title: string
  summary: string
  state: string
  started_at: number
  ended_at: Nullable<number>
  scope_type: MemoryEvidenceRecord['scopeType']
  scope_id: string
  primary_concept_id: string
  source_session_id: string
  source_execution_id: string
  created_by_run_id: string
  salience: number
  activation: number
  last_reinforced_at: number
  created_at: number
  updated_at: number
}

interface RecallRow extends MemoryClaimRow {
  concept_id: string
  concept_type: MemoryRecallItem['conceptType']
  canonical_name: string
  scope_type: MemoryEvidenceRecord['scopeType']
  scope_id: string
  concept_activation: number
  rank: number
}

interface TreeNodeRow {
  id: string
  stable_key: string
  parent_id: Nullable<string>
  node_type: MemoryTreeNodeRecord['nodeType']
  namespace: string
  title: string
  summary: string
  subject_type: string
  subject_id: string
  mainline_score: number
  confidence: number
  first_seen_at: number
  last_active_at: number
  projection_version: number
  activation: number
  visibility_state: MemoryTreeNodeRecord['visibilityState']
}

interface SnapshotRow {
  version: number
  root_node_id: string
  active_identity_epoch_id: string
  global_mainline_node_id: string
  frontier_evidence_sequence: number
  tree_hash: string
  event_head_hash: string
  created_at: number
}

interface TreeDiffRow {
  version: number
  base_version: number
  ops_json: string
  previous_event_hash: string
  event_hash: string
}

const RecallPredicateByCategory: Record<MemoryEvidenceRecord['category'], string> = {
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

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return isPlainObject(parsed) ? (parsed) : {}
  } catch (error) {
    log.warn('invalid JSON in memory tree row', { error })
    return {}
  }
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    // arch-guard:silent-catch-ok value_json 兼容原始字符串值，解析失败时原样返回。
    return value
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return isArray(parsed) ? parsed.filter(isString) : []
  } catch {
    // arch-guard:silent-catch-ok 损坏的辅助数组按空值降级，权威正文不在此字段。
    return []
  }
}

function mapEvidenceRow(row: EvidenceRow): MemoryEvidenceRecord {
  return {
    id: row.id,
    sourceType: row.source_type,
    trustLevel: row.trust_level,
    sourceId: row.source_id,
    sessionId: row.session_id,
    executionId: row.execution_id,
    workspaceRoot: row.workspace_root,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    occurredAt: row.occurred_at,
    title: row.title,
    content: row.content,
    category: row.category,
    privacyClass: row.privacy_class,
    eligibilityState: row.eligibility_state,
    metadata: parseJsonObject(row.metadata_json),
    ingestSequence: row.ingest_sequence,
    createdAt: row.created_at,
  }
}

function mapTreeNode(row: TreeNodeRow): MemoryTreeNodeRecord {
  return {
    id: row.id,
    stableKey: row.stable_key,
    parentId: row.parent_id,
    nodeType: row.node_type,
    namespace: row.namespace,
    title: row.title,
    summary: row.summary,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    mainlineScore: row.mainline_score,
    confidence: row.confidence,
    firstSeenAt: row.first_seen_at,
    lastActiveAt: row.last_active_at,
    projectionVersion: row.projection_version,
    activation: row.activation,
    visibilityState: row.visibility_state,
  }
}

function mapSnapshot(row: SnapshotRow): MemoryTreeSnapshotRecord {
  return {
    version: row.version,
    rootNodeId: row.root_node_id,
    activeIdentityEpochId: row.active_identity_epoch_id,
    globalMainlineNodeId: row.global_mainline_node_id,
    frontierEvidenceSequence: row.frontier_evidence_sequence,
    treeHash: row.tree_hash,
    eventHeadHash: row.event_head_hash,
    createdAt: row.created_at,
  }
}

export class MemoryTreeRepository {
  constructor(private readonly resolveDatabase: MemoryDatabaseProvider) {}

  private get db(): SQLiteDatabase {
    return this.resolveDatabase()
  }

  public transaction<T>(callback: () => T): T {
    return this.db.transaction(callback)()
  }

  public captureEvidence(input: MemoryEvidenceInput): MemoryCaptureResult {
    return this.transaction(() => this.captureEvidenceWithinTransaction(input))
  }

  /** 同一宿主快照内的 Evidence 原子落库；任一写入失败时整批回滚。 */
  public captureEvidenceBatch(inputs: readonly MemoryEvidenceInput[]): MemoryCaptureResult[] {
    return this.transaction(() =>
      inputs.map((input) => this.captureEvidenceWithinTransaction(input))
    )
  }

  private captureEvidenceWithinTransaction(input: MemoryEvidenceInput): MemoryCaptureResult {
    const sourceId = input.sourceId?.trim() ?? ''
    if (sourceId) {
      const existing = this.db
        .prepare(
          `SELECT * FROM memory_evidence WHERE source_type = ? AND source_id = ? LIMIT 1`
        )
        .get(input.sourceType, sourceId) as EvidenceRow | undefined
      if (existing) return { evidence: mapEvidenceRow(existing), inserted: false }
    }

    const now = Date.now()
    const scope = inferEvidenceScope(input)
    const sequence = this.getMetaInteger('ingest_frontier') + 1
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO memory_evidence (
          id, source_type, trust_level, source_id, session_id, execution_id,
          workspace_root, scope_type, scope_id, occurred_at, title, content,
          category, privacy_class, eligibility_state, metadata_json,
          ingest_sequence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      )
      .run(
        id,
        input.sourceType,
        input.trustLevel,
        sourceId,
        input.sessionId?.trim() ?? '',
        input.executionId?.trim() ?? '',
        input.workspaceRoot?.trim() ?? '',
        scope.scopeType,
        scope.scopeId,
        input.occurredAt ?? now,
        input.title?.trim() ?? '',
        input.content,
        input.category ?? 'fact',
        input.privacyClass ?? 'standard',
        JSON.stringify(input.metadata ?? {}),
        sequence,
        now
      )
    this.setMetaInteger('ingest_frontier', sequence, now)

    const row = this.db.prepare(`SELECT * FROM memory_evidence WHERE id = ?`).get(id) as EvidenceRow
    return { evidence: mapEvidenceRow(row), inserted: true }
  }

  /** 未处理队列以 processed_at 为准；frontier 只用于账本展示，恢复旧 Evidence 时也不会漏掉。 */
  public listPendingEvidence(limit: number): MemoryEvidenceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_evidence
         WHERE eligibility_state = 'active' AND processed_at IS NULL
         ORDER BY ingest_sequence ASC LIMIT ?`
      )
      .all(limit) as EvidenceRow[]
    return rows.map(mapEvidenceRow)
  }

  public markEvidenceProcessed(evidenceIds: readonly string[], runId: string): void {
    if (isEmpty(evidenceIds)) return
    const update = this.db.prepare(
      `UPDATE memory_evidence SET processed_at = ?, processed_by_run_id = ? WHERE id = ?`
    )
    const now = Date.now()
    for (const evidenceId of evidenceIds) update.run(now, runId, evidenceId)
  }

  public countPendingEvidence(): number {
    const row = this.db
      .prepare(
        `SELECT count(*) AS value FROM memory_evidence
         WHERE eligibility_state = 'active' AND processed_at IS NULL`
      )
      .get() as { value: number }
    return row.value
  }

  public getMetaInteger(key: string): number {
    const row = this.db
      .prepare(`SELECT integer_value FROM memory_meta WHERE key = ?`)
      .get(key) as { integer_value: number } | undefined
    return row?.integer_value ?? 0
  }

  public setMetaInteger(key: string, value: number, now: number = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO memory_meta(key, integer_value, text_value, updated_at)
         VALUES (?, ?, '', ?)
         ON CONFLICT(key) DO UPDATE SET integer_value = excluded.integer_value, updated_at = excluded.updated_at`
      )
      .run(key, value, now)
  }

  public findDreamRunByFingerprint(fingerprint: string): Nullable<MemoryDreamRunResultRow> {
    return toNullable(
      this.db
        .prepare(`SELECT * FROM memory_dream_runs WHERE input_fingerprint = ? LIMIT 1`)
        .get(fingerprint) as MemoryDreamRunResultRow | undefined
    )
  }

  /** 失败/崩溃后的同一输入可复用原账本行重试，不被 fingerprint 唯一键卡死。 */
  public startDreamRun(input: {
    id: string
    trigger: MemoryDreamRunOptions['trigger']
    fingerprint: string
    frontierBefore: number
    frontierAfter: number
    candidateCount: number
    treeVersionBefore: number
    startedAt: number
  }): string {
    const existing = this.findDreamRunByFingerprint(input.fingerprint)
    if (existing) {
      this.db
        .prepare(
          `UPDATE memory_dream_runs SET
             trigger = ?, state = 'running', frontier_before = ?, frontier_after = ?,
             candidate_count = ?, accepted_count = 0, rejected_count = 0,
             tree_version_before = ?, tree_version_after = ?, error = '',
             started_at = ?, finished_at = NULL
           WHERE id = ?`
        )
        .run(
          input.trigger,
          input.frontierBefore,
          input.frontierAfter,
          input.candidateCount,
          input.treeVersionBefore,
          input.treeVersionBefore,
          input.startedAt,
          existing.id
        )
      return existing.id
    }
    this.db
      .prepare(
        `INSERT INTO memory_dream_runs (
          id, trigger, state, input_fingerprint, frontier_before, frontier_after,
          candidate_count, tree_version_before, tree_version_after, started_at
        ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.trigger,
        input.fingerprint,
        input.frontierBefore,
        input.frontierAfter,
        input.candidateCount,
        input.treeVersionBefore,
        input.treeVersionBefore,
        input.startedAt
      )
    return input.id
  }

  public recoverOrphanDreamRuns(): number {
    const result = this.db
      .prepare(
        `UPDATE memory_dream_runs SET state = 'failed', error = ?, finished_at = ?
         WHERE state IN ('queued', 'running')`
      )
      .run('应用在 Dream 提交前退出；已恢复为可重试状态。', Date.now())
    return result.changes
  }

  /**
   * 按巩固强度与显著性做缓慢自然衰减。正文和 Evidence 永不删除；低激活 Claim 仅进入 dormant。
   */
  public applyNaturalDecay(now: number): number {
    const claims = this.db
      .prepare(`SELECT * FROM memory_claims WHERE lifecycle_state IN ('active', 'dormant')`)
      .all() as MemoryClaimRow[]
    let changed = 0
    const updateClaim = this.db.prepare(
      `UPDATE memory_claims SET activation = ?, lifecycle_state = ?, lifecycle_reason = ?,
         dormant_at = ?, updated_at = ? WHERE id = ?`
    )
    for (const claim of claims) {
      if (claim.lifecycle_reason && claim.lifecycle_reason !== 'natural_decay') continue
      const ageDays = Math.max(0, now - claim.last_reinforced_at) / 86_400_000
      if (ageDays < 7) continue
      const halfLifeDays = 45 + claim.salience * 150 + claim.consolidation_strength * 180
      // 按距上次激活变更（updated_at）的增量衰减，而不是全龄。activation 是原地累减的，
      // 若每轮都对它再乘一次全龄因子就成了复利——挂机空闲循环里数天龄的记忆几十分钟被打入
      // dormant。指数衰减对时间可加，增量相乘 = 全程一次性衰减，语义正确且不复利。
      const deltaDays = Math.max(0, now - claim.updated_at) / 86_400_000
      if (deltaDays <= 0) continue
      const decayed = Math.max(
        0.05,
        claim.activation * Math.exp((-Math.LN2 * deltaDays) / halfLifeDays)
      )
      if (Math.abs(decayed - claim.activation) < 0.005) continue
      const dormant = decayed < 0.12
      updateClaim.run(
        decayed,
        dormant ? 'dormant' : 'active',
        dormant ? 'natural_decay' : '',
        dormant ? now : null,
        now,
        claim.id
      )
      changed += 1
    }
    if (changed === 0) return 0

    this.db.exec(`
      UPDATE memory_concepts
      SET activation = coalesce(
            (SELECT max(c.activation) FROM memory_claims c
             WHERE c.subject_concept_id = memory_concepts.id),
            activation
          ),
          updated_at = ${Math.floor(now)};
      UPDATE memory_episodes
      SET activation = coalesce(
            (SELECT max(c.activation)
             FROM memory_claim_episodes ce
             JOIN memory_claims c ON c.id = ce.claim_id
             WHERE ce.episode_id = memory_episodes.id),
            activation
          ),
          state = CASE WHEN coalesce(
            (SELECT max(c.activation)
             FROM memory_claim_episodes ce
             JOIN memory_claims c ON c.id = ce.claim_id
             WHERE ce.episode_id = memory_episodes.id), 0.05
          ) < 0.12 THEN 'dormant' ELSE state END,
          updated_at = ${Math.floor(now)};
    `)
    this.setMetaInteger('last_decay_at', now, now)
    return changed
  }

  public finishDreamRun(input: {
    id: string
    state: 'committed' | 'skipped' | 'failed' | 'cancelled'
    acceptedCount: number
    rejectedCount: number
    frontierAfter: number
    treeVersionAfter: number
    error?: string
  }): void {
    this.db
      .prepare(
        `UPDATE memory_dream_runs SET
          state = ?, accepted_count = ?, rejected_count = ?, frontier_after = ?,
          tree_version_after = ?, error = ?, finished_at = ?
         WHERE id = ?`
      )
      .run(
        input.state,
        input.acceptedCount,
        input.rejectedCount,
        input.frontierAfter,
        input.treeVersionAfter,
        input.error ?? '',
        Date.now(),
        input.id
      )
  }

  public findConceptByStableKey(stableKey: string): Nullable<MemoryConceptRow> {
    return toNullable(
      this.db
        .prepare(`SELECT * FROM memory_concepts WHERE stable_key = ? LIMIT 1`)
        .get(stableKey) as MemoryConceptRow | undefined
    )
  }

  public upsertConcept(input: {
    id: string
    stableKey: string
    conceptType: MemoryRecallItem['conceptType']
    canonicalName: string
    description: string
    scopeType: MemoryEvidenceRecord['scopeType']
    scopeId: string
    privacyClass: MemoryEvidenceRecord['privacyClass']
    occurredAt: number
    salience: number
    activation: number
  }): MemoryConceptRow {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO memory_concepts (
          id, stable_key, concept_type, canonical_name, description, scope_type, scope_id,
          privacy_class, first_seen_at, last_active_at, evidence_count, salience, activation,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(stable_key) DO UPDATE SET
          canonical_name = excluded.canonical_name,
          description = excluded.description,
          privacy_class = excluded.privacy_class,
          lifecycle_state = 'active',
          last_active_at = max(memory_concepts.last_active_at, excluded.last_active_at),
          evidence_count = memory_concepts.evidence_count + 1,
          salience = max(memory_concepts.salience, excluded.salience),
          activation = min(1.0, max(memory_concepts.activation, excluded.activation) + 0.04),
          updated_at = excluded.updated_at`
      )
      .run(
        input.id,
        input.stableKey,
        input.conceptType,
        input.canonicalName,
        input.description,
        input.scopeType,
        input.scopeId,
        input.privacyClass,
        input.occurredAt,
        input.occurredAt,
        input.salience,
        input.activation,
        now,
        now
      )
    return this.findConceptByStableKey(input.stableKey)!
  }

  public upsertConceptAlias(input: {
    conceptId: string
    alias: string
    source: string
    confidence: number
    validFrom: number
  }): void {
    if (isBlank(input.alias)) return
    this.db
      .prepare(
        `INSERT INTO memory_concept_aliases(concept_id, alias, source, confidence, valid_from)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(concept_id, alias) DO UPDATE SET
           confidence = max(memory_concept_aliases.confidence, excluded.confidence),
           valid_to = NULL`
      )
      .run(input.conceptId, input.alias, input.source, input.confidence, input.validFrom)
  }

  public upsertEpisode(input: {
    id: string
    stableKey: string
    episodeType: string
    title: string
    summary: string
    scopeType: MemoryEvidenceRecord['scopeType']
    scopeId: string
    primaryConceptId: string
    sessionId: string
    executionId: string
    runId: string
    occurredAt: number
    salience: number
    activation: number
  }): MemoryEpisodeRow {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO memory_episodes (
          id, stable_key, episode_type, title, summary, state, started_at, ended_at,
          scope_type, scope_id, primary_concept_id, source_session_id, source_execution_id,
          created_by_run_id, salience, activation, last_reinforced_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stable_key) DO UPDATE SET
          title = excluded.title,
          summary = excluded.summary,
          state = 'active',
          ended_at = max(memory_episodes.ended_at, excluded.ended_at),
          -- 首个主概念稳定不变：同会话不同类别证据会共享 episode key，
          -- 覆写主概念会让它翻转成不可见类型并在树投影中制造孤儿父节点。
          salience = max(memory_episodes.salience, excluded.salience),
          activation = min(1.0, max(memory_episodes.activation, excluded.activation) + 0.03),
          last_reinforced_at = excluded.last_reinforced_at,
          updated_at = excluded.updated_at`
      )
      .run(
        input.id,
        input.stableKey,
        input.episodeType,
        input.title,
        input.summary,
        input.occurredAt,
        input.occurredAt,
        input.scopeType,
        input.scopeId,
        input.primaryConceptId,
        input.sessionId,
        input.executionId,
        input.runId,
        input.salience,
        input.activation,
        input.occurredAt,
        now,
        now
      )
    return this.db
      .prepare(`SELECT * FROM memory_episodes WHERE stable_key = ?`)
      .get(input.stableKey) as MemoryEpisodeRow
  }

  public linkEpisodeConcept(episodeId: string, conceptId: string, role: string, weight: number): void {
    this.db
      .prepare(
        `INSERT INTO memory_episode_concepts(episode_id, concept_id, role, weight)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(episode_id, concept_id, role) DO UPDATE SET weight = max(weight, excluded.weight)`
      )
      .run(episodeId, conceptId, role, weight)
  }

  public upsertClaim(input: {
    id: string
    stableKey: string
    conceptId: string
    predicate: string
    value: unknown
    summary: string
    epistemicStatus: string
    confidence: number
    privacyClass: MemoryEvidenceRecord['privacyClass']
    runId: string
    occurredAt: number
    salience: number
    activation: number
  }): MemoryClaimRow {
    const now = Date.now()
    const valueJson = JSON.stringify(input.value)
    this.db
      .prepare(
        `INSERT INTO memory_claims (
          id, stable_key, subject_concept_id, predicate, value_json, summary,
          epistemic_status, confidence, privacy_class, lifecycle_state, valid_from,
          created_by_run_id, salience, consolidation_strength, activation,
          last_reinforced_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 0.5, ?, ?, ?, ?)
        ON CONFLICT(stable_key) DO UPDATE SET
          value_json = excluded.value_json,
          summary = excluded.summary,
          epistemic_status = excluded.epistemic_status,
          confidence = max(memory_claims.confidence, excluded.confidence),
          privacy_class = excluded.privacy_class,
          lifecycle_state = 'active',
          lifecycle_reason = '',
          valid_to = NULL,
          salience = max(memory_claims.salience, excluded.salience),
          consolidation_strength = min(1.0, memory_claims.consolidation_strength + 0.08),
          activation = min(1.0, max(memory_claims.activation, excluded.activation) + 0.05),
          last_reinforced_at = excluded.last_reinforced_at,
          updated_at = excluded.updated_at`
      )
      .run(
        input.id,
        input.stableKey,
        input.conceptId,
        input.predicate,
        valueJson,
        input.summary,
        input.epistemicStatus,
        input.confidence,
        input.privacyClass,
        input.occurredAt,
        input.runId,
        input.salience,
        input.activation,
        input.occurredAt,
        now,
        now
      )
    const claim = this.db
      .prepare(`SELECT * FROM memory_claims WHERE stable_key = ?`)
      .get(input.stableKey) as MemoryClaimRow
    this.replaceRecallIndex({
      subjectType: 'claim',
      subjectId: claim.id,
      title: input.summary.slice(0, 180),
      body: `${input.summary}\n${isString(input.value) ? input.value : valueJson}`,
      scopeId: this.findConceptById(input.conceptId)?.scope_id ?? 'global',
    })
    return claim
  }

  public linkClaimEvidence(claimId: string, evidenceId: string, relation: string, weight: number): void {
    this.db
      .prepare(
        `INSERT INTO memory_claim_evidence(claim_id, evidence_id, relation, weight, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(claim_id, evidence_id) DO UPDATE SET
           relation = excluded.relation, weight = max(weight, excluded.weight)`
      )
      .run(claimId, evidenceId, relation, weight, Date.now())
  }

  public linkClaimEpisode(claimId: string, episodeId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_claim_episodes(claim_id, episode_id, created_at)
         VALUES (?, ?, ?)`
      )
      .run(claimId, episodeId, Date.now())
  }

  public listClaimsByStableKeyPrefix(prefix: string): MemoryClaimRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_claims
         WHERE stable_key >= ? AND stable_key < ? AND lifecycle_state IN ('active', 'dormant')
         ORDER BY last_reinforced_at DESC`
      )
      .all(prefix, `${prefix}\uffff`) as MemoryClaimRow[]
  }

  public supersedeClaim(claimId: string, occurredAt: number): void {
    this.db
      .prepare(
        `UPDATE memory_claims SET lifecycle_state = 'dormant', lifecycle_reason = 'superseded',
           valid_to = ?, dormant_at = ?,
           activation = 0.05, updated_at = ? WHERE id = ?`
      )
      .run(occurredAt, occurredAt, Date.now(), claimId)
  }

  public getClaimEpisodeIds(): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT ce.claim_id, ce.episode_id
         FROM memory_claim_episodes ce
         JOIN memory_episodes e ON e.id = ce.episode_id
         ORDER BY e.started_at DESC, ce.created_at DESC`
      )
      .all() as Array<{ claim_id: string; episode_id: string }>
    const result = new Map<string, string>()
    for (const row of rows) {
      if (!result.has(row.claim_id)) result.set(row.claim_id, row.episode_id)
    }
    return result
  }

  public ensureRelation(input: {
    id: string
    sourceType: string
    sourceId: string
    targetType: string
    targetId: string
    relationType: string
    confidence: number
    epistemicStatus: string
    runId: string
    evidenceId: string
    occurredAt: number
  }): string {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO memory_relations (
          id, source_type, source_id, target_type, target_id, relation_type,
          confidence, epistemic_status, valid_from, created_by_run_id, activation,
          last_reinforced_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.6, ?, ?, ?)
        ON CONFLICT(source_type, source_id, target_type, target_id, relation_type) DO UPDATE SET
          confidence = max(memory_relations.confidence, excluded.confidence),
          valid_to = NULL,
          activation = min(1.0, memory_relations.activation + 0.04),
          last_reinforced_at = excluded.last_reinforced_at,
          updated_at = excluded.updated_at`
      )
      .run(
        input.id,
        input.sourceType,
        input.sourceId,
        input.targetType,
        input.targetId,
        input.relationType,
        input.confidence,
        input.epistemicStatus,
        input.occurredAt,
        input.runId,
        input.occurredAt,
        now,
        now
      )
    const relation = this.db
      .prepare(
        `SELECT id FROM memory_relations
         WHERE source_type = ? AND source_id = ? AND target_type = ? AND target_id = ? AND relation_type = ?`
      )
      .get(
        input.sourceType,
        input.sourceId,
        input.targetType,
        input.targetId,
        input.relationType
      ) as { id: string }
    this.db
      .prepare(
        `INSERT INTO memory_relation_evidence(relation_id, evidence_id, weight)
         VALUES (?, ?, ?)
         ON CONFLICT(relation_id, evidence_id) DO UPDATE SET weight = max(weight, excluded.weight)`
      )
      .run(relation.id, input.evidenceId, input.confidence)
    return relation.id
  }

  public findConceptById(id: string): Nullable<MemoryConceptRow> {
    return toNullable(
      this.db.prepare(`SELECT * FROM memory_concepts WHERE id = ? LIMIT 1`).get(id) as
        | MemoryConceptRow
        | undefined
    )
  }

  public getTopActiveConcepts(limit: number = 12): MemoryConceptRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_concepts
         WHERE lifecycle_state = 'active'
         ORDER BY (activation * 0.45 + salience * 0.25 + min(evidence_count, 20) / 20.0 * 0.30) DESC,
                  last_active_at DESC
         LIMIT ?`
      )
      .all(limit) as MemoryConceptRow[]
  }

  public getActiveIdentityEpoch(): Nullable<MemoryIdentityEpochRow> {
    return toNullable(
      this.db
        .prepare(`SELECT * FROM memory_identity_epochs WHERE ended_at IS NULL LIMIT 1`)
        .get() as MemoryIdentityEpochRow | undefined
    )
  }

  public createIdentityEpoch(input: {
    id: string
    identityStatement: string
    globalMainline: string
    confidence: number
    supportingConceptIds: string[]
    supportingEpisodeIds: string[]
    supportingClaimIds: string[]
    predecessorId: Nullable<string>
    runId: string
    startedAt: number
  }): MemoryIdentityEpochRow {
    const sequence =
      ((this.db.prepare(`SELECT max(sequence) AS value FROM memory_identity_epochs`).get() as {
        value: Nullable<number>
      }).value ?? 0) + 1
    this.db
      .prepare(
        `INSERT INTO memory_identity_epochs (
          id, sequence, identity_statement, global_mainline, confidence,
          supporting_concept_ids_json, supporting_episode_ids_json,
          supporting_claim_ids_json, predecessor_id, started_at, created_by_run_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        sequence,
        input.identityStatement,
        input.globalMainline,
        input.confidence,
        JSON.stringify(input.supportingConceptIds),
        JSON.stringify(input.supportingEpisodeIds),
        JSON.stringify(input.supportingClaimIds),
        input.predecessorId,
        input.startedAt,
        input.runId,
        Date.now()
      )
    return this.getActiveIdentityEpoch()!
  }

  public closeIdentityEpoch(id: string, endedAt: number): void {
    this.db.prepare(`UPDATE memory_identity_epochs SET ended_at = ? WHERE id = ?`).run(endedAt, id)
  }

  public updateIdentitySupport(input: {
    id: string
    identityStatement: string
    globalMainline: string
    confidence: number
    supportingConceptIds: string[]
  }): void {
    this.db
      .prepare(
        `UPDATE memory_identity_epochs SET
           identity_statement = ?, global_mainline = ?, confidence = ?,
           supporting_concept_ids_json = ?
         WHERE id = ?`
      )
      .run(
        input.identityStatement,
        input.globalMainline,
        input.confidence,
        JSON.stringify(input.supportingConceptIds),
        input.id
      )
  }

  public listActiveConcepts(): MemoryConceptRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_concepts WHERE lifecycle_state = 'active'
         ORDER BY activation DESC, last_active_at DESC`
      )
      .all() as MemoryConceptRow[]
  }

  public listActiveClaims(): MemoryClaimRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_claims WHERE lifecycle_state IN ('active', 'dormant')
         ORDER BY activation DESC, last_reinforced_at DESC`
      )
      .all() as MemoryClaimRow[]
  }

  public listActiveEpisodes(): MemoryEpisodeRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_episodes WHERE state IN ('active', 'completed')
         ORDER BY activation DESC, started_at DESC`
      )
      .all() as MemoryEpisodeRow[]
  }

  public getCurrentTreeNodes(): MemoryTreeNodeRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM memory_tree_nodes ORDER BY projection_version ASC, stable_key ASC`)
      .all() as TreeNodeRow[]
    return rows.map(mapTreeNode)
  }

  public getLatestSnapshot(): Nullable<MemoryTreeSnapshotRecord> {
    const row = this.db
      .prepare(`SELECT * FROM memory_tree_snapshots ORDER BY version DESC LIMIT 1`)
      .get() as SnapshotRow | undefined
    return row ? mapSnapshot(row) : null
  }

  public getSnapshot(version: number): Nullable<MemoryTreeSnapshotRecord> {
    const row = this.db
      .prepare(`SELECT * FROM memory_tree_snapshots WHERE version = ?`)
      .get(version) as SnapshotRow | undefined
    return row ? mapSnapshot(row) : null
  }

  public getTreeStateAtVersion(version: number): MemoryTreeState {
    const snapshot = this.getSnapshot(version)
    if (!snapshot) throw new AppError('NOT_FOUND', `记忆树版本不存在：${version}`)
    const diffs = this.listTreeDiffRows(version)
    let nodes: MemoryTreeNodeRecord[] = []
    let expectedBase = 0
    for (const diff of diffs) {
      if (diff.base_version !== expectedBase) {
        throw new AppError(
          'INTERNAL',
          `记忆树 diff 链断裂：v${diff.version} 的基线为 ${diff.base_version}，期望 ${expectedBase}`
        )
      }
      nodes = applyTreeOps(nodes, this.parseTreeOps(diff), diff.version)
      expectedBase = diff.version
    }
    return {
      snapshot,
      nodes: nodes.map((node) => ({ ...node, projectionVersion: version })),
    }
  }

  public verifyTreeIntegrity(): MemoryTreeIntegrityReport {
    const latest = this.getLatestSnapshot()
    if (!latest) return { valid: true, checkedThroughVersion: 0, errors: [] }
    const errors: string[] = []
    let previousEventHash = ''
    let expectedBase = 0
    let nodes: MemoryTreeNodeRecord[] = []
    for (const diff of this.listTreeDiffRows(latest.version)) {
      let ops: MemoryTreeDiffOp[] = []
      try {
        ops = this.parseTreeOps(diff)
      } catch (error) {
        log.warn('memory tree diff could not be parsed during integrity verification', {
          version: diff.version,
          error,
        })
        errors.push(AppError.getMessage(error))
        continue
      }
      if (diff.base_version !== expectedBase) {
        errors.push(`v${diff.version} base_version=${diff.base_version}，期望 ${expectedBase}`)
      }
      if (diff.previous_event_hash !== previousEventHash) {
        errors.push(`v${diff.version} previous_event_hash 不匹配`)
      }
      const computedEventHash = hashTreeEvent({
        previousEventHash,
        version: diff.version,
        ops,
      })
      if (computedEventHash !== diff.event_hash) {
        errors.push(`v${diff.version} event_hash 不匹配`)
      }
      nodes = applyTreeOps(nodes, ops, diff.version)
      const snapshot = this.getSnapshot(diff.version)
      if (!snapshot) {
        errors.push(`v${diff.version} 缺少 snapshot`)
      } else if (hashTreeNodes(nodes) !== snapshot.treeHash) {
        errors.push(`v${diff.version} tree_hash 不匹配`)
      }
      previousEventHash = diff.event_hash
      expectedBase = diff.version
    }
    if (expectedBase !== latest.version) errors.push(`diff 链只到 v${expectedBase}，快照已到 v${latest.version}`)
    return { valid: isEmpty(errors), checkedThroughVersion: expectedBase, errors }
  }

  private listTreeDiffRows(throughVersion: number): TreeDiffRow[] {
    return this.db
      .prepare(`SELECT * FROM memory_tree_diffs WHERE version <= ? ORDER BY version ASC`)
      .all(throughVersion) as TreeDiffRow[]
  }

  private parseTreeOps(diff: TreeDiffRow): MemoryTreeDiffOp[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(diff.ops_json)
    } catch (error) {
      throw new AppError('INTERNAL', `记忆树 v${diff.version} diff JSON 损坏`, { cause: error })
    }
    if (!isArray(parsed) || !parsed.every(isMemoryTreeDiffOp)) {
      throw new AppError('INTERNAL', `记忆树 v${diff.version} diff 操作不合法`)
    }
    return parsed
  }

  public replaceTreeProjection(input: {
    nodes: MemoryTreeNodeRecord[]
    snapshot: MemoryTreeSnapshotRecord
    baseVersion: number
    ops: MemoryTreeDiffOp[]
    identityChange: Nullable<Record<string, unknown>>
    previousEventHash: string
    eventHash: string
    runId: string
  }): void {
    this.db.exec(`PRAGMA defer_foreign_keys = ON`)
    this.db.prepare(`DELETE FROM memory_tree_nodes`).run()
    const insert = this.db.prepare(
      `INSERT INTO memory_tree_nodes (
        id, stable_key, parent_id, node_type, namespace, title, summary,
        subject_type, subject_id, mainline_score, confidence, first_seen_at,
        last_active_at, projection_version, activation, visibility_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const node of input.nodes) {
      insert.run(
        node.id,
        node.stableKey,
        node.parentId,
        node.nodeType,
        node.namespace,
        node.title,
        node.summary,
        node.subjectType,
        node.subjectId,
        node.mainlineScore,
        node.confidence,
        node.firstSeenAt,
        node.lastActiveAt,
        node.projectionVersion,
        node.activation,
        node.visibilityState
      )
    }
    this.db
      .prepare(
        `INSERT INTO memory_tree_snapshots (
          version, root_node_id, active_identity_epoch_id, global_mainline_node_id,
          frontier_evidence_sequence, created_by_run_id, tree_hash, event_head_hash,
          diff_summary_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.snapshot.version,
        input.snapshot.rootNodeId,
        input.snapshot.activeIdentityEpochId,
        input.snapshot.globalMainlineNodeId,
        input.snapshot.frontierEvidenceSequence,
        input.runId,
        input.snapshot.treeHash,
        input.snapshot.eventHeadHash,
        JSON.stringify({ opCount: input.ops.length }),
        input.snapshot.createdAt
      )
    this.db
      .prepare(
        `INSERT INTO memory_tree_diffs (
          version, base_version, ops_json, identity_change_json, op_count,
          previous_event_hash, event_hash, created_by_run_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.snapshot.version,
        input.baseVersion,
        JSON.stringify(input.ops),
        input.identityChange ? JSON.stringify(input.identityChange) : null,
        input.ops.length,
        input.previousEventHash,
        input.eventHash,
        input.runId,
        input.snapshot.createdAt
      )
    this.setMetaInteger('tree_version', input.snapshot.version, input.snapshot.createdAt)
  }

  public recall(query: string, options: MemoryRecallOptions = {}): RecallRow[] {
    const limit = Math.min(100, Math.max(1, options.limit ?? 12))
    const lifecycle = options.includeDormant ? `('active', 'dormant')` : `('active')`
    const workspaceRoot = options.workspaceRoot?.trim() ?? ''
    const scopeId = options.scopeId?.trim() ?? ''
    const excludeSessionId = options.excludeSessionId?.trim() ?? ''
    const effectiveScope = scopeId || (workspaceRoot ? buildProjectMemoryScope(workspaceRoot) : '')
    const normalizedQuery = query.trim()
    const includeGlobal = options.includeGlobal ?? true
    const excludedSourceTypes = options.excludeSourceTypes ?? []
    const scopeClause = includeGlobal
      ? `AND (? = '' OR concept.scope_id = ? OR concept.scope_type = 'global')`
      : `AND (? = '' OR concept.scope_id = ?)`
    const predicates = [
      ...new Set((options.categories ?? []).map((category) => RecallPredicateByCategory[category])),
    ]
    const predicateClause = isEmpty(predicates)
      ? ''
      : `AND c.predicate IN (${predicates.map(() => '?').join(', ')})`
    const provenanceClause = `
      AND (? = '' OR EXISTS (
        SELECT 1
        FROM memory_claim_evidence recall_ce
        JOIN memory_evidence recall_e ON recall_e.id = recall_ce.evidence_id
        WHERE recall_ce.claim_id = c.id
          AND recall_e.eligibility_state = 'active'
          AND recall_e.session_id <> ?
      ))
      AND (? = 0 OR c.predicate <> 'conversation_observation' OR EXISTS (
        SELECT 1
        FROM memory_claim_evidence trusted_ce
        JOIN memory_evidence trusted_e ON trusted_e.id = trusted_ce.evidence_id
        WHERE trusted_ce.claim_id = c.id
          AND trusted_e.eligibility_state = 'active'
          AND NOT (
            trusted_e.source_type = 'chat_message'
            AND trusted_e.trust_level = 'agent_derived'
          )
      ))
      AND (? = 0 OR c.predicate <> 'conversation_observation')
      ${isEmpty(excludedSourceTypes)
        ? ''
        : `AND EXISTS (
          SELECT 1
          FROM memory_claim_evidence source_ce
          JOIN memory_evidence source_e ON source_e.id = source_ce.evidence_id
          WHERE source_ce.claim_id = c.id
            AND source_e.eligibility_state = 'active'
            AND source_e.source_type NOT IN (${excludedSourceTypes.map(() => '?').join(', ')})
        )`}`
    const provenanceParameters = [
      excludeSessionId,
      excludeSessionId,
      options.excludeAgentConversationEchoes ? 1 : 0,
      options.excludeConversationObservations ? 1 : 0,
      ...excludedSourceTypes,
    ] as const

    if (isBlank(normalizedQuery)) return this.db
        .prepare(
          `SELECT c.*, c.id AS id, concept.id AS concept_id, concept.concept_type,
                  concept.canonical_name, concept.scope_type, concept.scope_id,
                  concept.activation AS concept_activation, 0.0 AS rank
           FROM memory_claims c
           JOIN memory_concepts concept ON concept.id = c.subject_concept_id
             WHERE c.lifecycle_state IN ${lifecycle}
               ${scopeClause}
             ${provenanceClause}
             ${predicateClause}
           ORDER BY CASE WHEN c.predicate = 'conversation_observation' THEN 1 ELSE 0 END ASC,
                    (c.activation * 0.5 + c.salience * 0.3 + c.confidence * 0.2) DESC,
                    c.updated_at DESC
           LIMIT ?`
        )
        .all(
          effectiveScope,
          effectiveScope,
          ...provenanceParameters,
          ...predicates,
          limit
        ) as RecallRow[]

    const searchTerms = this.buildSearchTerms(normalizedQuery)
    const matchQuery = this.buildFtsQuery(searchTerms)
    let ftsRows: RecallRow[] = []
    if (matchQuery) {
      try {
        ftsRows = this.db
          .prepare(
            `SELECT c.*, c.id AS id, concept.id AS concept_id, concept.concept_type,
                    concept.canonical_name, concept.scope_type, concept.scope_id,
                    concept.activation AS concept_activation,
                    bm25(memory_recall_fts, 1.0, 1.0, 1.4, 1.0, 1.0) AS rank
             FROM memory_recall_fts
             JOIN memory_claims c ON c.id = memory_recall_fts.subject_id
             JOIN memory_concepts concept ON concept.id = c.subject_concept_id
             WHERE memory_recall_fts MATCH ?
               AND memory_recall_fts.subject_type = 'claim'
               AND c.lifecycle_state IN ${lifecycle}
               ${scopeClause}
               ${provenanceClause}
               ${predicateClause}
             ORDER BY CASE WHEN c.predicate = 'conversation_observation' THEN 1 ELSE 0 END ASC,
                      rank ASC, c.activation DESC
             LIMIT ?`
          )
          .all(
            matchQuery,
            effectiveScope,
            effectiveScope,
            ...provenanceParameters,
            ...predicates,
            limit
          ) as RecallRow[]
      } catch (error) {
        log.debug('FTS recall failed; falling back to LIKE', { error })
      }
    }

    // FTS 已召满时跳过 LIKE 兜底：LIKE 是全表扫描，只在 FTS 命中不足时补充，
    // 避免每次召回都做一次数万行的长文本全表匹配拖垮同步路径。
    const likeTerms = (isEmpty(searchTerms) ? [normalizedQuery] : searchTerms)
      .slice(0, 12)
      .map((term) => {
        let escaped = ''
        for (const character of term) {
          escaped += character === '\\' || character === '%' || character === '_'
            ? `\\${character}`
            : character
        }
        return `%${escaped}%`
      })
    const likeClause = likeTerms
      .map(() => `(c.summary LIKE ? ESCAPE '\\' OR c.value_json LIKE ? ESCAPE '\\' OR concept.canonical_name LIKE ? ESCAPE '\\')`)
      .join(' OR ')
    const likeRows = ftsRows.length >= limit ? [] : this.db
      .prepare(
        `SELECT c.*, c.id AS id, concept.id AS concept_id, concept.concept_type,
                concept.canonical_name, concept.scope_type, concept.scope_id,
                concept.activation AS concept_activation, 0.0 AS rank
         FROM memory_claims c
         JOIN memory_concepts concept ON concept.id = c.subject_concept_id
         WHERE c.lifecycle_state IN ${lifecycle}
           AND (${likeClause})
           ${scopeClause}
           ${provenanceClause}
           ${predicateClause}
         ORDER BY CASE WHEN c.predicate = 'conversation_observation' THEN 1 ELSE 0 END ASC,
                  c.activation DESC, c.updated_at DESC
         LIMIT ?`
      )
      .all(
        ...likeTerms.flatMap((term) => [term, term, term]),
        effectiveScope,
        effectiveScope,
        ...provenanceParameters,
        ...predicates,
        Math.min(100, limit * 2)
      ) as RecallRow[]

    const merged = new Map<string, RecallRow>()
    for (const row of [...ftsRows, ...likeRows]) {
      if (!merged.has(row.id)) merged.set(row.id, row)
    }
    return [...merged.values()]
      .sort((left, right) => {
        const leftObservation = left.predicate === 'conversation_observation' ? 1 : 0
        const rightObservation = right.predicate === 'conversation_observation' ? 1 : 0
        if (leftObservation !== rightObservation) return leftObservation - rightObservation
        if (left.activation !== right.activation) return right.activation - left.activation
        return right.updated_at - left.updated_at
      })
      .slice(0, limit)
  }

  public toRecallItems(rows: RecallRow[], reason: MemoryRecallItem['retrievalReason']): MemoryRecallItem[] {
    const snapshotVersion = this.getMetaInteger('tree_version')
    // 整棵树只加载一次并索引：否则每条召回结果都会全表扫描 memory_tree_nodes 一遍，
    // limit=12 的一次召回会把整棵树加载 12 遍，是同步召回毫秒预算的主要杀手。
    const treeIndex = isEmpty(rows) ? null : this.buildTreePathIndex()
    return rows.map((row) => ({
      id: row.id,
      claimId: row.id,
      conceptId: row.concept_id,
      conceptType: row.concept_type,
      predicate: row.predicate,
      title: row.canonical_name,
      summary: row.summary,
      value: parseJsonValue(row.value_json),
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      confidence: row.confidence,
      salience: row.salience,
      activation: Math.max(row.activation, row.concept_activation),
      updatedAt: row.updated_at,
      snapshotVersion,
      retrievalReason: reason,
      evidenceIds: this.listClaimEvidenceIds(row.id),
      sourceTypes: this.listClaimEvidenceSourceTypes(row.id),
      path: treeIndex ? this.treePathFromIndex(treeIndex, 'claim', row.id) : [],
    }))
  }

  public getRecallItem(claimId: string): Nullable<MemoryRecallItem> {
    const row = this.db
      .prepare(
        `SELECT c.*, c.id AS id, concept.id AS concept_id, concept.concept_type,
                concept.canonical_name, concept.scope_type, concept.scope_id,
                concept.activation AS concept_activation, 0.0 AS rank
         FROM memory_claims c
         JOIN memory_concepts concept ON concept.id = c.subject_concept_id
         WHERE c.id = ? LIMIT 1`
      )
      .get(claimId) as RecallRow | undefined
    return row ? toNullable(first(this.toRecallItems([row], 'recent'))) : null
  }

  public getTreeState(): MemoryTreeState {
    return { snapshot: this.getLatestSnapshot(), nodes: this.getCurrentTreeNodes() }
  }

  public getDiagnostics(): MemoryTreeDiagnostics {
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT count(*) AS value FROM ${table}`).get() as { value: number }
      return row.value
    }
    return {
      evidenceCount: count('memory_evidence'),
      conceptCount: count('memory_concepts'),
      episodeCount: count('memory_episodes'),
      claimCount: count('memory_claims'),
      relationCount: count('memory_relations'),
      treeNodeCount: count('memory_tree_nodes'),
      dreamRunCount: count('memory_dream_runs'),
      ingestFrontier: this.getMetaInteger('ingest_frontier'),
      dreamFrontier: this.getMetaInteger('dream_frontier'),
      treeVersion: this.getMetaInteger('tree_version'),
      pendingEvidenceCount: this.countPendingEvidence(),
      stalledDreamRunCount: (
        this.db
          .prepare(`SELECT count(*) AS value FROM memory_dream_runs WHERE state IN ('running', 'queued')`)
          .get() as { value: number }
      ).value,
    }
  }

  public setEvidenceEligibility(
    evidenceId: string,
    state: MemoryEvidenceEligibilityState
  ): string[] {
    const evidence = this.db
      .prepare(`SELECT id FROM memory_evidence WHERE id = ?`)
      .get(evidenceId) as { id: string } | undefined
    if (!evidence) throw new AppError('NOT_FOUND', `Evidence 不存在：${evidenceId}`)

    this.db
      .prepare(`UPDATE memory_evidence SET eligibility_state = ? WHERE id = ?`)
      .run(state, evidenceId)
    const claimIds = this.listClaimIdsForEvidence(evidenceId)
    for (const claimId of claimIds) this.recomputeClaimSupport(claimId)
    this.recomputeRelationSupport([evidenceId])
    this.recomputeMeaningSupport(claimIds, [evidenceId])
    return claimIds
  }

  public setSessionEvidenceEligibility(
    sessionId: string,
    state: MemoryEvidenceEligibilityState
  ): { evidenceIds: string[]; claimIds: string[] } {
    const evidenceIds = (
      this.db
        .prepare(`SELECT id FROM memory_evidence WHERE session_id = ? ORDER BY ingest_sequence`)
        .all(sessionId) as Array<{ id: string }>
    ).map((row) => row.id)
    if (isEmpty(evidenceIds)) return { evidenceIds, claimIds: [] }

    const update = this.db.prepare(`UPDATE memory_evidence SET eligibility_state = ? WHERE id = ?`)
    const claimIds = new Set<string>()
    for (const evidenceId of evidenceIds) {
      update.run(state, evidenceId)
      for (const claimId of this.listClaimIdsForEvidence(evidenceId)) claimIds.add(claimId)
    }
    for (const claimId of claimIds) this.recomputeClaimSupport(claimId)
    this.recomputeRelationSupport(evidenceIds)
    this.recomputeMeaningSupport([...claimIds], evidenceIds)
    return { evidenceIds, claimIds: [...claimIds] }
  }

  public markClaimDormant(claimId: string): string[] {
    const claim = this.db.prepare(`SELECT id FROM memory_claims WHERE id = ?`).get(claimId) as
      | { id: string }
      | undefined
    if (!claim) throw new AppError('NOT_FOUND', `记忆主张不存在：${claimId}`)
    this.db
      .prepare(
        `UPDATE memory_claims SET lifecycle_state = 'dormant', lifecycle_reason = 'forgotten', activation = 0.05,
         dormant_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(Date.now(), Date.now(), claimId)
    return this.listClaimEvidenceIds(claimId)
  }

  private listClaimEvidenceIds(claimId: string): string[] {
    return (
      this.db
        .prepare(`SELECT evidence_id FROM memory_claim_evidence WHERE claim_id = ? ORDER BY created_at ASC`)
        .all(claimId) as Array<{ evidence_id: string }>
    ).map((row) => row.evidence_id)
  }

  private listClaimEvidenceSourceTypes(claimId: string): Array<MemoryEvidenceRecord['sourceType']> {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT e.source_type
           FROM memory_claim_evidence ce
           JOIN memory_evidence e ON e.id = ce.evidence_id
           WHERE ce.claim_id = ? AND e.eligibility_state = 'active'
           ORDER BY e.source_type ASC`
        )
        .all(claimId) as Array<{ source_type: MemoryEvidenceRecord['sourceType'] }>
    ).map((row) => row.source_type)
  }

  private listClaimIdsForEvidence(evidenceId: string): string[] {
    return (
      this.db
        .prepare(`SELECT claim_id FROM memory_claim_evidence WHERE evidence_id = ?`)
        .all(evidenceId) as Array<{ claim_id: string }>
    ).map((row) => row.claim_id)
  }

  private recomputeClaimSupport(claimId: string): void {
    const support = this.db
      .prepare(
        `SELECT count(*) AS count, coalesce(avg(ce.weight), 0) AS confidence,
                coalesce(max(e.occurred_at), 0) AS last_active_at
         FROM memory_claim_evidence ce
         JOIN memory_evidence e ON e.id = ce.evidence_id
         WHERE ce.claim_id = ? AND e.eligibility_state = 'active'`
      )
      .get(claimId) as { count: number; confidence: number; last_active_at: number }
    const claim = this.db
      .prepare(`SELECT lifecycle_reason FROM memory_claims WHERE id = ?`)
      .get(claimId) as { lifecycle_reason: string } | undefined
    if (!claim) return

    // 用户显式意图（遗忘/被覆盖/彻底清除）是黏性的：证据支持变化不得覆盖它，否则遗忘的
    // Claim 会被下面的复活分支救回。natural_decay 与 support_removed 是系统态，可被支持变化改写。
    const stickyReasons = new Set(['forgotten', 'superseded', 'erased'])
    if (support.count === 0) {
      if (stickyReasons.has(claim.lifecycle_reason)) return
      this.db
        .prepare(
          `UPDATE memory_claims SET lifecycle_state = 'dormant', lifecycle_reason = 'support_removed',
             activation = 0.05, dormant_at = ?, updated_at = ? WHERE id = ?`
        )
        .run(Date.now(), Date.now(), claimId)
      return
    }
    if (!isEmpty(claim.lifecycle_reason) && claim.lifecycle_reason !== 'support_removed') return
    this.db
      .prepare(
        `UPDATE memory_claims SET lifecycle_state = 'active', lifecycle_reason = '', valid_to = NULL,
           confidence = ?, activation = min(1.0, 0.35 + ? * 0.12), dormant_at = NULL,
           last_reinforced_at = max(last_reinforced_at, ?), updated_at = ? WHERE id = ?`
      )
      .run(
        Math.max(0.2, support.confidence),
        support.count,
        support.last_active_at,
        Date.now(),
        claimId
      )
  }

  private recomputeRelationSupport(evidenceIds: readonly string[]): void {
    if (isEmpty(evidenceIds)) return
    const relationIds = (
      this.db
        .prepare(
          `SELECT DISTINCT relation_id FROM memory_relation_evidence
           WHERE evidence_id IN (${evidenceIds.map(() => '?').join(', ')})`
        )
        .all(...evidenceIds) as Array<{ relation_id: string }>
    ).map((row) => row.relation_id)
    for (const relationId of relationIds) {
      const active = (
        this.db
          .prepare(
            `SELECT count(*) AS value FROM memory_relation_evidence re
             JOIN memory_evidence e ON e.id = re.evidence_id
             WHERE re.relation_id = ? AND e.eligibility_state = 'active'`
          )
          .get(relationId) as { value: number }
      ).value
      this.db
        .prepare(
          `UPDATE memory_relations SET activation = ?, valid_to = ?, updated_at = ? WHERE id = ?`
        )
        .run(
          active > 0 ? Math.min(1, 0.45 + active * 0.1) : 0.05,
          active > 0 ? null : Date.now(),
          Date.now(),
          relationId
        )
    }
  }

  private recomputeMeaningSupport(
    claimIds: readonly string[],
    evidenceIds: readonly string[] = []
  ): void {
    if (isEmpty(claimIds) && isEmpty(evidenceIds)) return
    const conceptIds = new Set<string>()
    if (!isEmpty(claimIds)) {
      const rows = this.db
        .prepare(
          `SELECT subject_concept_id FROM memory_claims
           WHERE id IN (${claimIds.map(() => '?').join(', ')})`
        )
        .all(...claimIds) as Array<{ subject_concept_id: string }>
      for (const row of rows) conceptIds.add(row.subject_concept_id)
    }
    if (!isEmpty(evidenceIds)) {
      const rows = this.db
        .prepare(
          `SELECT r.source_type, r.source_id, r.target_type, r.target_id
           FROM memory_relations r
           JOIN memory_relation_evidence re ON re.relation_id = r.id
           WHERE re.evidence_id IN (${evidenceIds.map(() => '?').join(', ')})`
        )
        .all(...evidenceIds) as Array<{
          source_type: string
          source_id: string
          target_type: string
          target_id: string
        }>
      for (const row of rows) {
        if (row.source_type === 'concept') conceptIds.add(row.source_id)
        if (row.target_type === 'concept') conceptIds.add(row.target_id)
      }
    }
    for (const conceptId of conceptIds) {
      const support = this.db
        .prepare(
          `SELECT count(DISTINCT support.evidence_id) AS evidence_count,
                  coalesce(max(support.occurred_at), 0) AS last_active_at
           FROM (
             SELECT e.id AS evidence_id, e.occurred_at
             FROM memory_claims c
             JOIN memory_claim_evidence ce ON ce.claim_id = c.id
             JOIN memory_evidence e ON e.id = ce.evidence_id
             WHERE c.subject_concept_id = ? AND e.eligibility_state = 'active'
             UNION ALL
             SELECT e.id AS evidence_id, e.occurred_at
             FROM memory_relations r
             JOIN memory_relation_evidence re ON re.relation_id = r.id
             JOIN memory_evidence e ON e.id = re.evidence_id
             WHERE ((r.source_type = 'concept' AND r.source_id = ?)
                    OR (r.target_type = 'concept' AND r.target_id = ?))
               AND e.eligibility_state = 'active'
           ) support`
        )
        .get(conceptId, conceptId, conceptId) as {
        evidence_count: number
        last_active_at: number
      }
      this.db
        .prepare(
          `UPDATE memory_concepts SET lifecycle_state = ?, evidence_count = ?,
             activation = ?, last_active_at = max(last_active_at, ?), updated_at = ? WHERE id = ?`
        )
        .run(
          support.evidence_count > 0 ? 'active' : 'dormant',
          support.evidence_count,
          support.evidence_count > 0 ? Math.min(1, 0.4 + support.evidence_count * 0.08) : 0.05,
          support.last_active_at,
          Date.now(),
          conceptId
        )
    }

    if (isEmpty(claimIds)) return
    const episodeIds = (
      this.db
        .prepare(
          `SELECT DISTINCT episode_id FROM memory_claim_episodes
           WHERE claim_id IN (${claimIds.map(() => '?').join(', ')})`
        )
        .all(...claimIds) as Array<{ episode_id: string }>
    ).map((row) => row.episode_id)
    for (const episodeId of episodeIds) {
      const active = (
        this.db
          .prepare(
            `SELECT count(*) AS value FROM memory_claim_episodes ce
             JOIN memory_claims c ON c.id = ce.claim_id
             WHERE ce.episode_id = ? AND c.lifecycle_state = 'active'`
          )
          .get(episodeId) as { value: number }
      ).value
      this.db
        .prepare(`UPDATE memory_episodes SET state = ?, activation = ?, updated_at = ? WHERE id = ?`)
        .run(active > 0 ? 'active' : 'dormant', active > 0 ? Math.min(1, 0.4 + active * 0.1) : 0.05, Date.now(), episodeId)
    }
  }

  private buildTreePathIndex(): {
    byId: Map<string, MemoryTreeNodeRecord>
    bySubject: Map<string, MemoryTreeNodeRecord>
  } {
    const nodes = this.getCurrentTreeNodes()
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const bySubject = new Map(nodes.map((node) => [`${node.subjectType}:${node.subjectId}`, node]))
    return { byId, bySubject }
  }

  private treePathFromIndex(
    index: { byId: Map<string, MemoryTreeNodeRecord>; bySubject: Map<string, MemoryTreeNodeRecord> },
    subjectType: string,
    subjectId: string
  ): MemoryRecallItem['path'] {
    let current = index.bySubject.get(`${subjectType}:${subjectId}`)
    const path: MemoryRecallItem['path'] = []
    const seen = new Set<string>()
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      path.unshift({
        id: current.id,
        nodeType: current.nodeType,
        title: current.title,
        subjectType: current.subjectType,
        subjectId: current.subjectId,
      })
      current = current.parentId ? index.byId.get(current.parentId) : undefined
    }
    return path
  }

  private replaceRecallIndex(input: {
    subjectType: string
    subjectId: string
    title: string
    body: string
    scopeId: string
  }): void {
    this.db
      .prepare(`DELETE FROM memory_recall_fts WHERE subject_type = ? AND subject_id = ?`)
      .run(input.subjectType, input.subjectId)
    this.db
      .prepare(
        `INSERT INTO memory_recall_fts(subject_type, subject_id, title, body, scope_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.subjectType, input.subjectId, input.title, input.body, input.scopeId)
  }

  private buildSearchTerms(query: string): string[] {
    const asciiTerms = query.match(/[A-Za-z0-9][A-Za-z0-9_.:/-]{1,}/g) ?? []
    const semanticTerms = (query.match(
      /长期目标|偏好|目标|项目|任务|兴趣|习惯|职业|身份|方法|结论|证据/gu
    ) ?? []).flatMap((term) => term === '长期目标' ? [term, '目标'] : [term])
    const chineseRuns = query.match(/[\p{Script=Han}]{2,12}/gu) ?? []
    return [...new Set([...asciiTerms, ...semanticTerms, ...chineseRuns])]
      .map((term) => term.trim())
      .filter((term) => term.length >= 2)
      .slice(0, 12)
  }

  private buildFtsQuery(terms: readonly string[]): string {
    return terms
      .map((term) => term.replace(/["*:^(){}]/g, '').replaceAll('[', '').replaceAll(']', '').trim())
      .filter((term) => term.length >= 2)
      .map((term) => `"${term}"*`)
      .join(' OR ')
  }
}

export interface MemoryDreamRunResultRow {
  id: string
  trigger: MemoryDreamRunOptions['trigger']
  state: 'queued' | 'running' | 'committed' | 'failed' | 'cancelled' | 'skipped'
  input_fingerprint: string
  frontier_before: number
  frontier_after: number
  candidate_count: number
  accepted_count: number
  rejected_count: number
  tree_version_before: number
  tree_version_after: number
  error: string
  started_at: number
  finished_at: Nullable<number>
}

export function readIdentitySupportingConceptIds(epoch: MemoryIdentityEpochRow): string[] {
  return parseStringArray(epoch.supporting_concept_ids_json)
}
