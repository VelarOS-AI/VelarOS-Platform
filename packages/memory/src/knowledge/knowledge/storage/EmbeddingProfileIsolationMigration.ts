/**
 * Knowledge 自有的 SQLite schema 迁移定义。
 *
 * 宿主迁移 runner 可以直接消费这一结构；Knowledge 不反向依赖任何产品宿主的迁移类型或路径。
 */
export const KnowledgeEmbeddingProfileIsolationMigration = {
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
} as const
