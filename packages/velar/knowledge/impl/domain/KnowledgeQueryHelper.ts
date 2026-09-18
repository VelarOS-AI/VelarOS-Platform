import type { KnowledgeRecord, KnowledgeSearchResult } from '../../types/knowledge.js'
import type { TextSnippetSource } from '../../types/storage.js'
import {
  applyFreshnessScore,
  buildRecentKnowledgeResult,
  buildTextMatchSnippet,
  calculateFreshnessScore,
  normalizeSearchLimit,
  normalizeTextScore,
  normalizeVectorScore,
} from '../../utils/query.js'

/**
 * 知识检索评分的兼容门面。
 *
 * 内部实现已经是 `utils/query.ts` 里的无状态纯函数；这层只为已经接线的宿主保留一个实例形态的入口，
 * 新代码直接用那些函数，不需要创建实例。
 */
export interface KnowledgeQueryHelperApi {
  /** 规范化搜索 limit。 */
  normalizeSearchLimit(limit: Optional<number>): number
  /** 把向量距离转成越大越相关的分数。 */
  normalizeVectorScore(score: number): number
  /** 把 bm25 名次与列表位置合成文本相关性分数。 */
  normalizeTextScore(
    rank: number,
    bestRank: number,
    worstRank: number,
    position: number,
    total: number
  ): number
  /** 算一份知识的新鲜度。 */
  calculateFreshnessScore(
    knowledge: Pick<KnowledgeRecord, 'lastAccessedAt' | 'updatedAt'>,
    now: number
  ): number
  /** 用新鲜度对相关性做温和折扣。 */
  applyFreshnessScore(score: number, freshnessScore: number): number
  /** 生成文本命中的摘要。 */
  buildTextMatchSnippet(query: string, source: TextSnippetSource): string
  /** 构造一条「最近知识」搜索结果。 */
  buildRecentKnowledgeResult(knowledge: KnowledgeRecord, now?: number): KnowledgeSearchResult
}

/** 见 {@link KnowledgeQueryHelperApi}。 */
export class KnowledgeQueryHelper implements KnowledgeQueryHelperApi {
  public normalizeSearchLimit(limit: Optional<number>): number {
    return normalizeSearchLimit(limit)
  }

  public normalizeVectorScore(score: number): number {
    return normalizeVectorScore(score)
  }

  public normalizeTextScore(
    rank: number,
    bestRank: number,
    worstRank: number,
    position: number,
    total: number
  ): number {
    return normalizeTextScore(rank, bestRank, worstRank, position, total)
  }

  public calculateFreshnessScore(
    knowledge: Pick<KnowledgeRecord, 'lastAccessedAt' | 'updatedAt'>,
    now: number
  ): number {
    return calculateFreshnessScore(knowledge, now)
  }

  public applyFreshnessScore(score: number, freshnessScore: number): number {
    return applyFreshnessScore(score, freshnessScore)
  }

  public buildTextMatchSnippet(query: string, source: TextSnippetSource): string {
    return buildTextMatchSnippet(query, source)
  }

  public buildRecentKnowledgeResult(
    knowledge: KnowledgeRecord,
    now: number = Date.now()
  ): KnowledgeSearchResult {
    return buildRecentKnowledgeResult(knowledge, now)
  }
}
