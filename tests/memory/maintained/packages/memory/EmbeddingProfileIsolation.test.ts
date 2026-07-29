/**
 * @test-meta
 * title: 向量模型隔离与历史保留
 * summary: 模型切换不重建旧向量；新内容按当前 profile 旁路写入，切回后可显式补齐。
 * area: packages
 */
import { describe, expect, test } from 'bun:test'

import type {
  KnowledgeChunkRecord,
  KnowledgeEmbeddingProviderId,
  KnowledgeRecord,
  KnowledgeVectorIndexRecord,
} from '@velaros-ai/knowledge'
import {
  buildDocumentRevisionKey,
  buildEmbeddingProfileIdentity,
  KnowledgeChunkBuilder,
  KnowledgeIndexStatuses,
  KnowledgeMutation,
  KnowledgeVectorQuery,
} from '@velaros-ai/knowledge'
import { unique } from '@velaros-ai/core'

const workspaceRoot = '/tmp/profile-isolation'
const documentPath = 'memory.md'

class FakeEmbeddingService {
  public provider: KnowledgeEmbeddingProviderId = 'openai'
  public model = 'embedding-a'
  public embedCalls = 0

  public getRuntimeSelection() {
    return { provider: this.provider, model: this.model }
  }

  public async embedTexts(texts: string[]): Promise<number[][]> {
    this.embedCalls += 1
    return texts.map(() => [0.1, 0.2, 0.3])
  }
}

class FakeKnowledgeRepository {
  public record: KnowledgeRecord | null = null
  public readonly vectorIndexes: KnowledgeVectorIndexRecord[] = []

  public findKnowledgeByWorkspaceAndPath(): KnowledgeRecord | null {
    return this.record
  }

  public findKnowledgeById(): KnowledgeRecord | null {
    return this.record
  }

  public upsertKnowledge(record: KnowledgeRecord): void {
    this.record = { ...record }
  }

  public replaceChunks(_documentId: string, _chunks: KnowledgeChunkRecord[]): void {}

  public updateIndexState(
    _documentId: string,
    indexStatus: KnowledgeRecord['indexStatus'],
    indexError: string,
    chunkCount: number,
    updatedAt: number
  ): void {
    if (!this.record) return
    this.record = { ...this.record, indexStatus, indexError, chunkCount, updatedAt }
  }

  public hasVectorIndex(
    documentId: string,
    indexTextHash: string,
    runtime: { provider: KnowledgeEmbeddingProviderId; model: string }
  ): boolean {
    return this.vectorIndexes.some(
      (index) =>
        index.documentId === documentId &&
        index.indexTextHash === indexTextHash &&
        index.embeddingProvider === runtime.provider &&
        index.embeddingModel === runtime.model
    )
  }

  public upsertVectorIndex(record: KnowledgeVectorIndexRecord): void {
    if (!this.hasVectorIndex(record.documentId, record.indexTextHash, record)) {
      this.vectorIndexes.push(record)
    }
  }

  public listVectorTablesForDocument(): string[] {
    return unique(this.vectorIndexes.map((index) => index.vectorTable))
  }

  public deleteKnowledge(): void {
    this.record = null
    this.vectorIndexes.length = 0
  }
}

class FakeKnowledgeVectors {
  public readonly writes: Array<{
    provider: KnowledgeEmbeddingProviderId
    model: string
    hash: string
  }> = []
  public deletedTables: string[] = []

  public async writeKnowledgeChunks(
    _knowledge: KnowledgeRecord,
    chunks: KnowledgeChunkRecord[],
    runtime: { provider: KnowledgeEmbeddingProviderId; model: string },
    indexTextHash: string
  ) {
    this.writes.push({ ...runtime, hash: indexTextHash })
    const profile = buildEmbeddingProfileIdentity(runtime, 3)
    return {
      embeddingDimensions: 3,
      profileKey: profile.profileKey,
      vectorTable: profile.vectorTable,
      chunkCount: chunks.length,
    }
  }

