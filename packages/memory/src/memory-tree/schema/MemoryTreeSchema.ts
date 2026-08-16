import type BetterSqlite3 from 'better-sqlite3'

type SQLiteDatabase = InstanceType<typeof BetterSqlite3>

/**
 * 测试版 v1 记忆树权威 schema。
 * 这是基线 schema 的领域片段，不包含历史转换或兼容 SQL。
 *
 * schema 文本归属记忆产品：产品宿主可以把本常量内联到单事务迁移链，serve / standalone
 * 宿主可调用 applyMemoryTreeSchema 建表。宿主只提供数据库解析器。
 */
export const MemoryTreeSchemaSql = `
    CREATE TABLE IF NOT EXISTS memory_meta (
      key TEXT PRIMARY KEY,
      integer_value INTEGER NOT NULL DEFAULT 0,
      text_value TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS memory_evidence (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      trust_level TEXT NOT NULL,
      source_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL DEFAULT '',
      execution_id TEXT NOT NULL DEFAULT '',
      workspace_root TEXT NOT NULL DEFAULT '',
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      category TEXT NOT NULL,
      privacy_class TEXT NOT NULL,
      eligibility_state TEXT NOT NULL DEFAULT 'active',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      ingest_sequence INTEGER NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      processed_at INTEGER,
      processed_by_run_id TEXT NOT NULL DEFAULT ''
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_evidence_source
      ON memory_evidence(source_type, source_id)
      WHERE source_id != '';
    CREATE INDEX IF NOT EXISTS idx_memory_evidence_frontier
      ON memory_evidence(eligibility_state, ingest_sequence);
    CREATE INDEX IF NOT EXISTS idx_memory_evidence_session
      ON memory_evidence(session_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_memory_evidence_scope
      ON memory_evidence(scope_type, scope_id, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS memory_concepts (
      id TEXT PRIMARY KEY,
      stable_key TEXT NOT NULL UNIQUE,
      concept_type TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      privacy_class TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL DEFAULT 'active',
      first_seen_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      evidence_count INTEGER NOT NULL DEFAULT 0,
      salience REAL NOT NULL DEFAULT 0.5,
      activation REAL NOT NULL DEFAULT 0.5,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_memory_concepts_scope
      ON memory_concepts(scope_type, scope_id, lifecycle_state);
    CREATE INDEX IF NOT EXISTS idx_memory_concepts_activity
      ON memory_concepts(lifecycle_state, activation DESC, last_active_at DESC);

    CREATE TABLE IF NOT EXISTS memory_concept_aliases (
      concept_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      source TEXT NOT NULL,
      confidence REAL NOT NULL,
      valid_from INTEGER NOT NULL,
      valid_to INTEGER,
      PRIMARY KEY (concept_id, alias),
      FOREIGN KEY (concept_id) REFERENCES memory_concepts(id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS memory_episodes (
      id TEXT PRIMARY KEY,
      stable_key TEXT NOT NULL UNIQUE,
      episode_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      primary_concept_id TEXT NOT NULL,
      source_session_id TEXT NOT NULL DEFAULT '',
      source_execution_id TEXT NOT NULL DEFAULT '',
      created_by_run_id TEXT NOT NULL,
      salience REAL NOT NULL DEFAULT 0.5,
      activation REAL NOT NULL DEFAULT 0.5,
      last_reinforced_at INTEGER NOT NULL,
      dormant_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (primary_concept_id) REFERENCES memory_concepts(id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_memory_episodes_scope
      ON memory_episodes(scope_type, scope_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_episodes_session
      ON memory_episodes(source_session_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS memory_episode_concepts (
      episode_id TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      role TEXT NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY (episode_id, concept_id, role),
      FOREIGN KEY (episode_id) REFERENCES memory_episodes(id) ON DELETE CASCADE,
      FOREIGN KEY (concept_id) REFERENCES memory_concepts(id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS memory_claims (
      id TEXT PRIMARY KEY,
      stable_key TEXT NOT NULL UNIQUE,
      subject_concept_id TEXT NOT NULL,
      predicate TEXT NOT NULL,
      value_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      epistemic_status TEXT NOT NULL,
      confidence REAL NOT NULL,
      privacy_class TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL DEFAULT 'active',
      lifecycle_reason TEXT NOT NULL DEFAULT '',
      valid_from INTEGER NOT NULL,
      valid_to INTEGER,
      review_after INTEGER,
      created_by_run_id TEXT NOT NULL,
      salience REAL NOT NULL DEFAULT 0.5,
      consolidation_strength REAL NOT NULL DEFAULT 0.5,
      activation REAL NOT NULL DEFAULT 0.5,
      last_reinforced_at INTEGER NOT NULL,
      dormant_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (subject_concept_id) REFERENCES memory_concepts(id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_memory_claims_subject
      ON memory_claims(subject_concept_id, lifecycle_state);
    CREATE INDEX IF NOT EXISTS idx_memory_claims_activation
      ON memory_claims(lifecycle_state, activation DESC, last_reinforced_at DESC);

    CREATE TABLE IF NOT EXISTS memory_claim_evidence (
      claim_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      weight REAL NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (claim_id, evidence_id),
      FOREIGN KEY (claim_id) REFERENCES memory_claims(id) ON DELETE CASCADE,
      FOREIGN KEY (evidence_id) REFERENCES memory_evidence(id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS memory_claim_episodes (
      claim_id TEXT NOT NULL,
      episode_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (claim_id, episode_id),
      FOREIGN KEY (claim_id) REFERENCES memory_claims(id) ON DELETE CASCADE,
      FOREIGN KEY (episode_id) REFERENCES memory_episodes(id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS memory_relations (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      confidence REAL NOT NULL,
      epistemic_status TEXT NOT NULL,
      valid_from INTEGER NOT NULL,
      valid_to INTEGER,
      created_by_run_id TEXT NOT NULL,
      activation REAL NOT NULL DEFAULT 0.5,
      last_reinforced_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (source_type, source_id, target_type, target_id, relation_type)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_memory_relations_source
      ON memory_relations(source_type, source_id, relation_type);
    CREATE INDEX IF NOT EXISTS idx_memory_relations_target
      ON memory_relations(target_type, target_id, relation_type);

    CREATE TABLE IF NOT EXISTS memory_relation_evidence (
      relation_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY (relation_id, evidence_id),
      FOREIGN KEY (relation_id) REFERENCES memory_relations(id) ON DELETE CASCADE,
      FOREIGN KEY (evidence_id) REFERENCES memory_evidence(id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS memory_identity_epochs (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL UNIQUE,
      identity_statement TEXT NOT NULL,
      global_mainline TEXT NOT NULL,
      confidence REAL NOT NULL,
      supporting_concept_ids_json TEXT NOT NULL DEFAULT '[]',
      supporting_episode_ids_json TEXT NOT NULL DEFAULT '[]',
      supporting_claim_ids_json TEXT NOT NULL DEFAULT '[]',
      predecessor_id TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      created_by_run_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (predecessor_id) REFERENCES memory_identity_epochs(id)
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_identity_epoch_active
      ON memory_identity_epochs((ended_at IS NULL))
      WHERE ended_at IS NULL;

    CREATE TABLE IF NOT EXISTS memory_tree_nodes (
      id TEXT PRIMARY KEY,
      stable_key TEXT NOT NULL UNIQUE,
      parent_id TEXT,
      node_type TEXT NOT NULL,
      namespace TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      mainline_score REAL NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0.5,
      first_seen_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      projection_version INTEGER NOT NULL,
      activation REAL NOT NULL DEFAULT 0.5,
      visibility_state TEXT NOT NULL DEFAULT 'active',
      FOREIGN KEY (parent_id) REFERENCES memory_tree_nodes(id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_memory_tree_nodes_parent
      ON memory_tree_nodes(parent_id, activation DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_tree_nodes_subject
      ON memory_tree_nodes(subject_type, subject_id);

    CREATE TABLE IF NOT EXISTS memory_tree_snapshots (
      version INTEGER PRIMARY KEY,
      root_node_id TEXT NOT NULL,
      active_identity_epoch_id TEXT NOT NULL,
      global_mainline_node_id TEXT NOT NULL,
      frontier_evidence_sequence INTEGER NOT NULL,
      created_by_run_id TEXT NOT NULL,
      tree_hash TEXT NOT NULL,
      event_head_hash TEXT NOT NULL,
      diff_summary_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS memory_tree_diffs (
      version INTEGER PRIMARY KEY,
      base_version INTEGER NOT NULL,
      ops_json TEXT NOT NULL,
      identity_change_json TEXT,
      op_count INTEGER NOT NULL,
      previous_event_hash TEXT NOT NULL,
      event_hash TEXT NOT NULL,
      created_by_run_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS memory_dream_runs (
      id TEXT PRIMARY KEY,
      trigger TEXT NOT NULL,
      state TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL UNIQUE,
      frontier_before INTEGER NOT NULL,
      frontier_after INTEGER NOT NULL,
      model_provider TEXT NOT NULL DEFAULT 'deterministic-v1',
      model TEXT NOT NULL DEFAULT 'meaning-projector-v1',
      candidate_count INTEGER NOT NULL DEFAULT 0,
      accepted_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0,
      tree_version_before INTEGER NOT NULL,
      tree_version_after INTEGER NOT NULL,
      error TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_memory_dream_runs_state
      ON memory_dream_runs(state, started_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_recall_fts USING fts5(
      subject_type UNINDEXED,
      subject_id UNINDEXED,
      title,
      body,
      scope_id UNINDEXED,
      tokenize = 'unicode61'
    );

    INSERT OR IGNORE INTO memory_meta(key, integer_value, text_value, updated_at)
      VALUES ('ingest_frontier', 0, '', 0);
    INSERT OR IGNORE INTO memory_meta(key, integer_value, text_value, updated_at)
      VALUES ('dream_frontier', 0, '', 0);
    INSERT OR IGNORE INTO memory_meta(key, integer_value, text_value, updated_at)
      VALUES ('tree_version', 0, '', 0);
`

/**
 * 把记忆树 schema 应用到宿主打开的共享连接（所有 CREATE 均 IF NOT EXISTS，幂等可重跑）。
 *
 * 记忆产品自带 schema 与迁移应用逻辑，宿主只递数据库解析器。宿主若把建表文本嵌入自己的
 * 迁移链，也必须复用 MemoryTreeSchemaSql，不得维护第二份 schema 定义。
 */
export function applyMemoryTreeSchema(database: SQLiteDatabase): void {
  database.exec(MemoryTreeSchemaSql)
}
