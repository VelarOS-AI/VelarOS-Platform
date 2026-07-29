/**
 * Knowledge-owned indexing constants.
 *
 * These values used to live in Kernel Core under `MemoryConfig`, even though
 * they exclusively describe this package's document and vector indexes.
 */
export const KnowledgeIndexStatuses = {
  PENDING: 'pending',
  READY: 'ready',
  PARTIAL: 'partial',
  FAILED: 'failed',
} as const

export const KnowledgeMatchTypes = {
  VECTOR: 'vector',
  TEXT: 'text',
  HYBRID: 'hybrid',
  RECENT: 'recent',
} as const

export const KnowledgeIndexConfig = {
  DEFAULT_LIST_LIMIT: 20,
  DEFAULT_SEARCH_LIMIT: 8,
  MAX_LIST_LIMIT: 100,
  MAX_SEARCH_LIMIT: 50,
  CHUNK_SIZE: 1200,
  CHUNK_OVERLAP: 160,
  MIN_CHUNK_LENGTH: 40,
  MIN_BOUNDARY_OFFSET: 300,
  TEXT_CANDIDATE_MULTIPLIER: 4,
  VECTOR_CANDIDATE_MULTIPLIER: 4,
  VECTOR_INDEX_MIN_ROWS: 64,
  VECTOR_INDEX_WAIT_TIMEOUT_SECONDS: 120,
  VECTOR_INDEX_PROBE_COUNT: 20,
  VECTOR_FILTER_MEMORY_ID_LIMIT: 2048,
  VECTOR_OPTIMIZE_WRITE_INTERVAL: 20,
  VECTOR_OPTIMIZE_RETENTION_HOURS: 24,
  TEXT_BM25_COLUMN_WEIGHTS: [0, 10, 6, 1.5, 4] as const,
  TEXT_SCORE_BM25_WEIGHT: 0.85,
  TEXT_SCORE_POSITION_WEIGHT: 0.15,
  TEXT_SNIPPET_LENGTH: 180,
  TEXT_SNIPPET_CONTEXT_CHARS: 72,
  FRESHNESS_ACCESS_HALF_LIFE_DAYS: 7,
  FRESHNESS_UPDATE_HALF_LIFE_DAYS: 30,
  FRESHNESS_ACCESS_WEIGHT: 0.65,
  FRESHNESS_UPDATE_WEIGHT: 0.35,
  FRESHNESS_MIN_SCORE_MULTIPLIER: 0.72,
  VECTOR_WEIGHT: 0.82,
  TEXT_WEIGHT: 0.18,
  SQLITE_BUSY_TIMEOUT_MS: 5000,
} as const