  public async deleteKnowledge(_documentId: string, tables: string[]): Promise<void> {
    this.deletedTables = [...tables]
  }
}

function buildInput(content: string) {
  return {
    workspaceRoot,
    path: documentPath,
    title: '向量边界',
    content,
    sourceKind: 'markdown' as const,
  }
}

describe('embedding profile isolation', () => {
  test('switching models keeps old vectors and does not rebuild unchanged content', async () => {
    const repository = new FakeKnowledgeRepository()
    const embeddings = new FakeEmbeddingService()
    const vectors = new FakeKnowledgeVectors()
    const mutation = new KnowledgeMutation(
      repository as never,
      embeddings as never,
      vectors as never,
      new KnowledgeChunkBuilder()
    )
    const originalContent = '这是足够长的第一版知识内容，用来验证切换向量模型不会重建或删除之前的向量。'.repeat(4)

    const first = await mutation.upsertKnowledge(buildInput(originalContent))
    const firstHash = first.indexTextHash
    expect(embeddings.embedCalls).toBe(1)
    expect(vectors.writes.map((write) => write.model)).toEqual(['embedding-a'])
    expect(repository.vectorIndexes).toHaveLength(1)

    embeddings.model = 'embedding-b'
    const unchanged = await mutation.upsertKnowledge(buildInput(originalContent))
    expect(unchanged.indexTextHash).toBe(firstHash)
    expect(embeddings.embedCalls).toBe(1)
    expect(vectors.writes).toHaveLength(1)
    expect(repository.vectorIndexes).toHaveLength(1)

    const changed = await mutation.upsertKnowledge(
      buildInput(`${originalContent}\n这是第二版，只为当前 embedding-b 写入新的内容版本。`)
    )
    expect(changed.indexTextHash).not.toBe(firstHash)
    expect(embeddings.embedCalls).toBe(2)
    expect(vectors.writes.map((write) => write.model)).toEqual(['embedding-a', 'embedding-b'])
    expect(repository.vectorIndexes).toHaveLength(2)

    embeddings.model = 'embedding-a'
    await mutation.reindexKnowledge(changed.id)
    expect(embeddings.embedCalls).toBe(3)
    expect(repository.vectorIndexes).toHaveLength(3)

    const preservedTables = repository.listVectorTablesForDocument()
    await mutation.deleteKnowledge(changed.id)
    expect(vectors.deletedTables.sort()).toEqual([...preservedTables].sort())
    expect(repository.record).toBeNull()
  })

  test('profile and revision identities are stable and search filters exact revisions', () => {
    const first = buildEmbeddingProfileIdentity(
      { provider: 'openai', model: 'text-embedding-3-large' },
      3072
    )
    const same = buildEmbeddingProfileIdentity(
      { provider: 'openai', model: 'text-embedding-3-large' },
      3072
    )
    const differentDimensions = buildEmbeddingProfileIdentity(
      { provider: 'openai', model: 'text-embedding-3-large' },
      1536
    )
    expect(first).toEqual(same)
    expect(first.profileKey).not.toBe(differentDimensions.profileKey)
    expect(first.vectorTable).not.toBe(differentDimensions.vectorTable)

    const helper = new KnowledgeVectorQuery()
    const revisionKey = buildDocumentRevisionKey('memory-1', 'content-hash-1')
    const where = helper.buildSearchWhereClause({
      workspaceRoot,
      documentRevisionKeys: [revisionKey],
    })
    expect(where).toContain(`document_revision_key IN ('${revisionKey}')`)
    expect(where).not.toContain('document_id IN')
  })

  test('the document status can stay ready without implying the active model was backfilled', () => {
    const record: Pick<KnowledgeRecord, 'indexStatus' | 'embeddingModel'> = {
      indexStatus: KnowledgeIndexStatuses.READY,
      embeddingModel: 'embedding-a',
    }
    expect(record.indexStatus).toBe(KnowledgeIndexStatuses.READY)
    expect(record.embeddingModel).toBe('embedding-a')
  })
})
