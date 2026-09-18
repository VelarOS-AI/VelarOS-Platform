import { compact, first, isBlank, isEmpty, last, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { KnowledgeIndexConfig, KnowledgeMatchTypes } from '../../contract/constants.js'
import type {
  KnowledgeSearchOptions,
  KnowledgeSearchResult,
} from '../../types/knowledge.js'
import type { RankedKnowledgeCandidate } from '../../types/storage.js'
import {
  applyFreshnessScore,
  applyPathHintBoost,
  applySourceKindBoost,
  applySymbolHintBoost,
  attachKnowledgeDocuments,
  buildRecentKnowledgeResult,
  buildTextMatchSnippet,
  buildVectorMatchSnippet,
  calculateFreshnessScore,
  mergeRankedCandidates,
  normalizeSearchLimit,
  normalizeTextScore,
  normalizeVectorScore,
} from '../../utils/query.js'
import { KnowledgeTuning } from '../../utils/tuning.js'
import type { KnowledgeEmbeddingsApi } from '../storage/KnowledgeEmbeddings.js'
import type { KnowledgeRepositoryApi } from '../storage/KnowledgeRepository.js'
import type { KnowledgeVectorsApi } from '../storage/KnowledgeVectors.js'
import type { VectorFailureMonitorApi } from '../storage/VectorFailureMonitor.js'
import { VectorFailureMonitor } from '../storage/VectorFailureMonitor.js'

const log = Log.tag('KnowledgeQuery')

/**
 * 知识查询服务：文本召回与向量召回并行，再按权重、新鲜度与路径/符号提示重排。
 *
 * 它是纯读路径——不同步、不建索引、不重建索引；实例由知识库运行时持有，访问节流表在实例上。
 */
export interface KnowledgeQueryApi {
  /** 搜索知识文档；空查询退化成按新鲜度排的最近列表。 */
  searchKnowledge(
    query: string,
    options: KnowledgeSearchOptions
  ): Promise<KnowledgeSearchResult[]>
}

/** 见 {@link KnowledgeQueryApi}。 */
export class KnowledgeQuery implements KnowledgeQueryApi {
  private readonly lastTouchedAtByKnowledgeId = new Map<string, number>()

  constructor(
    private readonly repository: KnowledgeRepositoryApi,
    private readonly embeddingService: KnowledgeEmbeddingsApi,
    private readonly vectorStore: KnowledgeVectorsApi,
    private readonly vectorFailures: VectorFailureMonitorApi = new VectorFailureMonitor()
  ) {}

  public async searchKnowledge(
    query: string,
    options: KnowledgeSearchOptions
  ): Promise<KnowledgeSearchResult[]> {
    if (isBlank(options.workspaceRoot)) {
      throw new AppError('VALIDATION', '搜索知识文档时必须提供 workspaceRoot')
    }

    const limit = normalizeSearchLimit(options.limit)
    const now = Date.now()

    if (isBlank(query)) {
      // 空查询退化为最近/最新知识列表，并按访问时间给结果权重。
      return this.repository
        .listKnowledgeByWorkspaceRoot(options.workspaceRoot, options.sourceKinds)
        .filter(
          (knowledge) =>
            !options.documentIds ||
            isEmpty(options.documentIds) ||
            options.documentIds.includes(knowledge.id)
        )
        .slice(0, limit)
        .map((knowledge) => buildRecentKnowledgeResult(knowledge, now))
    }

    // 文本召回先从 SQLite FTS 取候选，limit 放大后再统一重排。
    const textMatches = this.repository.searchText(
      query,
      options,
      limit * KnowledgeIndexConfig.TEXT_CANDIDATE_MULTIPLIER
    )
    const textScores = new Map<string, RankedKnowledgeCandidate>()
    const bestTextRank = first(textMatches)?.rank ?? 0
    const worstTextRank = last(textMatches)?.rank ?? bestTextRank

    textMatches.forEach((match, index) => {
      // bm25 rank 越小越好；工具函数会归一化成越大越好的分数。
      const score = normalizeTextScore(
        match.rank,
        bestTextRank,
        worstTextRank,
        index,
        textMatches.length
      )
      const existing = textScores.get(match.document_id)
      if (existing && existing.score >= score) return

      // 同一份文档可能多个字段命中，只保留分数最高的一条候选。
      textScores.set(match.document_id, {
        documentId: match.document_id,
        score,
        snippet: buildTextMatchSnippet(query, {
          title: match.title,
          summary: match.summary,
          content: match.content,
          path: match.path,
          tags: match.tags,
        }),
        matchType: KnowledgeMatchTypes.TEXT,
      })
    })

    let vectorScores = new Map<string, RankedKnowledgeCandidate>()

    try {
      const embeddingRuntime = this.embeddingService.getRuntimeSelection()
      // 先按当前 provider/model 与当前内容版本选分区；别的 profile 在向量通道里不可见。
      const partitions = this.repository.listVectorSearchPartitions(
        options.workspaceRoot,
        embeddingRuntime,
        options,
        KnowledgeIndexConfig.VECTOR_FILTER_MEMORY_ID_LIMIT
      )

      if (!isEmpty(partitions)) {
        // 只有存在候选文档时才生成查询向量，减少无意义的网络调用。
        const queryVector = await this.embeddingService.embedText(query)
        // dimensions 也是 profile 身份的一部分；不兼容的分区不做转换、也不跨空间混排。
        const activePartitions = partitions.filter(
          (partition) => partition.embeddingDimensions === queryVector.length
        )
        const candidates = (
          await Promise.all(
            activePartitions.map((partition) =>
              this.vectorStore.searchSimilarChunks(queryVector, {
                workspaceRoot: options.workspaceRoot,
                vectorTable: partition.vectorTable,
                documentRevisionKeys: partition.documentRevisionKeys,
                limit: limit * KnowledgeIndexConfig.VECTOR_CANDIDATE_MULTIPLIER,
              })
            )
          )
        ).flat()

        for (const candidate of candidates) {
          const score = normalizeVectorScore(candidate.distance)
          const existing = vectorScores.get(candidate.documentId)

          if (existing && existing.score >= score) continue
          // 向量命中拿 chunk 正文当摘要，同时文本命中时会优先保留文本摘要。
          vectorScores.set(candidate.documentId, {
            documentId: candidate.documentId,
            score,
            snippet: buildVectorMatchSnippet(candidate.content),
            matchType: KnowledgeMatchTypes.VECTOR,
          })
        }
      }
    } catch (error) {
      // arch-guard:silent-catch-ok 向量失败由运行时故障监视器去重记录，并降级为文本召回。
      // 向量链路失败不影响知识搜索整体可用性，退回纯文本召回。
      this.vectorFailures.warnOnce(
        log,
        'knowledge-query',
        'knowledge vector search fallback to text',
        error
      )
      vectorScores = new Map()
    }

    return this.buildResults(limit, options, textScores, vectorScores, now)
  }

  /** 合并文本与向量候选，补齐完整文档记录，并按最终分数截断。 */
  private buildResults(
    limit: number,
    options: KnowledgeSearchOptions,
    textScores: Map<string, RankedKnowledgeCandidate>,
    vectorScores: Map<string, RankedKnowledgeCandidate>,
    now: number
  ): KnowledgeSearchResult[] {
    const merged = mergeRankedCandidates(textScores, vectorScores)

    const mergedCandidates = [...merged.values()]
    if (isEmpty(mergedCandidates)) return []

    const knowledgeIds = mergedCandidates.map((candidate) => candidate.documentId)
    const documents = this.repository.findKnowledgeByIds(knowledgeIds)
    const documentMap = new Map(documents.map((document) => [document.id, document]))
    const rankedCandidates = compact(mergedCandidates
      .map((candidate) => {
        const document = documentMap.get(candidate.documentId)
        if (!document) return null

        // 基础相关性再经过新鲜度、来源类型、符号与路径提示加权。
        return {
          ...candidate,
          score: applyPathHintBoost(
            applySymbolHintBoost(
              applySourceKindBoost(
                applyFreshnessScore(
                  candidate.score,
                  calculateFreshnessScore(document, now)
                ),
                document,
                options.sourceKinds ?? []
              ),
              document,
              options.symbolHints ?? []
            ),
            document,
            options.pathHints ?? []
          ),
        }
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)

    if (isEmpty(rankedCandidates)) return []

    // 搜到的文档更新 last_accessed_at，后续空查询与新鲜度排序会受影响。
    this.touchKnowledge(
      rankedCandidates.map((candidate) => candidate.documentId),
      now
    )

    return attachKnowledgeDocuments(rankedCandidates, documentMap)
  }

  /** 按节流表更新一批文档的访问时间，避免每次检索都写库。 */
  private touchKnowledge(documentIds: string[], now: number): void {
    const touchableIds = documentIds.filter((id) => {
      const lastTouchedAt = this.lastTouchedAtByKnowledgeId.get(id) ?? 0
      return now - lastTouchedAt >= KnowledgeTuning.query.accessTouchThrottleMs
    })
    if (isEmpty(touchableIds)) return

    this.repository.touchKnowledge(touchableIds, now)
    touchableIds.forEach((id) => this.lastTouchedAtByKnowledgeId.set(id, now))
  }
}
