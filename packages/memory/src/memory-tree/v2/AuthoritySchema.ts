import type BetterSqlite3 from 'better-sqlite3'

type SQLiteDatabase = InstanceType<typeof BetterSqlite3>

/**
 * Memory Tree v2 的首个独立 authority schema 版本。
 *
 * 这里的 “1” 是 authority.sqlite3 自身的 append-only migration 序号，不是产品协议版本；
 * 数据库身份由 application_id 单独锁为 Memory Tree v2。
 */
export const MemoryAuthoritySchemaVersionV2 = 3
export const MemoryAuthorityApplicationIdV2 = 0x564d5632 // ASCII "VMV2"
export const MemoryAuthorityMigrationIdV2 = 'memory-authority-v2:0001-baseline'
export const MemoryAuthorityMeaningEvidenceMigrationIdV2 =
  'memory-authority-v2:0002-meaning-evidence-links'
export const MemoryAuthorityEvidenceReplayMigrationIdV2 =
  'memory-authority-v2:0003-evidence-replay-ledger'

/**
 * authority 根只允许三类列：
 * ① 结构；② 等值盲索引；③ 密文 blob 引用 + 随机承诺。
 * ④ 明文派生投影只能进入加密 index generation，不得出现在本 schema。
 */
export const MemoryAuthorityBlindIndexColumnsV2 = Object.freeze([
  'source_match_key',
  'scope_match_key',
  'name_match_key',
  'alias_match_key',
  'claim_group_key',
  'target_match_key',
] as const)

export const MemoryAuthorityEncryptedContentColumnsV2 = Object.freeze([
  'payload_blob_ref',
  'payload_commitment',
  'metadata_blob_ref',
  'metadata_commitment',
  'name_blob_ref',
  'name_commitment',
  'description_blob_ref',
  'description_commitment',
  'alias_blob_ref',
  'alias_commitment',
  'title_blob_ref',
  'title_commitment',
  'summary_blob_ref',
  'summary_commitment',
  'result_blob_ref',
  'result_commitment',
  'value_blob_ref',
  'value_commitment',
  'identity_statement_blob_ref',
  'identity_statement_commitment',
  'global_mainline_blob_ref',
  'global_mainline_commitment',
  'state_blob_ref',
  'state_commitment',
  'candidate_ledger_blob_ref',
  'candidate_ledger_commitment',
  'error_blob_ref',
  'error_commitment',
] as const)

/**
 * 一旦这些 v1 明文列名重新出现在 v2 authority schema，就说明语义正文绕过了 blob 边界。
 * 静态探针与运行时 open 都会拒绝。
 */
export const MemoryAuthorityForbiddenPlaintextColumnsV2 = Object.freeze([
  'alias',
  'body',
  'canonical_name',
  'content',
  'description',
  'diff_summary',
  'error',
  'global_mainline',
  'identity_statement',
  'scope_id',
  'summary',
  'title',
  'value_json',
  'workspace_root',
] as const)

const MatchKeyCheck = (column: string): string =>
  `(${column} IS NULL OR (` +
  `length(${column}) = 67 AND substr(${column}, 1, 3) = 'm2:' ` +
  `AND substr(${column}, 4) NOT GLOB '*[^0-9a-f]*'))`

const StableKeyCheck = (column: string): string =>
  `(length(${column}) = 35 AND substr(${column}, 1, 3) = 'k2:' ` +
  `AND substr(${column}, 4) NOT GLOB '*[^0-9a-f]*')`

const GroupKeyCheck = (column: string): string =>
  `(length(${column}) = 35 AND substr(${column}, 1, 3) = 'g2:' ` +
  `AND substr(${column}, 4) NOT GLOB '*[^0-9a-f]*')`

const GovernanceMatchKeyCheck = (column: string): string =>
  `(${column} IS NULL OR (` +
  `length(${column}) = 35 AND substr(${column}, 1, 3) = 'd2:' ` +
  `AND substr(${column}, 4) NOT GLOB '*[^0-9a-f]*'))`

const CommitmentCheck = (column: string): string =>
  `(${column} IS NULL OR (` +
  `length(${column}) = 67 AND substr(${column}, 1, 3) = 'c2:' ` +
  `AND substr(${column}, 4) NOT GLOB '*[^0-9a-f]*'))`

