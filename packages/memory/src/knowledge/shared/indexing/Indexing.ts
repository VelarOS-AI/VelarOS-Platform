import { createHash } from 'node:crypto'

import { KnowledgeIndexStatuses } from '../../Constants'
import type {
  KnowledgeEmbeddingProviderId,
  KnowledgeIndexStatus,
} from '../../knowledge/domain/Types'

interface EmbeddingRuntimeIdentity {
  provider: KnowledgeEmbeddingProviderId
  model: string
}

interface EmbeddingProfileIdentity extends EmbeddingRuntimeIdentity {
  dimensions: number
  profileKey: string
  vectorTable: string
}

interface IndexedRecordIdentity {
  indexStatus: KnowledgeIndexStatus
  chunkCount: number
  indexTextHash: string
  archived?: boolean
}

function buildIndexTextHash(indexSource: string): string {
  return createHash('sha1').update(indexSource).digest('hex')
}

function canReuseReadyContentIndex(
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
function buildEmbeddingProfileIdentity(
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
    vectorTable: `knowledge_chunks_v2_${profileKey.slice(0, 24)}`,
  }
}

/** 同一文档的不同内容版本必须有不同的向量行身份。 */
function buildDocumentRevisionKey(documentId: string, indexTextHash: string): string {
  return `${documentId}:${indexTextHash}`
}

export {
  buildDocumentRevisionKey,
  buildEmbeddingProfileIdentity,
  buildIndexTextHash,
  canReuseReadyContentIndex,
}
export type { EmbeddingProfileIdentity, EmbeddingRuntimeIdentity, IndexedRecordIdentity }
