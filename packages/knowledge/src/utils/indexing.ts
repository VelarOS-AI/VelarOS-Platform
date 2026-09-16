/** 索引身份：内容 hash、嵌入 profile 身份、文档内容版本键，以及「已有索引还能不能复用」的判定。 */

import { createHash } from 'node:crypto'

import { KnowledgeIndexStatuses } from '../contract/constants.js'
import type {
  EmbeddingProfileIdentity,
  EmbeddingRuntimeIdentity,
  IndexedRecordIdentity,
} from '../types/storage.js'

/** 把参与索引的文本算成一个稳定 hash，内容或分块策略变了它就变。 */
export function buildIndexTextHash(indexSource: string): string {
  return createHash('sha1').update(indexSource).digest('hex')
}

/** 已有的 ready 索引还能不能直接复用：内容没变、分块还在，才算能用。 */
export function canReuseReadyContentIndex(
  existing: IndexedRecordIdentity,
  indexTextHash: string,
  options: { rejectArchived?: boolean } = {}
): boolean {
  return (
    existing.indexStatus === KnowledgeIndexStatuses.READY &&
    (!options.rejectArchived || !existing.archived) &&
    existing.chunkCount > 0 &&
    existing.indexTextHash === indexTextHash
  )
}

/** provider/model/dimensions 共同定义一个不可混算的向量空间。 */
export function buildEmbeddingProfileIdentity(
  runtime: EmbeddingRuntimeIdentity,
  dimensions: number
): EmbeddingProfileIdentity {
  const normalizedProvider = runtime.provider.trim()
  const normalizedModel = runtime.model.trim()
  const profileKey = createHash('sha256')
    .update(JSON.stringify([normalizedProvider, normalizedModel, dimensions]))
    .digest('hex')

  return {
    provider: runtime.provider,
    model: normalizedModel,
    dimensions,
    profileKey,
    // 表名取 profileKey 的前 24 位：够长到不会撞，短到还能读。
    vectorTable: `knowledge_chunks_v2_${profileKey.slice(0, 24)}`,
  }
}

/** 同一文档的不同内容版本必须有不同的向量行身份。 */
export function buildDocumentRevisionKey(documentId: string, indexTextHash: string): string {
  return `${documentId}:${indexTextHash}`
}

/** 用 trim 之后的正文算 hash，结尾空白变化不算内容变化。 */
export function buildNormalizedContentHash(content: string): string {
  return createHash('sha1').update(content.trim()).digest('hex')
}

/** 用工作区根和相对路径算出一份知识文档的稳定 id。 */
export function buildKnowledgeDocumentId(workspaceRoot: string, path: string): string {
  return createHash('sha1').update(`${workspaceRoot}::${path}`).digest('hex')
}
