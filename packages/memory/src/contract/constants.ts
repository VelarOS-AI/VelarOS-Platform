/**
 * 约定的常量表（对外合同的一部分）：工具身份与类别、后端身份与动词、作用域身份、文件权威层的目录约定、
 * 公开的上限。宿主按这里的名字登记工具与后端，工具说明与 schema 里的数字直接引这里的上限——改这个文件
 * 等于改模型看到的字节。包内可调、不对外承诺的参数不在这里，在 `utils/tuning.ts`。
 *
 * 不 import 任何东西、不用 Node 专属类型，整个文件随 `./contracts` 入口出包（渲染进程可加载）。
 */

/** 四个记忆工具的 canonical 名字。 */
export const MemoryToolNames = Object.freeze({
  save: 'memory:save',
  search: 'memory:search',
  get: 'memory:get',
  archive: 'memory:archive',
} as const)

/** 工具名的联合类型，由上表派生。 */
export type MemoryToolName = (typeof MemoryToolNames)[keyof typeof MemoryToolNames]

/** 四个记忆工具同属一个职责类别：记忆。 */
export const MemoryToolCategoryId = 'memory' as const

/** 记忆后端的短 id：能力令牌、descriptor、设置页的后端选择都用它。 */
export const MemoryBackendIds = Object.freeze({
  tree: 'tree',
  files: 'files',
  vector: 'vector',
} as const)

/** 树权威层的后端 id。 */
export const MemoryTreeBackendId = 'tree' as const

/** 文件权威层（出厂默认）的后端 id。 */
export const MemoryFilesBackendId = 'files' as const

/** 向量派生索引的后端 id；渲染进程的嵌入设置页按它判断这一档装没装。 */
export const MemoryVectorBackendId = 'vector' as const

/**
 * 窄端口的全部动词。
 *
 * `capture` / `recall` / `inspect` / `archive` 是权威层的入场券（见 {@link RequiredAuthorityMemoryVerbs}）；
 * `dream` / `govern` 是能力扩展，由后端按实现声明。派生索引不是权威层，只声明自己真做的那几个。
 */
export const MemoryBackendVerbs = Object.freeze([
  'capture',
  'recall',
  'inspect',
  'archive',
  'dream',
  'govern',
] as const)

/** 动词的联合类型，由上表派生。 */
export type MemoryBackendVerb = (typeof MemoryBackendVerbs)[number]

/**
 * 权威层必备动词。
 *
 * 少一个就不是一个能当真相层用的记忆后端：不能 capture 等于写不进，不能 recall 等于读不出，
 * 不能 inspect 等于诊断面永远是空的，不能 archive 等于用户没有任何撤回粒度。
 */
export const RequiredAuthorityMemoryVerbs: readonly MemoryBackendVerb[] = Object.freeze([
  'capture',
  'recall',
  'inspect',
  'archive',
] as const)

/** 不带前缀的两个作用域身份。 */
export const MemoryScopeIds = Object.freeze({
  global: 'global',
  system: 'system',
} as const)

/** 全局作用域 id：这一档的记忆处处可见，`global` 记忆管理面同时代表「全部」。 */
export const GLOBAL_MEMORY_SCOPE = 'global' as const

/** 系统作用域 id：与项目、站点互不可见的独立池。 */
export const SYSTEM_MEMORY_SCOPE = 'system' as const

/**
 * 带参数的作用域前缀。
 *
 * 作用域格式（`project:<根>`、`site:<源>`、`system`、`global`）由本包拥有；宿主只负责把它的上下文
 * 映射到一个作用域 id，不需要认识这些前缀的含义。
 */
export const MemoryScopePrefixes = Object.freeze({
  project: 'project:',
  site: 'site:',
  session: 'session:',
  execution: 'execution:',
} as const)

/** 记忆后端注册进内核用的能力令牌身份。 */
export const MemoryStoreCapabilityIdentity = Object.freeze({
  namespace: 'velaros.memory.store',
  defaultVersion: '1.0.0',
} as const)

/** 能力令牌族前缀；完整 id = `${MemoryStoreCapabilityNamespace}.${backendId}`。 */
export const MemoryStoreCapabilityNamespace = 'velaros.memory.store' as const

