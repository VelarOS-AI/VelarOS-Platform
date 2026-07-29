/**
 * @test-meta
 * title: LanceDB 向量 profile 物理隔离
 * summary: 使用真实 LanceDB 验证多模型分表、内容版本过滤与跨 profile 隐私删除。
 * area: packages
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'

import type {
  KnowledgeEmbeddingProviderId,
  KnowledgeRecord,
} from '@velaros-ai/memory/knowledge'
import {
  buildDocumentRevisionKey,
  KnowledgeEmbeddingProfileIsolationMigration,
  KnowledgeIndexStatuses,
  KnowledgeRepo,
  KnowledgeRows,
  KnowledgeVectorQuery,
  KnowledgeVectors,
} from '@velaros-ai/memory/knowledge'

let storagePath = ''

before(async () => {
  storagePath = await mkdtemp(join(tmpdir(), 'velaros-vector-profiles-'))
})

after(async () => {
  if (storagePath) await rm(storagePath, { recursive: true, force: true })
})

function buildKnowledge(content: string): KnowledgeRecord {
  return {
    id: 'memory-1',
    workspaceRoot: '/workspace',
    path: 'memory.md',
    title: 'Memory',
    summary: '',
    content,
    sourceKind: 'markdown',
    tags: [],
    indexStatus: KnowledgeIndexStatuses.READY,
    indexError: '',
    chunkCount: 1,
    indexTextHash: '',
    embeddingProvider: 'openai',
    embeddingModel: 'embedding-a',
    createdAt: 1,
    updatedAt: 2,
    lastAccessedAt: 2,
  }
}

function buildChunk(model: string, content: string, vector: number[]) {
  return {
    id: 'memory-1:0',
    documentId: 'memory-1',
    chunkIndex: 0,
    content,
    embedding: vector,
    embeddingModel: model,
    embeddingDimensions: vector.length,
    createdAt: 1,
    updatedAt: 2,
  }
}

test('keeps profiles and revisions isolated in real LanceDB tables', async () => {
  const store = new KnowledgeVectors(new KnowledgeVectorQuery(), {
    getLanceDatabasePath: () => storagePath,
  })
  await store.warmup()
  const runtimeA = {
    provider: 'openai' as KnowledgeEmbeddingProviderId,
    model: 'embedding-a',
  }
  const runtimeB = {
    provider: 'openai' as KnowledgeEmbeddingProviderId,
    model: 'embedding-b',
  }
  const hashA1 = 'hash-a1'
  const hashB1 = 'hash-b1'
  const hashA2 = 'hash-a2'

  const indexA1 = await store.writeKnowledgeChunks(
    buildKnowledge('a1'),
    [buildChunk(runtimeA.model, 'content-a1', [1, 0, 0])],
    runtimeA,
    hashA1
  )
  const indexB1 = await store.writeKnowledgeChunks(
    buildKnowledge('b1'),
    [buildChunk(runtimeB.model, 'content-b1', [0, 1, 0])],
    runtimeB,
    hashB1
  )
  const indexA2 = await store.writeKnowledgeChunks(
    buildKnowledge('a2'),
    [buildChunk(runtimeA.model, 'content-a2', [0.9, 0.1, 0])],
    runtimeA,
    hashA2
  )
  const indexA2Retry = await store.writeKnowledgeChunks(
    buildKnowledge('a2-reindexed'),
    [buildChunk(runtimeA.model, 'content-a2-reindexed', [0.8, 0.2, 0])],
    runtimeA,
    hashA2
  )

  assert.equal(indexA1.vectorTable, indexA2.vectorTable)
  assert.equal(indexA2.vectorTable, indexA2Retry.vectorTable)
  assert.notEqual(indexA1.vectorTable, indexB1.vectorTable)

  const a1Results = await store.searchSimilarChunks([1, 0, 0], {
    workspaceRoot: '/workspace',
    vectorTable: indexA1.vectorTable,
    documentRevisionKeys: [buildDocumentRevisionKey('memory-1', hashA1)],
    limit: 5,
  })
  assert.deepEqual(a1Results.map((result) => result.content), ['content-a1'])

  const a2Results = await store.searchSimilarChunks([1, 0, 0], {
    workspaceRoot: '/workspace',
    vectorTable: indexA2.vectorTable,
    documentRevisionKeys: [buildDocumentRevisionKey('memory-1', hashA2)],
    limit: 5,
  })
  assert.deepEqual(a2Results.map((result) => result.content), ['content-a2-reindexed'])

  const bResults = await store.searchSimilarChunks([0, 1, 0], {
    workspaceRoot: '/workspace',
    vectorTable: indexB1.vectorTable,
    documentRevisionKeys: [buildDocumentRevisionKey('memory-1', hashB1)],
    limit: 5,
  })
  assert.deepEqual(bResults.map((result) => result.content), ['content-b1'])

  const statsBeforeDelete = await store.getStats()
  assert.equal(statsBeforeDelete.rowCount, 3)

  await store.deleteKnowledge('memory-1', [indexA1.vectorTable, indexB1.vectorTable])
  const statsAfterDelete = await store.getStats()
  assert.equal(statsAfterDelete.rowCount, 0)
  store.close()
})

test('repository exposes only current revision rows from the active provider/model', () => {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE knowledge_documents (
      id TEXT PRIMARY KEY,
      workspace_root TEXT NOT NULL,
      index_text_hash TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE knowledge_vector_indexes (
      document_id TEXT NOT NULL,
      index_text_hash TEXT NOT NULL,
      embedding_provider TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      embedding_dimensions INTEGER NOT NULL,
      profile_key TEXT NOT NULL,
      vector_table TEXT NOT NULL,
      chunk_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO knowledge_documents VALUES (
      'memory-1', '/workspace', 'current-hash', 'markdown', 10
    );
    INSERT INTO knowledge_vector_indexes VALUES
      ('memory-1', 'current-hash', 'openai', 'embedding-a', 3, 'profile-a', 'table-a', 1, 1, 2),
      ('memory-1', 'old-hash', 'openai', 'embedding-a', 3, 'profile-a', 'table-a', 1, 1, 2),
      ('memory-1', 'current-hash', 'openai', 'embedding-b', 3, 'profile-b', 'table-b', 1, 1, 2);
  `)

  const repository = new KnowledgeRepo(
    new KnowledgeRows(),
    () => database
  )
  const activeA = repository.listVectorSearchPartitions(
    '/workspace',
    { provider: 'openai', model: 'embedding-a' },
    {},
    20
  )
  assert.equal(activeA.length, 1)
  assert.equal(activeA[0]?.vectorTable, 'table-a')
  assert.deepEqual(activeA[0]?.documentRevisionKeys, [
    buildDocumentRevisionKey('memory-1', 'current-hash'),
  ])

  const activeB = repository.listVectorSearchPartitions(
    '/workspace',
    { provider: 'openai', model: 'embedding-b' },
    {},
    20
  )
  assert.equal(activeB.length, 1)
  assert.equal(activeB[0]?.vectorTable, 'table-b')
  database.close()
})

test('v3 removes SQLite embedding placeholders and starts with an empty vector registry', () => {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE knowledge_documents (
      id TEXT PRIMARY KEY
    ) STRICT;
    CREATE TABLE knowledge_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding_json TEXT NOT NULL DEFAULT '',
      embedding_model TEXT NOT NULL DEFAULT '',
      embedding_dimensions INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX idx_knowledge_chunks_document_id
      ON knowledge_chunks(document_id);
    CREATE INDEX idx_knowledge_chunks_chunk_index
      ON knowledge_chunks(document_id, chunk_index);
    CREATE TABLE knowledge_file_index (
      index_runtime_key TEXT NOT NULL
    ) STRICT;
    INSERT INTO knowledge_documents VALUES ('memory-1');
    INSERT INTO knowledge_chunks VALUES (
      'memory-1:0', 'memory-1', 0, 'retained text', '', 'old-model', 3, 1, 2
    );
    INSERT INTO knowledge_file_index VALUES ('old-runtime-key');
  `)

  database.exec(KnowledgeEmbeddingProfileIsolationMigration.upSql)

  const chunkColumns = database
    .prepare('PRAGMA table_info(knowledge_chunks)')
    .all()
    .map((row) => (row as { name: string }).name)
  assert.deepEqual(chunkColumns, [
    'id',
    'document_id',
    'chunk_index',
    'content',
    'created_at',
    'updated_at',
  ])
  assert.equal(
    database.prepare('SELECT content FROM knowledge_chunks').pluck().get(),
    'retained text'
  )
  assert.equal(database.prepare('SELECT COUNT(*) FROM knowledge_vector_indexes').pluck().get(), 0)
  assert.equal(
    database.prepare('SELECT index_runtime_key FROM knowledge_file_index').pluck().get(),
    'knowledge-chunk-builder:v2'
  )
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
  assert.equal(database.prepare('PRAGMA integrity_check').pluck().get(), 'ok')
  database.close()
})