const FingerprintCheck = (column: string): string =>
  `(length(${column}) = 67 AND substr(${column}, 1, 3) = 'f2:' ` +
  `AND substr(${column}, 4) NOT GLOB '*[^0-9a-f]*')`

const HashCheck = (column: string): string =>
  `(length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*')`

const BlobRefCheck = (column: string): string =>
  `(${column} IS NULL OR (length(${column}) = 32 AND ${column} NOT GLOB '*[^0-9a-f]*'))`

const BlobPairCheck = (reference: string, commitment: string): string =>
  `((${reference} IS NULL) = (${commitment} IS NULL))`

/**
 * 全新 v2 authority schema。没有旧表 rename/copy/backfill，也没有 compatibility view。
 *
 * 允许的 JSON 列只承载内部 id、枚举、结构操作与统计；任何自由文本错误、标题、摘要、
 * 名称、值、路径或 URL 都必须先封进 ContentKeyServiceV2 blob。
 */
export const MemoryAuthoritySchemaSqlV2 = `
  CREATE TABLE memory_schema_migrations (
    version INTEGER PRIMARY KEY,
    migration_id TEXT NOT NULL UNIQUE,
    applied_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE memory_meta (
    key TEXT PRIMARY KEY,
    integer_value INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE memory_content_blobs (
    blob_id TEXT PRIMARY KEY
      CHECK (${BlobRefCheck('blob_id')}),
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'erased')),
    created_at INTEGER NOT NULL,
    erased_at INTEGER
  ) STRICT;

  CREATE TABLE memory_evidence (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    source_type TEXT NOT NULL CHECK (length(source_type) > 0),
    trust_level TEXT NOT NULL CHECK (length(trust_level) > 0),
    source_id TEXT,
    source_match_key TEXT CHECK (${MatchKeyCheck('source_match_key')}),
    session_id TEXT,
    execution_id TEXT,
    scope_type TEXT NOT NULL CHECK (length(scope_type) > 0),
    scope_match_key TEXT CHECK (${MatchKeyCheck('scope_match_key')}),
    occurred_at INTEGER NOT NULL,
    payload_blob_ref TEXT CHECK (${BlobRefCheck('payload_blob_ref')}),
    payload_commitment TEXT CHECK (${CommitmentCheck('payload_commitment')}),
    metadata_blob_ref TEXT CHECK (${BlobRefCheck('metadata_blob_ref')}),
    metadata_commitment TEXT CHECK (${CommitmentCheck('metadata_commitment')}),
    privacy_class TEXT NOT NULL
      CHECK (privacy_class IN ('standard', 'personal', 'sensitive')),
    eligibility_state TEXT NOT NULL
      CHECK (eligibility_state IN ('active', 'source_deleted', 'excluded', 'erased')),
    ingest_sequence INTEGER NOT NULL UNIQUE CHECK (ingest_sequence > 0),
    created_at INTEGER NOT NULL,
    processed_at INTEGER,
    processed_by_run_id TEXT,
    CHECK (${BlobPairCheck('payload_blob_ref', 'payload_commitment')}),
    CHECK (${BlobPairCheck('metadata_blob_ref', 'metadata_commitment')}),
    FOREIGN KEY (payload_blob_ref) REFERENCES memory_content_blobs(blob_id),
    FOREIGN KEY (metadata_blob_ref) REFERENCES memory_content_blobs(blob_id)
  ) STRICT;

  CREATE INDEX idx_memory_evidence_frontier
    ON memory_evidence(eligibility_state, ingest_sequence);
  CREATE INDEX idx_memory_evidence_source_id
    ON memory_evidence(source_type, source_id)
    WHERE source_id IS NOT NULL;
  CREATE INDEX idx_memory_evidence_source_match
    ON memory_evidence(source_match_key)
    WHERE source_match_key IS NOT NULL;
  CREATE INDEX idx_memory_evidence_scope_match
    ON memory_evidence(scope_type, scope_match_key, occurred_at DESC);
  CREATE INDEX idx_memory_evidence_session
    ON memory_evidence(session_id, occurred_at)
    WHERE session_id IS NOT NULL;

  CREATE TABLE memory_concepts (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    stable_key TEXT NOT NULL UNIQUE CHECK (${StableKeyCheck('stable_key')}),
    concept_type TEXT NOT NULL CHECK (length(concept_type) > 0),
    name_blob_ref TEXT CHECK (${BlobRefCheck('name_blob_ref')}),
    name_commitment TEXT CHECK (${CommitmentCheck('name_commitment')}),
    name_match_key TEXT CHECK (${MatchKeyCheck('name_match_key')}),
    description_blob_ref TEXT CHECK (${BlobRefCheck('description_blob_ref')}),
    description_commitment TEXT CHECK (${CommitmentCheck('description_commitment')}),
    scope_type TEXT NOT NULL CHECK (length(scope_type) > 0),
    scope_match_key TEXT CHECK (${MatchKeyCheck('scope_match_key')}),
    privacy_class TEXT NOT NULL
      CHECK (privacy_class IN ('standard', 'personal', 'sensitive')),
    lifecycle_state TEXT NOT NULL
      CHECK (lifecycle_state IN (
        'transient', 'candidate', 'active', 'consolidated',
        'dormant', 'reactivated', 'erased'
      )),
    first_seen_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
    salience REAL NOT NULL DEFAULT 0.5 CHECK (salience >= 0 AND salience <= 1),
    activation REAL NOT NULL DEFAULT 0.5 CHECK (activation >= 0 AND activation <= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (${BlobPairCheck('name_blob_ref', 'name_commitment')}),
    CHECK (${BlobPairCheck('description_blob_ref', 'description_commitment')}),
    CHECK (lifecycle_state = 'erased' OR name_blob_ref IS NOT NULL),
    FOREIGN KEY (name_blob_ref) REFERENCES memory_content_blobs(blob_id),
    FOREIGN KEY (description_blob_ref) REFERENCES memory_content_blobs(blob_id)
  ) STRICT;

  CREATE INDEX idx_memory_concepts_name_match
    ON memory_concepts(name_match_key)
    WHERE name_match_key IS NOT NULL;
  CREATE INDEX idx_memory_concepts_scope_match
    ON memory_concepts(scope_type, scope_match_key, lifecycle_state);
  CREATE INDEX idx_memory_concepts_activity
    ON memory_concepts(lifecycle_state, activation DESC, last_active_at DESC);

  CREATE TABLE memory_concept_aliases (
    concept_id TEXT NOT NULL,
    alias_blob_ref TEXT CHECK (${BlobRefCheck('alias_blob_ref')}),
    alias_commitment TEXT CHECK (${CommitmentCheck('alias_commitment')}),
    alias_match_key TEXT NOT NULL CHECK (${MatchKeyCheck('alias_match_key')}),
    source_type TEXT NOT NULL CHECK (length(source_type) > 0),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    valid_from INTEGER NOT NULL,
    valid_to INTEGER,
    PRIMARY KEY (concept_id, alias_match_key),
    CHECK (${BlobPairCheck('alias_blob_ref', 'alias_commitment')}),
    FOREIGN KEY (concept_id) REFERENCES memory_concepts(id) ON DELETE CASCADE,
    FOREIGN KEY (alias_blob_ref) REFERENCES memory_content_blobs(blob_id)
  ) STRICT;

  CREATE INDEX idx_memory_concept_alias_match
    ON memory_concept_aliases(alias_match_key);

  CREATE TABLE memory_episodes (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    stable_key TEXT NOT NULL UNIQUE CHECK (${StableKeyCheck('stable_key')}),
    episode_type TEXT NOT NULL CHECK (length(episode_type) > 0),
    title_blob_ref TEXT CHECK (${BlobRefCheck('title_blob_ref')}),
    title_commitment TEXT CHECK (${CommitmentCheck('title_commitment')}),
    summary_blob_ref TEXT CHECK (${BlobRefCheck('summary_blob_ref')}),
    summary_commitment TEXT CHECK (${CommitmentCheck('summary_commitment')}),
    state TEXT NOT NULL CHECK (length(state) > 0),
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    scope_type TEXT NOT NULL CHECK (length(scope_type) > 0),
    scope_match_key TEXT CHECK (${MatchKeyCheck('scope_match_key')}),
    primary_concept_id TEXT NOT NULL,
    result_ref TEXT,
    result_blob_ref TEXT CHECK (${BlobRefCheck('result_blob_ref')}),
    result_commitment TEXT CHECK (${CommitmentCheck('result_commitment')}),
    created_by_run_id TEXT NOT NULL,
    salience REAL NOT NULL DEFAULT 0.5 CHECK (salience >= 0 AND salience <= 1),
    activation REAL NOT NULL DEFAULT 0.5 CHECK (activation >= 0 AND activation <= 1),
    last_reinforced_at INTEGER NOT NULL,
    dormant_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (${BlobPairCheck('title_blob_ref', 'title_commitment')}),
    CHECK (${BlobPairCheck('summary_blob_ref', 'summary_commitment')}),
    CHECK (${BlobPairCheck('result_blob_ref', 'result_commitment')}),
    FOREIGN KEY (primary_concept_id) REFERENCES memory_concepts(id),
    FOREIGN KEY (title_blob_ref) REFERENCES memory_content_blobs(blob_id),
    FOREIGN KEY (summary_blob_ref) REFERENCES memory_content_blobs(blob_id),
    FOREIGN KEY (result_blob_ref) REFERENCES memory_content_blobs(blob_id)
  ) STRICT;

  CREATE INDEX idx_memory_episodes_scope_match
    ON memory_episodes(scope_type, scope_match_key, started_at DESC);
  CREATE INDEX idx_memory_episodes_primary_concept
    ON memory_episodes(primary_concept_id, started_at DESC);

  CREATE TABLE memory_episode_concepts (
    episode_id TEXT NOT NULL,
    concept_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (length(role) > 0),
    weight REAL NOT NULL CHECK (weight >= 0 AND weight <= 1),
    PRIMARY KEY (episode_id, concept_id, role),
    FOREIGN KEY (episode_id) REFERENCES memory_episodes(id) ON DELETE CASCADE,
    FOREIGN KEY (concept_id) REFERENCES memory_concepts(id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE memory_claims (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    stable_key TEXT NOT NULL UNIQUE CHECK (${StableKeyCheck('stable_key')}),
    claim_group_key TEXT NOT NULL CHECK (${GroupKeyCheck('claim_group_key')}),
    subject_concept_id TEXT NOT NULL,
    predicate TEXT NOT NULL CHECK (length(predicate) > 0),
    value_blob_ref TEXT CHECK (${BlobRefCheck('value_blob_ref')}),
    value_commitment TEXT CHECK (${CommitmentCheck('value_commitment')}),
    storage_mode TEXT NOT NULL CHECK (storage_mode IN ('full', 'index_only', 'reference')),
    payload_ref TEXT,
    summary_blob_ref TEXT CHECK (${BlobRefCheck('summary_blob_ref')}),
    summary_commitment TEXT CHECK (${CommitmentCheck('summary_commitment')}),
    epistemic_status TEXT NOT NULL CHECK (length(epistemic_status) > 0),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    privacy_class TEXT NOT NULL
      CHECK (privacy_class IN ('standard', 'personal', 'sensitive')),
    lifecycle_state TEXT NOT NULL
      CHECK (lifecycle_state IN (
        'transient', 'candidate', 'active', 'consolidated',
        'dormant', 'reactivated', 'erased'
      )),
    valid_from INTEGER NOT NULL,
    valid_to INTEGER,
    review_after INTEGER,
    created_by_run_id TEXT NOT NULL,
    salience REAL NOT NULL DEFAULT 0.5 CHECK (salience >= 0 AND salience <= 1),
    consolidation_strength REAL NOT NULL DEFAULT 0.5
      CHECK (consolidation_strength >= 0 AND consolidation_strength <= 1),
    activation REAL NOT NULL DEFAULT 0.5 CHECK (activation >= 0 AND activation <= 1),
    last_reinforced_at INTEGER NOT NULL,
    dormant_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (${BlobPairCheck('value_blob_ref', 'value_commitment')}),
    CHECK (${BlobPairCheck('summary_blob_ref', 'summary_commitment')}),
    CHECK (lifecycle_state = 'erased' OR value_blob_ref IS NOT NULL),
    FOREIGN KEY (subject_concept_id) REFERENCES memory_concepts(id),
    FOREIGN KEY (value_blob_ref) REFERENCES memory_content_blobs(blob_id),
    FOREIGN KEY (summary_blob_ref) REFERENCES memory_content_blobs(blob_id)
  ) STRICT;

  CREATE INDEX idx_memory_claims_group
    ON memory_claims(claim_group_key, lifecycle_state);
  CREATE INDEX idx_memory_claims_subject
    ON memory_claims(subject_concept_id, lifecycle_state);
  CREATE INDEX idx_memory_claims_activation
    ON memory_claims(lifecycle_state, activation DESC, last_reinforced_at DESC);

  CREATE TABLE memory_claim_evidence (
    claim_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    relation TEXT NOT NULL CHECK (length(relation) > 0),
    weight REAL NOT NULL CHECK (weight >= 0 AND weight <= 1),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (claim_id, evidence_id),
    FOREIGN KEY (claim_id) REFERENCES memory_claims(id) ON DELETE CASCADE,
    FOREIGN KEY (evidence_id) REFERENCES memory_evidence(id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE memory_claim_episodes (
    claim_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (claim_id, episode_id),
    FOREIGN KEY (claim_id) REFERENCES memory_claims(id) ON DELETE CASCADE,
    FOREIGN KEY (episode_id) REFERENCES memory_episodes(id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE memory_relations (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    source_type TEXT NOT NULL CHECK (length(source_type) > 0),
    source_id TEXT NOT NULL CHECK (length(source_id) > 0),
    target_type TEXT NOT NULL CHECK (length(target_type) > 0),
    target_id TEXT NOT NULL CHECK (length(target_id) > 0),
    relation_type TEXT NOT NULL CHECK (length(relation_type) > 0),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    epistemic_status TEXT NOT NULL CHECK (length(epistemic_status) > 0),
    valid_from INTEGER NOT NULL,
    valid_to INTEGER,
    created_by_run_id TEXT NOT NULL,
    activation REAL NOT NULL DEFAULT 0.5 CHECK (activation >= 0 AND activation <= 1),
    last_reinforced_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (source_type, source_id, target_type, target_id, relation_type)
  ) STRICT;

  CREATE INDEX idx_memory_relations_source
    ON memory_relations(source_type, source_id, relation_type);
  CREATE INDEX idx_memory_relations_target
    ON memory_relations(target_type, target_id, relation_type);

  CREATE TABLE memory_relation_evidence (
    relation_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    weight REAL NOT NULL CHECK (weight >= 0 AND weight <= 1),
    PRIMARY KEY (relation_id, evidence_id),
    FOREIGN KEY (relation_id) REFERENCES memory_relations(id) ON DELETE CASCADE,
    FOREIGN KEY (evidence_id) REFERENCES memory_evidence(id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE memory_identity_epochs (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    sequence INTEGER NOT NULL UNIQUE CHECK (sequence > 0),
    identity_statement_blob_ref TEXT
      CHECK (${BlobRefCheck('identity_statement_blob_ref')}),
    identity_statement_commitment TEXT
      CHECK (${CommitmentCheck('identity_statement_commitment')}),
    global_mainline_blob_ref TEXT
      CHECK (${BlobRefCheck('global_mainline_blob_ref')}),
    global_mainline_commitment TEXT
      CHECK (${CommitmentCheck('global_mainline_commitment')}),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    supporting_concept_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(supporting_concept_ids_json)),
    supporting_episode_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(supporting_episode_ids_json)),
    supporting_claim_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(supporting_claim_ids_json)),
    predecessor_id TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    created_by_run_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK (${BlobPairCheck('identity_statement_blob_ref', 'identity_statement_commitment')}),
    CHECK (${BlobPairCheck('global_mainline_blob_ref', 'global_mainline_commitment')}),
    FOREIGN KEY (identity_statement_blob_ref) REFERENCES memory_content_blobs(blob_id),
    FOREIGN KEY (global_mainline_blob_ref) REFERENCES memory_content_blobs(blob_id),
    FOREIGN KEY (predecessor_id) REFERENCES memory_identity_epochs(id)
  ) STRICT;

  CREATE UNIQUE INDEX idx_memory_identity_epoch_active
    ON memory_identity_epochs((ended_at IS NULL))
    WHERE ended_at IS NULL;

  CREATE TABLE memory_tree_snapshots (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    root_node_id TEXT NOT NULL CHECK (length(root_node_id) > 0),
    active_identity_epoch_id TEXT NOT NULL,
    global_mainline_node_id TEXT NOT NULL CHECK (length(global_mainline_node_id) > 0),
    frontier_evidence_sequence INTEGER NOT NULL CHECK (frontier_evidence_sequence >= 0),
    created_by_run_id TEXT NOT NULL,
    tree_hash TEXT NOT NULL CHECK (${HashCheck('tree_hash')}),
    event_head_hash TEXT NOT NULL CHECK (${HashCheck('event_head_hash')}),
    diff_summary_json TEXT NOT NULL CHECK (json_valid(diff_summary_json)),
    created_at INTEGER NOT NULL,
    FOREIGN KEY (active_identity_epoch_id) REFERENCES memory_identity_epochs(id)
  ) STRICT;

  CREATE TABLE memory_tree_diffs (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    base_version INTEGER NOT NULL CHECK (base_version >= 0 AND base_version < version),
    ops_json TEXT NOT NULL CHECK (json_valid(ops_json)),
    identity_change_json TEXT CHECK (
      identity_change_json IS NULL OR json_valid(identity_change_json)
    ),
    op_count INTEGER NOT NULL CHECK (op_count >= 0),
    previous_event_hash TEXT NOT NULL CHECK (${HashCheck('previous_event_hash')}),
    event_hash TEXT NOT NULL UNIQUE CHECK (${HashCheck('event_hash')}),
    created_by_run_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (version) REFERENCES memory_tree_snapshots(version) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE memory_tree_bases (
    base_version INTEGER PRIMARY KEY CHECK (base_version > 0),
    state_blob_ref TEXT NOT NULL CHECK (${BlobRefCheck('state_blob_ref')}),
    state_commitment TEXT NOT NULL CHECK (${CommitmentCheck('state_commitment')}),
    tree_hash TEXT NOT NULL CHECK (${HashCheck('tree_hash')}),
    compacted_from_version INTEGER NOT NULL CHECK (compacted_from_version > 0),
    compacted_to_version INTEGER NOT NULL
      CHECK (compacted_to_version >= compacted_from_version),
    prior_segment_event_head TEXT NOT NULL
      CHECK (${HashCheck('prior_segment_event_head')}),
    base_event_hash TEXT NOT NULL UNIQUE CHECK (${HashCheck('base_event_hash')}),
    canonical_version INTEGER NOT NULL CHECK (canonical_version > 0),
    compaction_version INTEGER NOT NULL CHECK (compaction_version > 0),
    manifest_hash TEXT NOT NULL CHECK (${HashCheck('manifest_hash')}),
    created_at INTEGER NOT NULL,
    CHECK (${BlobPairCheck('state_blob_ref', 'state_commitment')}),
    FOREIGN KEY (state_blob_ref) REFERENCES memory_content_blobs(blob_id)
  ) STRICT;

  CREATE TABLE memory_tree_compactions (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    base_version INTEGER NOT NULL,
    source_from_version INTEGER NOT NULL CHECK (source_from_version > 0),
    source_to_version INTEGER NOT NULL CHECK (source_to_version >= source_from_version),
    deleted_diff_count INTEGER NOT NULL CHECK (deleted_diff_count >= 0),
    validation_before TEXT NOT NULL CHECK (validation_before IN ('passed', 'failed')),
    validation_after TEXT NOT NULL CHECK (validation_after IN ('passed', 'failed')),
    created_at INTEGER NOT NULL,
    FOREIGN KEY (base_version) REFERENCES memory_tree_bases(base_version)
  ) STRICT;

  CREATE TABLE memory_erasure_requests (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    target_type TEXT NOT NULL CHECK (length(target_type) > 0),
    target_id TEXT NOT NULL CHECK (length(target_id) > 0),
    closure_json TEXT NOT NULL CHECK (json_valid(closure_json)),
    redact_version INTEGER NOT NULL CHECK (redact_version > 0),
    privacy_generation INTEGER NOT NULL CHECK (privacy_generation > 0),
    state TEXT NOT NULL
      CHECK (state IN ('confirmed', 'purging', 'verified', 'stalled')),
    error_blob_ref TEXT CHECK (${BlobRefCheck('error_blob_ref')}),
    error_commitment TEXT CHECK (${CommitmentCheck('error_commitment')}),
    created_at INTEGER NOT NULL,
    verified_at INTEGER,
    CHECK (${BlobPairCheck('error_blob_ref', 'error_commitment')}),
    FOREIGN KEY (redact_version) REFERENCES memory_tree_snapshots(version),
    FOREIGN KEY (error_blob_ref) REFERENCES memory_content_blobs(blob_id)
  ) STRICT;

  CREATE TABLE memory_erasure_targets (
    request_id TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK (length(target_type) > 0),
    target_id TEXT NOT NULL CHECK (length(target_id) > 0),
    deny_generation INTEGER NOT NULL CHECK (deny_generation > 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
    PRIMARY KEY (request_id, target_type, target_id),
    FOREIGN KEY (request_id) REFERENCES memory_erasure_requests(id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX idx_memory_erasure_targets_lookup
    ON memory_erasure_targets(target_type, target_id, state);
  CREATE INDEX idx_memory_erasure_targets_generation
    ON memory_erasure_targets(deny_generation, state);

  CREATE TABLE memory_outbound_disclosures (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    provider TEXT NOT NULL CHECK (length(provider) > 0),
    model TEXT NOT NULL CHECK (length(model) > 0),
    disclosure_class TEXT NOT NULL CHECK (length(disclosure_class) > 0),
    related_ids_json TEXT NOT NULL CHECK (json_valid(related_ids_json)),
    privacy_generation INTEGER NOT NULL CHECK (privacy_generation >= 0),
    state TEXT NOT NULL CHECK (state IN ('planned', 'sending', 'sent', 'cancelled')),
    occurred_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE memory_dream_runs (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    trigger TEXT NOT NULL CHECK (length(trigger) > 0),
    state TEXT NOT NULL CHECK (state IN (
      'queued', 'running', 'validating', 'committed',
      'failed', 'cancelled', 'skipped'
    )),
    input_fingerprint TEXT NOT NULL UNIQUE
      CHECK (${FingerprintCheck('input_fingerprint')}),
    frontier_before INTEGER NOT NULL CHECK (frontier_before >= 0),
    frontier_after INTEGER NOT NULL CHECK (frontier_after >= frontier_before),
    candidate_ledger_blob_ref TEXT
      CHECK (${BlobRefCheck('candidate_ledger_blob_ref')}),
    candidate_ledger_commitment TEXT
      CHECK (${CommitmentCheck('candidate_ledger_commitment')}),
    error_code TEXT,
    error_blob_ref TEXT CHECK (${BlobRefCheck('error_blob_ref')}),
    error_commitment TEXT CHECK (${CommitmentCheck('error_commitment')}),
    model_provider TEXT,
    model TEXT,
    token_usage INTEGER NOT NULL DEFAULT 0 CHECK (token_usage >= 0),
    candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
    accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
    rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
    tree_version_before INTEGER NOT NULL CHECK (tree_version_before >= 0),
    tree_version_after INTEGER NOT NULL CHECK (tree_version_after >= 0),
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    CHECK (${BlobPairCheck('candidate_ledger_blob_ref', 'candidate_ledger_commitment')}),
    CHECK (${BlobPairCheck('error_blob_ref', 'error_commitment')}),
    FOREIGN KEY (candidate_ledger_blob_ref) REFERENCES memory_content_blobs(blob_id),
    FOREIGN KEY (error_blob_ref) REFERENCES memory_content_blobs(blob_id)
  ) STRICT;

  CREATE INDEX idx_memory_dream_runs_state
    ON memory_dream_runs(state, started_at DESC);

  INSERT INTO memory_meta(key, integer_value, updated_at)
    VALUES
      ('evidence_ingest_sequence', 0, 0),
      ('dream_frontier', 0, 0),
      ('tree_version', 0, 0),
      ('privacy_generation', 0, 0);
`

