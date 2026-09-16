import { compact, isEmpty, isFiniteNumber, isString } from '@velaros-ai/core'

import type { KnowledgeRecord } from '../../types/knowledge.js'
import type {
  KnowledgeChunkRecord,
  KnowledgeVectorMatch,
  KnowledgeVectorRow,
} from '../../types/storage.js'
import { buildDocumentRevisionKey } from '../../utils/indexing.js'
import {
  buildDeleteDocumentPredicate,
  buildRevisionFilter,
  buildSearchWhereClause,
} from '../../utils/vector-query.js'

/**
 * 知识向量库的行翻译器：chunk 元数据变成 LanceDB 行、拼 where 与 delete 谓词、把动态行读成稳定结构。
 *
 * 实例由 `KnowledgeVectors` 持有；它不碰连接，只做纯翻译。
 */
export interface KnowledgeVectorQueryApi {
  /** 把带向量的 chunk 转成 LanceDB 行；没有向量的 chunk 不进向量检索。 */
  buildChunkRows(
    knowledge: KnowledgeRecord,
    chunks: KnowledgeChunkRecord[],
    indexTextHash: string
  ): KnowledgeVectorRow[]
  /** 隐私删除的谓词：清掉这份文档在这张表里的全部向量版本。 */
  buildDeleteDocumentPredicate(documentId: string): string
  /** merge 的过滤条件：只清理完全相同的内容版本。 */
  buildRevisionFilter(documentRevisionKey: string): string
  /** 向量检索的过滤条件：限定工作区并钉住内容版本。 */
  buildSearchWhereClause(options: {
    workspaceRoot: string
    documentRevisionKeys: string[]
  }): string
  /** 解析 LanceDB 返回的搜索行，形状不对的丢掉。 */
  parseSearchRows(rows: Array<Record<string, unknown>>): KnowledgeVectorMatch[]
}

/** 见 {@link KnowledgeVectorQueryApi}。 */
export class KnowledgeVectorQuery implements KnowledgeVectorQueryApi {
  public buildChunkRows(
    knowledge: KnowledgeRecord,
    chunks: KnowledgeChunkRecord[],
    indexTextHash: string
  ): KnowledgeVectorRow[] {
    const documentRevisionKey = buildDocumentRevisionKey(knowledge.id, indexTextHash)
    return (
      chunks
        // 没有 embedding 的 chunk 不进向量检索。
        .filter((chunk) => !isEmpty(chunk.embedding))
        .map((chunk) => ({
          chunk_id: `${documentRevisionKey}:${chunk.chunkIndex}`,
          document_id: chunk.documentId,
          document_revision_key: documentRevisionKey,
          index_text_hash: indexTextHash,
          workspace_root: knowledge.workspaceRoot,
          path: knowledge.path,
          chunk_index: chunk.chunkIndex,
          content: chunk.content,
          updated_at: knowledge.updatedAt,
          vector: chunk.embedding,
        }))
    )
  }

  public buildDeleteDocumentPredicate(documentId: string): string {
    return buildDeleteDocumentPredicate(documentId)
  }

  public buildRevisionFilter(documentRevisionKey: string): string {
    return buildRevisionFilter(documentRevisionKey)
  }

  public buildSearchWhereClause(options: {
    workspaceRoot: string
    documentRevisionKeys: string[]
  }): string {
    return buildSearchWhereClause(options)
  }

  public parseSearchRows(rows: Array<Record<string, unknown>>): KnowledgeVectorMatch[] {
    return compact(rows
      .map((row) => {
        if (!isString(row.document_id) || !isString(row.chunk_id) || !isString(row.content) || !isFiniteNumber(row._distance)
        ) return null

        return {
          documentId: row.document_id,
          chunkId: row.chunk_id,
          content: row.content,
          distance: row._distance,
        }
      }))
  }
}