/** 没写版本时能力令牌用的缺省版本号。 */
export const DefaultMemoryStoreCapabilityVersion = '1.0.0' as const

/** 回合召回写进回合上下文账本时用的来源 id；宿主按它认这一路增量。 */
export const MemoryTurnContextSourceId = 'memory.recall' as const

/** 文件权威层的目录与文件约定：每个作用域一个目录，条目在 `entries/`，索引是一份 markdown。 */
export const MemoryFilesLayout = Object.freeze({
  indexFileName: 'MEMORY.md',
  indexHeading: '# Memory index',
  entriesDirectoryName: 'entries',
  vectorIndexFileName: 'vector-index.json',
} as const)

/** 文件权威层的索引文件名。 */
export const MemoryIndexFileName = 'MEMORY.md' as const

/** 文件权威层索引文件的一级标题，解析与写回都认它。 */
export const MemoryIndexHeading = '# Memory index' as const

/** 向量派生索引落盘的文件名（每个作用域一份）。 */
export const MemoryVectorIndexFileName = 'vector-index.json' as const

/** 向量索引的记录形状版本；变了就重建，不写迁移器。 */
export const MemoryVectorIndex = Object.freeze({
  /** 记录形状的版本号，进版本戳的 schema 段。 */
  schemaVersion: 1,
} as const)

/** 一条证据进入后端之前的硬上限，两处（工具 schema 与清洗器）引同一份。 */
export const MemoryEvidenceLimits = Object.freeze({
  /** 证据正文最多多少字符，超出按截断处理。 */
  contentChars: 24_000,
  /** 证据标题最多多少字符。 */
  titleChars: 240,
} as const)

/** 工具 schema 与工具说明里写给模型看的上限；说明文字用模板字符串引这里，改一处模型看到的跟着变。 */
export const MemoryToolLimits = Object.freeze({
  /** `memory:save` 的 summary 最多多少字符。 */
  summaryChars: 1_000,
  /** `memory:save` 的 source 最多多少字符。 */
  sourceChars: 240,
  /** `memory:save` 的单个标签最多多少字符。 */
  tagChars: 80,
  /** `memory:save` 最多带多少个标签。 */
  tagCount: 24,
  /** `memory:save` 的 taskKey 最多多少字符。 */
  taskKeyChars: 240,
  /** `memory:search` 的 query 最多多少字符。 */
  queryChars: 500,
  /** `memory:search` 一次最多返回多少条。 */
  recallItems: 50,
  /** `memory:archive` 的 reason 最多多少字符。 */
  archiveReasonChars: 500,
} as const)

/** 记忆的类别表；模型面的枚举与后端的类别用同一份。 */
export const MemoryEvidenceCategories = Object.freeze([
  'conversation',
  'fact',
  'preference',
  'feedback',
  'procedure',
  'project',
  'task',
  'goal',
  'interest',
  'entity',
  'artifact',
] as const)

/**
 * 工具输入边界上认的旧类别别名。
 *
 * 只在工具入参这一层存在：进内核之前立即归一到 {@link MemoryEvidenceCategories} 里的名字，
 * 后端与存储里永远看不到别名。
 */
export const MemoryEvidenceCategoryAliases = Object.freeze({
  session: 'conversation',
  user: 'preference',
  reference: 'artifact',
} as const)

/** 隐私级：写进条目元数据，供宿主决定展示与导出口径。 */
export const MemoryPrivacyClasses = Object.freeze([
  'standard',
  'personal',
  'sensitive',
] as const)

/** `memory:search` 的三种模式：检索、浏览、画像。 */
export const MemorySearchModes = Object.freeze([
  'search',
  'browse',
  'profile',
] as const)

/** 记忆树 v1 的存储约定：建表 SQL 由产品宿主内联进自己的迁移链，全仓只有这一份。 */
export const MemoryTreeStorage = Object.freeze({
  /** 测试版 v1 记忆树权威 schema 的建表 SQL（全部 CREATE 均 IF NOT EXISTS，幂等可重跑）。 */
  schemaSql: `
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
`,
} as const)
