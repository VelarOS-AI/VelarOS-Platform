import { clamp,compact, first, isBlank, isEmpty, last, truncate } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import { KnowledgeIndexConfig, KnowledgeMatchTypes } from '../../Constants'
import type { Embeddings } from '../../embedding'
import {
  type HybridCandidate,
  mergeHybridCandidates,
} from '../../shared'
import { VectorFailureMonitor } from '../../VectorFailureLog'
import type { KnowledgeRepo } from '../storage'
import type { KnowledgeVectors } from '../storage'

import {
  applyFreshnessScore,
  buildRecentKnowledgeResult,
  buildTextMatchSnippet,
  calculateFreshnessScore,
  normalizeSearchLimit,
  normalizeTextScore,
  normalizeVectorScore,
  type RankedKnowledgeCandidate,
} from './QueryHelper'
import type { KnowledgeRecord, KnowledgeSearchOptions, KnowledgeSearchResult } from './Types'

const log = logRuntime.tag('KnowledgeQuery')
const KnowledgeAccessTouchThrottleMs = 60_000

/**
 * 知识查询服务。
 *
 * 搜索时同时跑 SQLite FTS 文本召回和 LanceDB 向量召回，再按权重、时间新鲜度和 path/symbol hint 重新排序。
 */
export class KnowledgeQuery {
  private readonly lastTouchedAtByKnowledgeId = new Map<string, number>()

  constructor(
    private readonly repository: KnowledgeRepo,
    private readonly embeddingService: Embeddings,
    private readonly vectorStore: KnowledgeVectors,
    private readonly vectorFailures = new VectorFailureMonitor()
  ) {}

  /** 搜索知识文档。 */
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
      // 空查询退化为最近/最新知识列表，并按访问时间更新结果权重。
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

    // 文本召回先从 SQLite FTS 获取候选，limit 放大后再统一重排。
    const textMatches = this.repository.searchText(
      query,
      options,
      limit * KnowledgeIndexConfig.TEXT_CANDIDATE_MULTIPLIER
    )
    const textScores = new Map<string, RankedKnowledgeCandidate>()
    const bestTextRank = first(textMatches)?.rank ?? 0
    const worstTextRank = last(textMatches)?.rank ?? bestTextRank

