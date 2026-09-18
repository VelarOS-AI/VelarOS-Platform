/**
 * 约定的常量表：来源类型、索引状态与命中类型、索引与检索的公开参数、宿主拼装用的存储迁移。
 *
 * 这个文件随 `./contracts` 入口出包，所以它不 import 任何东西、不用 Node 专属类型，只放 `Object.freeze` 的表、
 * `as const` 的字符串身份，以及由它们 `typeof` 派生的类型别名。改这里等于改对外契约。
 * 包内可调的数字（超时、缓冲、保留条数）不在这里，在 `utils/tuning.ts`。
 */

/**
 * 知识来源类型的取值表：摄入按它给每份文档定类型，检索按它过滤。
 * 模型面 `velar:knowledge` 的来源类型与它一致（两边由 tests/capabilities 的接缝测试核对）。
 */
export const KnowledgeSourceKinds = Object.freeze([
  'markdown',
  'text',
  'json',
  'config',
  'code',
] as const)

/** 一份知识文档的索引状态；宿主与检索结果都按这几个值判断。 */
export const KnowledgeIndexStatuses = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  PARTIAL: 'partial',
  FAILED: 'failed',
} as const)

/** 一条搜索结果是怎么命中的：纯向量、纯文本、两者融合，或空查询的最近列表。 */
export const KnowledgeMatchTypes = Object.freeze({
  VECTOR: 'vector',
  TEXT: 'text',
  HYBRID: 'hybrid',
  RECENT: 'recent',
} as const)

/**
 * 索引与检索的公开参数表。
 *
 * 它是本包发布出去的既有常量（宿主按它对齐分页与评分预期），所以整张表留在合同里；
 * 只在包内使用、随时可以改的数字在 `utils/tuning.ts`。
 */
export const KnowledgeIndexConfig = Object.freeze({
  /** 列表类查询的缺省返回条数。 */
  DEFAULT_LIST_LIMIT: 20,
  /** 搜索没传 limit 时返回几条。 */
  DEFAULT_SEARCH_LIMIT: 8,
  /** 列表类查询的最大返回条数。 */
  MAX_LIST_LIMIT: 100,
  /** 一次检索最多排多少条：模型面 `velar:knowledge` 的 limit 上限与它一致。 */
  MAX_SEARCH_LIMIT: 50,
  /** 单个 chunk 的目标字符数。 */
  CHUNK_SIZE: 1200,
  /** 相邻 chunk 之间重叠的字符数，减少切割处的语义丢失。 */
  CHUNK_OVERLAP: 160,
  /** 短于这个字符数的 chunk 直接丢弃。 */
  MIN_CHUNK_LENGTH: 40,
  /** 在这个偏移之前不找自然断点，避免切出过短的首片。 */
  MIN_BOUNDARY_OFFSET: 300,
  /** 文本召回先取 limit 的几倍作为候选，再统一重排。 */
  TEXT_CANDIDATE_MULTIPLIER: 4,
  /** 向量召回先取 limit 的几倍作为候选，再统一重排。 */
  VECTOR_CANDIDATE_MULTIPLIER: 4,
  /** 一张向量表少于这么多行时不建向量索引，暴力扫描更快。 */
  VECTOR_INDEX_MIN_ROWS: 64,
  /** 等待向量索引建成的秒数上限。 */
  VECTOR_INDEX_WAIT_TIMEOUT_SECONDS: 120,
  /** 向量检索每次探查的分区数。 */
  VECTOR_INDEX_PROBE_COUNT: 20,
  /** 一次向量查询最多带几个文档 id 作为过滤条件。 */
  VECTOR_FILTER_MEMORY_ID_LIMIT: 2048,
  /** 写入多少次之后触发一次向量表整理。 */
  VECTOR_OPTIMIZE_WRITE_INTERVAL: 20,
  /** 向量表整理时保留多少小时以内的历史版本。 */
  VECTOR_OPTIMIZE_RETENTION_HOURS: 24,
  /** 公布的 FTS bm25 列权重；仓库内部实际使用的一份跟着规则写在 `utils/query.ts`。 */
  TEXT_BM25_COLUMN_WEIGHTS: [0, 10, 6, 1.5, 4] as const,
  /** 文本相关性里 bm25 名次占的权重。 */
  TEXT_SCORE_BM25_WEIGHT: 0.85,
  /** 文本相关性里结果位置占的权重。 */
  TEXT_SCORE_POSITION_WEIGHT: 0.15,
  /** 文本命中摘要的字符数。 */
  TEXT_SNIPPET_LENGTH: 180,
  /** 摘要里命中词前后各保留多少字符的上下文。 */
  TEXT_SNIPPET_CONTEXT_CHARS: 72,
  /** 「最近被用过」的半衰期天数。 */
  FRESHNESS_ACCESS_HALF_LIFE_DAYS: 7,
  /** 「最近被更新过」的半衰期天数。 */
  FRESHNESS_UPDATE_HALF_LIFE_DAYS: 30,
  /** 新鲜度里访问时间占的权重。 */
  FRESHNESS_ACCESS_WEIGHT: 0.65,
  /** 新鲜度里更新时间占的权重。 */
  FRESHNESS_UPDATE_WEIGHT: 0.35,
  /** 新鲜度最低也保留这个折扣倍数，久远知识不会被压到零。 */
  FRESHNESS_MIN_SCORE_MULTIPLIER: 0.72,
  /** 混合评分里向量通道占的权重。 */
  VECTOR_WEIGHT: 0.82,
  /** 混合评分里文本通道占的权重。 */
  TEXT_WEIGHT: 0.18,
  /** SQLite 写锁等待的毫秒数。 */
  SQLITE_BUSY_TIMEOUT_MS: 5000,
} as const)

