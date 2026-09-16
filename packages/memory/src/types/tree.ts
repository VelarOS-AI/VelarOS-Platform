import type BetterSqlite3 from 'better-sqlite3'

import type {
  MemoryConceptType,
  MemoryDreamRunOptions,
  MemoryEvidenceCategory,
  MemoryEvidenceRecord,
  MemoryRecallItem,
  MemoryTreeNodeRecord,
  MemoryTreeSnapshotRecord,
} from './memory'

/** 宿主打开的 better-sqlite3 连接；记忆树 v1 只拿它读写，不负责打开与关闭。 */
export type SQLiteDatabase = InstanceType<typeof BetterSqlite3>

/** memory_evidence 一行的原始形状：列名与 SQLite 一致，映射成 DTO 后才出仓。 */
export interface EvidenceRow {
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

/** memory_concepts 一行：一个概念的身份、作用域与激活度。 */
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

/** memory_claims 一行：一条主张的谓词、正文、置信度与生命周期。 */
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

/** memory_identity_epochs 一行：一个身份纪元的主线陈述与支撑集合。 */
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

/** memory_episodes 一行：一段经历的标题、归属概念与来源会话。 */
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

/** 召回查询的一行：主张行加上它所属概念的字段与本次排序分。 */
export interface RecallRow extends MemoryClaimRow {
  concept_id: string
  concept_type: MemoryRecallItem['conceptType']
  canonical_name: string
  scope_type: MemoryEvidenceRecord['scopeType']
  scope_id: string
  concept_activation: number
  rank: number
}

/** memory_tree_nodes 一行：一个已投影的树节点。 */
export interface TreeNodeRow {
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

/** memory_tree_snapshots 一行：一个树版本的锚点与两个哈希。 */
export interface SnapshotRow {
  version: number
  root_node_id: string
  active_identity_epoch_id: string
  global_mainline_node_id: string
  frontier_evidence_sequence: number
  tree_hash: string
  event_head_hash: string
  created_at: number
}

/** memory_tree_diffs 一行：一次投影相对基线版本的操作序列与事件哈希链。 */
export interface TreeDiffRow {
  version: number
  base_version: number
  ops_json: string
  previous_event_hash: string
  event_hash: string
}

/** memory_dream_runs 一行：一次整理的账本，含状态、前沿与树版本。 */
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

/** 开一次整理账本的入参：同一指纹重试时复用原来那一行。 */
export interface MemoryDreamRunStartInput {
  id: string
  trigger: MemoryDreamRunOptions['trigger']
  fingerprint: string
  frontierBefore: number
  frontierAfter: number
  candidateCount: number
  treeVersionBefore: number
  startedAt: number
}

/** 收一次整理账本的入参：终态、收下与丢弃的条数、落到的前沿与树版本。 */
export interface MemoryDreamRunFinishInput {
  id: string
  state: 'committed' | 'skipped' | 'failed' | 'cancelled'
  acceptedCount: number
  rejectedCount: number
  frontierAfter: number
  treeVersionAfter: number
  error?: string
}

/** 写入一个概念的入参：stableKey 决定合并到哪一行。 */
export interface MemoryConceptUpsertInput {
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
}

/** 给一个概念登记别名的入参。 */
export interface MemoryConceptAliasUpsertInput {
  conceptId: string
  alias: string
  source: string
  confidence: number
  validFrom: number
}

/** 写入一段经历的入参：stableKey 决定合并到哪一行，主概念首次写入后不再覆写。 */
export interface MemoryEpisodeUpsertInput {
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
}

/** 写入一条主张的入参：value 会序列化进 value_json，摘要同时进召回索引。 */
export interface MemoryClaimUpsertInput {
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
}

/** 建立一条关系的入参：五元组决定唯一性，evidenceId 是它的支撑来源。 */
export interface MemoryRelationEnsureInput {
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
}

/** 开一个新身份纪元的入参：predecessorId 为空表示这是第一个纪元。 */
export interface MemoryIdentityEpochCreateInput {
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
}

/** 刷新当前身份纪元支撑面的入参：不开新纪元，只更新陈述、主线与支撑概念。 */
export interface MemoryIdentitySupportUpdateInput {
  id: string
  identityStatement: string
  globalMainline: string
  confidence: number
  supportingConceptIds: string[]
}

/** 落一版树投影的入参：全量节点、快照、相对基线版本的 diff 与事件哈希链。 */
export interface MemoryTreeProjectionReplaceInput {
  nodes: MemoryTreeNodeRecord[]
  snapshot: MemoryTreeSnapshotRecord
  baseVersion: number
  ops: MemoryTreeDiffOp[]
  identityChange: Nullable<Record<string, unknown>>
  previousEventHash: string
  eventHash: string
  runId: string
}

/** 一次会话级来源开关改动波及到的证据与主张。 */
export interface MemorySessionEligibilityChange {
  evidenceIds: string[]
  claimIds: string[]
}

/** 树路径索引：按节点 id 与「主体类型:主体 id」两把钥匙查同一批节点。 */
export interface MemoryTreePathIndex {
  byId: Map<string, MemoryTreeNodeRecord>
  bySubject: Map<string, MemoryTreeNodeRecord>
}

/** 一条证据整理出的四件套：证据本身与它派生的概念、经历、主张。 */
export interface ConsolidationResult {
  evidence: MemoryEvidenceRecord
  concept: MemoryConceptRow
  episode: MemoryEpisodeRow
  claim: MemoryClaimRow
}

/** 整理一条证据的某个视角时的附加输入：语义候选，以及要不要复用主视角的经历。 */
export interface ConsolidationViewOptions {
  semantic?: MemorySemanticCandidate
  sharedEpisode?: MemoryEpisodeRow
}

/** 概念身份三件套：类型、展示名，以及参与 stable_key 的区分串。 */
export interface MemoryConceptDescriptor {
  type: MemoryConceptType
  name: string
  stableDiscriminator: string
}

/** 语义候选能落到的类别：conversation 是原始视角，不由语义层派生。 */
export type DerivedMemoryCategory = Exclude<MemoryEvidenceCategory, 'conversation'>

/** 从一条证据里确定性抽出的语义候选：一条候选整理成一个额外的主张视角。 */
export interface MemorySemanticCandidate {
  category: DerivedMemoryCategory
  title: string
  content: string
  confidenceScale: number
  descriptor?: MemoryConceptDescriptor
}

/** 树 diff 的一步操作：增、改、移带整个节点，删只带稳定键。 */
export type MemoryTreeDiffOp =
  | { type: 'add' | 'update' | 'move'; node: MemoryTreeDiffNode; previousParentId?: LooseOptional<string> }
  | { type: 'remove'; stableKey: string }

/** 参与 diff 与哈希的节点形状：去掉投影版本号，同一节点在不同版本里哈希才稳定。 */
export type MemoryTreeDiffNode = Omit<MemoryTreeNodeRecord, 'projectionVersion'>
