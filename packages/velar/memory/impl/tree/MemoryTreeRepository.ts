/**
 * 记忆树 v1 的 SQLite 仓：`MemoryTreeRepository`。接口 `MemoryTreeRepositoryApi` 在本文件的类上方。
 * 只管读写与事务，不含整理与投影的判断——那些在 `MemoryDream` 里，纯规则在 `utils/tree/` 下。
 */

import { randomUUID } from 'node:crypto'

import { first, isBlank, isEmpty, isString, Log, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { MemoryDatabaseProvider } from '../../contract/requires.js'
import type {
  MemoryCaptureResult,
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
} from '../../types/memory.js'
import type {
  EvidenceRow,
  MemoryClaimRow,
  MemoryClaimUpsertInput,
  MemoryConceptAliasUpsertInput,
  MemoryConceptRow,
  MemoryConceptUpsertInput,
  MemoryDreamRunFinishInput,
  MemoryDreamRunResultRow,
  MemoryDreamRunStartInput,
  MemoryEpisodeRow,
  MemoryEpisodeUpsertInput,
  MemoryIdentityEpochCreateInput,
  MemoryIdentityEpochRow,
  MemoryIdentitySupportUpdateInput,
  MemoryRelationEnsureInput,
  MemorySessionEligibilityChange,
  MemoryTreeDiffOp,
  MemoryTreePathIndex,
  MemoryTreeProjectionReplaceInput,
  RecallRow,
  SnapshotRow,
  SQLiteDatabase,
  TreeDiffRow,
  TreeNodeRow,
} from '../../types/tree.js'
import { inferEvidenceScope } from '../../utils/evidence.js'
import { resolveMemoryScopeFilterValue } from '../../utils/scope.js'
import { predicateForCategory } from '../../utils/tree/dream-rules.js'
import {
  buildFtsQuery,
  buildSearchTerms,
  mapEvidenceRow,
  mapSnapshot,
  mapTreeNode,
  parseJsonValue,
  parseTreeOps,
} from '../../utils/tree/repository-rows.js'
import {
  applyTreeOps,
  buildTreePathIndex,
  hashTreeEvent,
  hashTreeNodes,
  treePathFromIndex,
} from '../../utils/tree/tree-projection.js'
import { MemoryTuning } from '../../utils/tuning.js'

const log = Log.tag('MemoryTreeRepository')

/**
 * 记忆树 v1 的唯一落库处：证据、概念、经历、主张、关系、身份纪元、整理账本与树投影都经它读写。
 *
 * 实现是 `MemoryTreeRepository`，一个宿主一份，由 `MemoryTreeDomain` 独占持有；数据库连接由宿主注入。
 * 方法本身不开事务（除写明的几个），成组的写入由调用方用 `transaction` 包起来，全成或全不成。
 */
export interface MemoryTreeRepositoryApi {
  /** 在一个 SQLite 事务里跑一段同步逻辑并返回它的结果；回调里抛错则整段回滚。 */
  transaction<T>(callback: () => T): T
  /** 落一条证据（自带事务）。同来源同 sourceId 已存在时不重复写入，回执里 `inserted` 为 false。 */
  captureEvidence(input: MemoryEvidenceInput): MemoryCaptureResult
  /** 同一宿主快照内的证据原子落库（自带事务）；任一条写入失败整批回滚。 */
  captureEvidenceBatch(inputs: readonly MemoryEvidenceInput[]): MemoryCaptureResult[]
  /** 按摄入顺序取出还没整理过的证据，最多 limit 条；以 processed_at 为准，恢复旧证据也不会漏。 */
  listPendingEvidence(limit: number): MemoryEvidenceRecord[]
  /** 把这批证据标成已被某次整理消费；空数组直接返回。 */
  markEvidenceProcessed(evidenceIds: readonly string[], runId: string): void
  /** 还没整理的证据条数，给诊断与空闲调度看。 */
  countPendingEvidence(): number
  /** 读一个整数账本位（摄入前沿、整理前沿、树版本…）；没有这一项时给 0。 */
  getMetaInteger(key: string): number
  /** 写一个整数账本位，同时记下写入时刻。 */
  setMetaInteger(key: string, value: number, now?: number): void
  /** 按输入指纹找已有的整理账本行；找不到给 null。用它把重复的整理认出来。 */
  findDreamRunByFingerprint(fingerprint: string): Nullable<MemoryDreamRunResultRow>
  /** 开一次整理并返回账本行 id；同指纹已存在时复用原来那一行重跑，不会被唯一键卡死。 */
  startDreamRun(input: MemoryDreamRunStartInput): string
  /** 把崩溃时停在 queued/running 的整理账本改判为可重试的 failed，返回改了几行。 */
  recoverOrphanDreamRuns(): number
  /** 按巩固强度与显著度做一次自然衰减，返回改动的主张数；正文与证据永不删除，低激活只转 dormant。 */
  applyNaturalDecay(now: number): number
  /** 收一次整理账本：写终态、条数、落到的前沿与树版本，失败时附上原因。 */
  finishDreamRun(input: MemoryDreamRunFinishInput): void
  /** 按稳定键找概念行；找不到给 null。 */
  findConceptByStableKey(stableKey: string): Nullable<MemoryConceptRow>
  /** 写入或加强一个概念（按 stableKey 合并），返回落库后的整行。 */
  upsertConcept(input: MemoryConceptUpsertInput): MemoryConceptRow
  /** 给概念登记一个别名；别名为空白时什么都不做。 */
  upsertConceptAlias(input: MemoryConceptAliasUpsertInput): void
  /** 写入或加强一段经历（按 stableKey 合并），返回落库后的整行；主概念首次写入后不再覆写。 */
  upsertEpisode(input: MemoryEpisodeUpsertInput): MemoryEpisodeRow
  /** 把一段经历和一个概念按角色挂上，权重取大值。 */
  linkEpisodeConcept(episodeId: string, conceptId: string, role: string, weight: number): void
  /** 写入或加强一条主张（按 stableKey 合并），顺带刷新它的召回索引，返回落库后的整行。 */
  upsertClaim(input: MemoryClaimUpsertInput): MemoryClaimRow
  /** 把一条主张和一条证据按关系挂上，权重取大值。 */
  linkClaimEvidence(claimId: string, evidenceId: string, relation: string, weight: number): void
  /** 把一条主张挂到一段经历上；已经挂过就跳过。 */
  linkClaimEpisode(claimId: string, episodeId: string): void
  /** 列出稳定键以某个前缀开头的主张（含 dormant），用来找同题竞争的旧主张。 */
  listClaimsByStableKeyPrefix(prefix: string): MemoryClaimRow[]
  /** 把一条主张判为被取代：转 dormant、写上失效时刻并把激活度压到底。 */
  supersedeClaim(claimId: string, occurredAt: number): void
  /** 给每条主张挑一段代表经历（最近的那段），返回主张 id 到经历 id 的表。 */
  getClaimEpisodeIds(): Map<string, string>
  /** 建立或加强一条关系（五元组唯一），登记它的支撑证据，返回关系 id。 */
  ensureRelation(input: MemoryRelationEnsureInput): string
  /** 按 id 找概念行；找不到给 null。 */
  findConceptById(id: string): Nullable<MemoryConceptRow>
  /** 按激活度、显著度与证据量排序取前若干个活跃概念；不传 limit 时用可调参数表里的缺省值。 */
  getTopActiveConcepts(limit?: number): MemoryConceptRow[]
  /** 取当前还没结束的身份纪元；一个都没有时给 null。 */
  getActiveIdentityEpoch(): Nullable<MemoryIdentityEpochRow>
  /** 开一个新的身份纪元并返回它；序号在库里自增。 */
  createIdentityEpoch(input: MemoryIdentityEpochCreateInput): MemoryIdentityEpochRow
  /** 给一个身份纪元写上结束时刻。 */
  closeIdentityEpoch(id: string, endedAt: number): void
  /** 不开新纪元，只刷新当前纪元的陈述、主线、置信度与支撑概念。 */
  updateIdentitySupport(input: MemoryIdentitySupportUpdateInput): void
  /** 列出全部活跃概念，按激活度倒序。 */
  listActiveConcepts(): MemoryConceptRow[]
  /** 列出投影要用的主张（含 dormant），按激活度倒序。 */
  listActiveClaims(): MemoryClaimRow[]
  /** 列出投影要用的经历（active 与 completed），按激活度倒序。 */
  listActiveEpisodes(): MemoryEpisodeRow[]
  /** 读出当前这一版的全部树节点。 */
  getCurrentTreeNodes(): MemoryTreeNodeRecord[]
  /** 取最新一版树快照；一版都没有时给 null。 */
  getLatestSnapshot(): Nullable<MemoryTreeSnapshotRecord>
  /** 取指定版本的树快照；没有这一版时给 null。 */
  getSnapshot(version: number): Nullable<MemoryTreeSnapshotRecord>
  /** 从 diff 链回放出某一版的整棵树。版本不存在抛 NOT_FOUND，链断了抛 INTERNAL。 */
  getTreeStateAtVersion(version: number): MemoryTreeState
  /** 从头回放整条 diff 链，核对基线、事件哈希与每一版的树哈希；不抛错，问题都写进回执的 errors。 */
  verifyTreeIntegrity(): MemoryTreeIntegrityReport
  /** 用一版新投影整体替换树：重写全部节点，追加快照与 diff，推进树版本账本位。 */
  replaceTreeProjection(input: MemoryTreeProjectionReplaceInput): void
  /** 按查询词与作用域召回主张行：先走 FTS，命中不够再用 LIKE 兜底，合并去重后按活跃度排序截断。 */
  recall(query: string, options?: MemoryRecallOptions): RecallRow[]
  /** 把召回行补成对外的召回结果：带上证据来源、树路径与当前树版本。 */
  toRecallItems(rows: RecallRow[], reason: MemoryRecallItem['retrievalReason']): MemoryRecallItem[]
  /** 按主张 id 直接取一条召回结果；主张不存在时给 null。 */
  getRecallItem(claimId: string): Nullable<MemoryRecallItem>
  /** 取当前树状态：最新快照加当前全部节点。 */
  getTreeState(): MemoryTreeState
  /** 各表的条数、两个前沿、树版本与卡住的整理数，给诊断页与后端回执用。 */
  getDiagnostics(): MemoryTreeDiagnostics
  /** 改一条证据的可用状态并向上回算支撑，返回受影响的主张 id；证据不存在抛 NOT_FOUND。 */
  setEvidenceEligibility(evidenceId: string, state: MemoryEvidenceEligibilityState): string[]
  /** 改整个会话的证据可用状态并向上回算支撑，返回受影响的证据与主张 id。 */
  setSessionEvidenceEligibility(
    sessionId: string,
    state: MemoryEvidenceEligibilityState
  ): MemorySessionEligibilityChange
  /** 自然遗忘一条主张：转 dormant 并退出普通召回，返回它的支撑证据 id；主张不存在抛 NOT_FOUND。 */
  markClaimDormant(claimId: string): string[]
}

export class MemoryTreeRepository implements MemoryTreeRepositoryApi {
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
  public startDreamRun(input: MemoryDreamRunStartInput): string {
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

  public finishDreamRun(input: MemoryDreamRunFinishInput): void {
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

  public upsertConcept(input: MemoryConceptUpsertInput): MemoryConceptRow {
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

  public upsertConceptAlias(input: MemoryConceptAliasUpsertInput): void {
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

  public upsertEpisode(input: MemoryEpisodeUpsertInput): MemoryEpisodeRow {
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

  public upsertClaim(input: MemoryClaimUpsertInput): MemoryClaimRow {
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

  public ensureRelation(input: MemoryRelationEnsureInput): string {
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

  public getTopActiveConcepts(limit: number = MemoryTuning.tree.topConcepts): MemoryConceptRow[] {
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

  public createIdentityEpoch(input: MemoryIdentityEpochCreateInput): MemoryIdentityEpochRow {
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

  public updateIdentitySupport(input: MemoryIdentitySupportUpdateInput): void {
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
      nodes = applyTreeOps(nodes, parseTreeOps(diff), diff.version)
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
        ops = parseTreeOps(diff)
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

  public replaceTreeProjection(input: MemoryTreeProjectionReplaceInput): void {
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
    const limit = Math.min(
      MemoryTuning.tree.recallMaxLimit,
      Math.max(1, options.limit ?? MemoryTuning.tree.recallDefaultLimit)
    )
    const lifecycle = options.includeDormant ? `('active', 'dormant')` : `('active')`
    const workspaceRoot = options.workspaceRoot?.trim() ?? ''
    const scopeId = options.scopeId?.trim() ?? ''
    const excludeSessionId = options.excludeSessionId?.trim() ?? ''
    // 作用域参数走全仓单源：两轴解析 + 「选定 global 等同不过滤」都在 `resolveMemoryScopeFilterValue`
    // 里。这里自己写一份的时候，选定 global 只返回 global 条目，和别的后端给出的裁决不一样。
    const effectiveScope = resolveMemoryScopeFilterValue({ scopeId, workspaceRoot })
    const normalizedQuery = query.trim()
    const includeGlobal = options.includeGlobal ?? true
    const excludedSourceTypes = options.excludeSourceTypes ?? []
    const scopeClause = includeGlobal
      ? `AND (? = '' OR concept.scope_id = ? OR concept.scope_type = 'global')`
      : `AND (? = '' OR concept.scope_id = ?)`
    const predicates = [
      ...new Set((options.categories ?? []).map((category) => predicateForCategory(category))),
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

    const searchTerms = buildSearchTerms(normalizedQuery)
    const matchQuery = buildFtsQuery(searchTerms)
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
      .slice(0, MemoryTuning.tree.likeTermsMax)
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
        // LIKE 兜底多取一倍候选，和 FTS 命中合并去重后再截到 limit；总量仍受召回上限约束。
        Math.min(MemoryTuning.tree.recallMaxLimit, limit * 2)
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
    const treeIndex: Nullable<MemoryTreePathIndex> = isEmpty(rows)
      ? null
      : buildTreePathIndex(this.getCurrentTreeNodes())
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
      path: treeIndex ? treePathFromIndex(treeIndex, 'claim', row.id) : [],
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
  ): MemorySessionEligibilityChange {
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

}