export const MemoryAuthorityMeaningEvidenceMigrationSqlV2 = `
  CREATE TABLE memory_concept_evidence (
    concept_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    weight REAL NOT NULL CHECK (weight >= 0 AND weight <= 1),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (concept_id, evidence_id),
    FOREIGN KEY (concept_id) REFERENCES memory_concepts(id) ON DELETE CASCADE,
    FOREIGN KEY (evidence_id) REFERENCES memory_evidence(id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX idx_memory_concept_evidence_evidence
    ON memory_concept_evidence(evidence_id);

  CREATE TABLE memory_episode_evidence (
    episode_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    weight REAL NOT NULL CHECK (weight >= 0 AND weight <= 1),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (episode_id, evidence_id),
    FOREIGN KEY (episode_id) REFERENCES memory_episodes(id) ON DELETE CASCADE,
    FOREIGN KEY (evidence_id) REFERENCES memory_evidence(id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX idx_memory_episode_evidence_evidence
    ON memory_episode_evidence(evidence_id);
`

export const MemoryAuthorityEvidenceReplayMigrationSqlV2 = `
  CREATE TABLE memory_evidence_replay_ledger (
    source_database_id TEXT NOT NULL CHECK (
      length(source_database_id) = 71
      AND substr(source_database_id, 1, 7) = 'sha256:'
      AND substr(source_database_id, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    legacy_evidence_id TEXT NOT NULL,
    legacy_ingest_sequence INTEGER NOT NULL CHECK (legacy_ingest_sequence > 0),
    evidence_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('replayed', 'tombstone')),
    replayed_at INTEGER NOT NULL,
    PRIMARY KEY (source_database_id, legacy_evidence_id),
    UNIQUE (source_database_id, legacy_ingest_sequence),
    UNIQUE (evidence_id),
    FOREIGN KEY (evidence_id) REFERENCES memory_evidence(id)
  ) STRICT;

  CREATE INDEX idx_memory_evidence_replay_sequence
    ON memory_evidence_replay_ledger(source_database_id, legacy_ingest_sequence);

  CREATE TABLE memory_replay_governance (
    source_database_id TEXT NOT NULL CHECK (
      length(source_database_id) = 71
      AND substr(source_database_id, 1, 7) = 'sha256:'
      AND substr(source_database_id, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    governance_type TEXT NOT NULL
      CHECK (governance_type IN (
        'eligibility', 'forgotten', 'superseded', 'erased', 'scope_degraded'
      )),
    legacy_target_id TEXT NOT NULL,
    legacy_evidence_id TEXT NOT NULL DEFAULT '',
    evidence_id TEXT,
    target_match_key TEXT CHECK (${GovernanceMatchKeyCheck('target_match_key')}),
    deny_generation INTEGER CHECK (deny_generation IS NULL OR deny_generation > 0),
    disposition TEXT NOT NULL
      CHECK (disposition IN ('applied', 'pending', 'known_loss')),
    reason_code TEXT NOT NULL CHECK (length(reason_code) > 0),
    recorded_at INTEGER NOT NULL,
    CHECK ((target_match_key IS NULL) = (deny_generation IS NULL)),
    PRIMARY KEY (
      source_database_id, governance_type, legacy_target_id,
      legacy_evidence_id, reason_code
    ),
    FOREIGN KEY (evidence_id) REFERENCES memory_evidence(id)
  ) STRICT;

  CREATE INDEX idx_memory_replay_governance_disposition
    ON memory_replay_governance(source_database_id, disposition, governance_type);

  CREATE INDEX idx_memory_replay_governance_target
    ON memory_replay_governance(target_match_key, disposition, governance_type)
    WHERE target_match_key IS NOT NULL;
`

