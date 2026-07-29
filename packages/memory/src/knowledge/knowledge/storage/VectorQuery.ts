import { compact, isEmpty, isFiniteNumber,isString } from '@velaros-ai/core'

import { buildDocumentRevisionKey } from '../../shared'
import type { KnowledgeRecord } from '../domain/Types'

import type { KnowledgeChunkRecord } from './RepositoryRows'

/** LanceDB profile 专属向量表行。 */
export interface KnowledgeVectorRow extends Record<string, unknown> {
  chunk_id: string
  document_id: string
  document_revision_key: string
  index_text_hash: string
  workspace_root: string
  path: string
  chunk_index: number
  content: string
  updated_at: number
  vector: number[]
}

/** 向量搜索命中的知识 chunk。 */
export interface KnowledgeVectorMatch {
  documentId: string
  chunkId: string
  content: string
  distance: number
}

/**
 * 知识向量库辅助方法。
 *
 * 负责把 chunk 元数据转换成 LanceDB 行，拼接 where/delete predicate，
 * 并把 LanceDB 返回的动态行解析成稳定结构。
 */
export class KnowledgeVectorQuery {
  /** 将含 embedding 的 chunk 转成 LanceDB 行。 */
  public buildChunkRows(
    knowledge: KnowledgeRecord,
    chunks: KnowledgeChunkRecord[],
    indexTextHash: string
  ): KnowledgeVectorRow[] {
    const documentRevisionKey = buildDocumentRevisionKey(knowledge.id, indexTextHash)
    return (
      chunks
        // 没有 embedding 的 chunk 不进入向量搜索。
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

  /** 隐私删除会清理每个物理分区中属于该文档的全部向量版本。 */
  public buildDeleteDocumentPredicate(documentId: string): string {
    return `document_id = ${this.quoteSqlString(documentId)}`
  }

  /** 限定 merge 只清理完全相同的内容版本，不影响其它模型或历史版本。 */
  public buildRevisionFilter(documentRevisionKey: string): string {
    return `document_revision_key = ${this.quoteSqlString(documentRevisionKey)}`
  }

  /** 构造向量搜索过滤条件。 */
  public buildSearchWhereClause(options: {
    workspaceRoot: string
    documentRevisionKeys: string[]
  }): string {
    const filters = [`workspace_root = ${this.quoteSqlString(options.workspaceRoot)}`]

    if (!isEmpty(options.documentRevisionKeys)) {
      const quotedRevisionKeys = options.documentRevisionKeys
        .map((revisionKey) => this.quoteSqlString(revisionKey))
        .join(', ')
      filters.push(`document_revision_key IN (${quotedRevisionKeys})`)
    } else filters.push('1 = 0')

    return filters.join(' AND ')
  }

  /** 解析 LanceDB 搜索行，非法行丢弃。 */
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

  /** SQL 风格字符串转义，用于 LanceDB where/delete predicate。 */
  private quoteSqlString(value: string): string {
    return `'${value.replaceAll("'", "''")}'`
  }
}