    textMatches.forEach((match, index) => {
      // bm25 rank 越小越好；helper 会归一化成越大越好的 score。
      const score = normalizeTextScore(
        match.rank,
        bestTextRank,
        worstTextRank,
        index,
        textMatches.length
      )
      const existing = textScores.get(match.document_id)
      if (existing && existing.score >= score) return

      // 同一文档可能多个字段命中，只保留分数最高的一条候选。
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
      // 先按当前 provider/model 与当前内容版本选分区；其它 profile 在向量通道中不可见。
      const partitions = this.repository.listVectorSearchPartitions(
        options.workspaceRoot,
        embeddingRuntime,
        options,
        KnowledgeIndexConfig.VECTOR_FILTER_MEMORY_ID_LIMIT
      )

      if (!isEmpty(partitions)) {
        // 只有存在候选文档时才生成 query embedding，减少无意义的网络调用。
        const queryVector = await this.embeddingService.embedText(query)
        // dimensions 也是 profile 身份的一部分；不兼容分区不做转换或跨空间混排。
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
          // 向量命中以 chunk 内容作为摘要，后续如果同时文本命中会优先保留文本摘要。
          vectorScores.set(candidate.documentId, {
            documentId: candidate.documentId,
            score,
            snippet: truncate(candidate.content, 180),
            matchType: KnowledgeMatchTypes.VECTOR,
          })
        }
      }
    } catch (error) {
      // arch-guard:silent-catch-ok 向量失败由运行时故障监视器去重记录，并降级文本召回。
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

  /** 合并文本/向量候选，并补齐完整文档记录。 */
  private buildResults(
    limit: number,
    options: KnowledgeSearchOptions,
    textScores: Map<string, RankedKnowledgeCandidate>,
    vectorScores: Map<string, RankedKnowledgeCandidate>,
    now: number
  ): KnowledgeSearchResult[] {
    const merged = this.mergeCandidates(textScores, vectorScores)

    const mergedCandidates = [...merged.values()]
    if (isEmpty(mergedCandidates)) return []

    const knowledgeIds = mergedCandidates.map((candidate) => candidate.documentId)
    const documents = this.repository.findKnowledgeByIds(knowledgeIds)
    const documentMap = new Map(documents.map((document) => [document.id, document]))
    const rankedCandidates = compact(mergedCandidates
      .map((candidate) => {
        const document = documentMap.get(candidate.documentId)
        if (!document) return null

        // 基础相关性再经过新鲜度、来源类型、符号和路径 hint 加权。
        return {
          ...candidate,
          score: this.applyPathHintBoost(
            this.applySymbolHintBoost(
              this.applySourceKindBoost(
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

    // 搜到的文档更新 last_accessed_at，后续空查询/新鲜度排序会受影响。
    this.touchKnowledge(
      rankedCandidates.map((candidate) => candidate.documentId),
      now
    )

    return compact(rankedCandidates
      .map((candidate) => {
        const document = documentMap.get(candidate.documentId)
        if (!document) return null

        return {
          ...document,
          score: candidate.score,
          matchType: candidate.matchType,
          snippet: candidate.snippet,
        }
      }))
  }

  private mergeCandidates(
    textScores: Map<string, RankedKnowledgeCandidate>,
    vectorScores: Map<string, RankedKnowledgeCandidate>
  ): Map<string, RankedKnowledgeCandidate> {
    const toHybridCandidate = (
      documentId: string,
      candidate: RankedKnowledgeCandidate
    ): HybridCandidate => ({
      id: documentId,
      score: candidate.score,
      snippet: candidate.snippet,
      matchType: candidate.matchType,
    })
    const merged = mergeHybridCandidates(
      new Map([...textScores].map(([documentId, candidate]) => [documentId, toHybridCandidate(documentId, candidate)])),
      new Map([...vectorScores].map(([documentId, candidate]) => [documentId, toHybridCandidate(documentId, candidate)]))
    )

    return new Map(
      [...merged].map(([documentId, candidate]) => [
        documentId,
        {
          documentId,
          score: candidate.score,
          snippet: candidate.snippet,
          matchType: candidate.matchType as RankedKnowledgeCandidate['matchType'],
        },
      ])
    )
  }

  private touchKnowledge(documentIds: string[], now: number): void {
    const touchableIds = documentIds.filter((id) => {
      const lastTouchedAt = this.lastTouchedAtByKnowledgeId.get(id) ?? 0
      return now - lastTouchedAt >= KnowledgeAccessTouchThrottleMs
    })
    if (isEmpty(touchableIds)) return

    this.repository.touchKnowledge(touchableIds, now)
    touchableIds.forEach((id) => this.lastTouchedAtByKnowledgeId.set(id, now))
  }

  /** 根据路径提示给更相关的文件轻微加权。 */
  private applyPathHintBoost(
    score: number,
    knowledge: KnowledgeRecord,
    pathHints: string[]
  ): number {
    if (isEmpty(pathHints)) return score

    const normalizedPath = knowledge.path.toLowerCase()
    let boost = 0

    for (const hint of pathHints) {
      const normalizedHint = hint
        .trim()
        .toLowerCase()
        .replace(/^\.?\//, '')
      if (isBlank(normalizedHint)) continue

      if (normalizedPath === normalizedHint) {
        // 精确路径命中权重最高。
        boost = Math.max(boost, 0.18)
        continue
      }

      if (
        normalizedPath.includes(normalizedHint) ||
        normalizedPath.includes(last(normalizedHint.split('/')) ?? normalizedHint)
      ) {
        // 模糊路径或文件名命中给较小加权。
        boost = Math.max(boost, 0.08)
      }
    }

    return clamp((score + boost), 0, 1)
  }

  /** 根据符号提示给代码文档加权。 */
  private applySymbolHintBoost(
    score: number,
    knowledge: KnowledgeRecord,
    symbolHints: string[]
  ): number {
    if (knowledge.sourceKind !== 'code' || isEmpty(symbolHints)) return score

    const normalizedTags = knowledge.tags.map((tag) => tag.toLowerCase())
    let boost = 0

    for (const hint of symbolHints) {
      const normalizedHint = hint.trim().toLowerCase()
      if (isBlank(normalizedHint)) continue

      if (
        normalizedTags.some((tag) => tag === normalizedHint || tag.endsWith(`:${normalizedHint}`))
      ) {
        // tags 中包含 kind:name/export:name 等结构化符号标签，精确命中更可信。
        boost = Math.max(boost, 0.18)
        continue
      }

      if (normalizedTags.some((tag) => tag.includes(normalizedHint))) {
        boost = Math.max(boost, 0.08)
      }
    }

    return clamp((score + boost), 0, 1)
  }

  /** 用户显式要求某类 sourceKind 时给匹配文档一个很小的稳定加权。 */
  private applySourceKindBoost(
    score: number,
    knowledge: KnowledgeRecord,
    requestedSourceKinds: KnowledgeSearchOptions['sourceKinds']
  ): number {
    if (!requestedSourceKinds?.length) return score

    return requestedSourceKinds.includes(knowledge.sourceKind) ? clamp((score + 0.02), 0, 1) : score
  }
}