export function applyMemoryAuthoritySchemaV2(
  database: SQLiteDatabase,
  appliedAt = Date.now()
): void {
  database.exec(MemoryAuthoritySchemaSqlV2)
  database
    .prepare(
      `INSERT INTO memory_schema_migrations(version, migration_id, applied_at)
       VALUES (?, ?, ?)`
    )
    .run(1, MemoryAuthorityMigrationIdV2, appliedAt)
}

export function applyMemoryAuthorityMeaningEvidenceMigrationV2(
  database: SQLiteDatabase,
  appliedAt = Date.now()
): void {
  database.exec(MemoryAuthorityMeaningEvidenceMigrationSqlV2)
  database
    .prepare(
      `INSERT INTO memory_schema_migrations(version, migration_id, applied_at)
       VALUES (2, ?, ?)`
    )
    .run(MemoryAuthorityMeaningEvidenceMigrationIdV2, appliedAt)
}

export function applyMemoryAuthorityEvidenceReplayMigrationV2(
  database: SQLiteDatabase,
  appliedAt = Date.now()
): void {
  database.exec(MemoryAuthorityEvidenceReplayMigrationSqlV2)
  database
    .prepare(
      `INSERT INTO memory_schema_migrations(version, migration_id, applied_at)
       VALUES (3, ?, ?)`
    )
    .run(MemoryAuthorityEvidenceReplayMigrationIdV2, appliedAt)
}