/**
 * 嵌入 profile 物理隔离的 SQLite 迁移（版本 3）。
 *
 * 宿主的迁移 runner 直接消费这一结构：SQLite 只保留可用于文本检索与显式重建的分块正文，
 * 向量只住在 LanceDB；向量派生物按 provider/model/dimensions 登记在 `knowledge_vector_indexes` 里。
 */
export const KnowledgeEmbeddingProfileIsolationMigration = Object.freeze({
  /** 迁移版本号，宿主按它决定跑不跑这一步。 */
  version: 3,
  name: 'embedding_profile_isolation',
  upSql: `
    -- SQLite 只保存可用于文本检索和显式重建的分块正文；向量只存在 LanceDB。
    DROP TABLE IF EXISTS knowledge_chunks_profile_clean;
    CREATE TABLE knowledge_chunks_profile_clean (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
    ) STRICT;
    INSERT INTO knowledge_chunks_profile_clean (
      id, document_id, chunk_index, content, created_at, updated_at
    )
    SELECT id, document_id, chunk_index, content, created_at, updated_at
    FROM knowledge_chunks;
    DROP TABLE knowledge_chunks;
    ALTER TABLE knowledge_chunks_profile_clean RENAME TO knowledge_chunks;
    CREATE INDEX idx_knowledge_chunks_document_id
      ON knowledge_chunks(document_id);
    CREATE INDEX idx_knowledge_chunks_chunk_index
      ON knowledge_chunks(document_id, chunk_index);

    CREATE TABLE IF NOT EXISTS knowledge_vector_indexes (
      document_id TEXT NOT NULL,
      index_text_hash TEXT NOT NULL,
      embedding_provider TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      embedding_dimensions INTEGER NOT NULL,
      profile_key TEXT NOT NULL,
      vector_table TEXT NOT NULL,
      chunk_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (
        document_id,
        index_text_hash,
        embedding_provider,
        embedding_model,
        embedding_dimensions,
        vector_table
      ),
      FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_knowledge_vector_indexes_active_profile
      ON knowledge_vector_indexes(
        embedding_provider,
        embedding_model,
        embedding_dimensions,
        index_text_hash
      );
    CREATE INDEX IF NOT EXISTS idx_knowledge_vector_indexes_document
      ON knowledge_vector_indexes(document_id, index_text_hash);
    CREATE INDEX IF NOT EXISTS idx_knowledge_vector_indexes_profile_key
      ON knowledge_vector_indexes(profile_key);

    -- 文件快照只跟踪分块/内容策略。provider/model 变化不是索引过期。
    UPDATE knowledge_file_index
    SET index_runtime_key = 'knowledge-chunk-builder:v2'
    WHERE index_runtime_key <> '';
  `,
} as const)

