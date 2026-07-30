import { clamp, first, isBlank, isEmpty, isNumber, truncate, unique } from '@velaros-ai/core'

import { KnowledgeIndexConfig, KnowledgeMatchTypes } from '../../Constants'

import type { KnowledgeRecord, KnowledgeSearchResult } from './Types'
/** 构建文本命中摘要需要的字段集合。 */
interface TextSnippetSource {
  title: string
  summary: string
  content: string
  path: string
  tags: string
}

/** 搜索召回阶段产生的统一候选。 */
export interface RankedKnowledgeCandidate {
  documentId: string
  score: number
  snippet: string
  matchType: KnowledgeSearchResult['matchType']
}

/** 规范化搜索 limit，避免调用方传入过大或非法数量。 */
export function normalizeSearchLimit(limit: number | undefined): number {
  return clamp(
    limit ?? KnowledgeIndexConfig.DEFAULT_SEARCH_LIMIT,
    1,
    KnowledgeIndexConfig.MAX_SEARCH_LIMIT
  )
}

/** LanceDB cosine distance 转成越大越相关的 0-1 分数。 */
export function normalizeVectorScore(score: number): number {
  return clamp(1 - score / 2, 0, 1)
}

/** 将 SQLite bm25 rank 和列表位置合成文本相关性分数。 */
export function normalizeTextScore(
  rank: number,
  bestRank: number,
  worstRank: number,
  position: number,
  total: number
): number {
  const safeBestRank = Number.isFinite(bestRank) ? bestRank : rank
  const safeWorstRank = Number.isFinite(worstRank) ? worstRank : rank
  const safeRank = Number.isFinite(rank) ? rank : safeWorstRank
  // FTS bm25 rank 越小代表越相关，这里反向归一化。
  const bm25Score =
    safeBestRank === safeWorstRank
      ? 1
      : clamp(1 - (safeRank - safeBestRank) / (safeWorstRank - safeBestRank), 0, 1)
  const positionScore = total <= 1 ? 1 : clamp(1 - position / (total - 1), 0, 1)

  return clamp(
    bm25Score * KnowledgeIndexConfig.TEXT_SCORE_BM25_WEIGHT +
      positionScore * KnowledgeIndexConfig.TEXT_SCORE_POSITION_WEIGHT,
    0,
    1
  )
}

/** 根据访问时间和更新时间计算新鲜度。 */
export function calculateFreshnessScore(
  knowledge: Pick<KnowledgeRecord, 'lastAccessedAt' | 'updatedAt'>,
  now: number
): number {
  const accessScore = calculateTimeDecayScore(
    knowledge.lastAccessedAt,
    now,
    KnowledgeIndexConfig.FRESHNESS_ACCESS_HALF_LIFE_DAYS
  )
  const updateScore = calculateTimeDecayScore(
    knowledge.updatedAt,
    now,
    KnowledgeIndexConfig.FRESHNESS_UPDATE_HALF_LIFE_DAYS
  )

  // “被用过”和“被更新过”都说明文档可能更贴近当前任务。
  return clamp(
    accessScore * KnowledgeIndexConfig.FRESHNESS_ACCESS_WEIGHT +
      updateScore * KnowledgeIndexConfig.FRESHNESS_UPDATE_WEIGHT,
    0,
    1
  )
}

/** 用新鲜度对相关性做温和折扣，避免久远知识长期霸榜。 */
export function applyFreshnessScore(score: number, freshnessScore: number): number {
  const multiplier =
    KnowledgeIndexConfig.FRESHNESS_MIN_SCORE_MULTIPLIER +
    (1 - KnowledgeIndexConfig.FRESHNESS_MIN_SCORE_MULTIPLIER) *
      clamp(freshnessScore, 0, 1)

  return clamp(score * multiplier, 0, 1)
}

/** 生成文本命中的摘要，优先围绕命中词截取。 */
export function buildTextMatchSnippet(query: string, source: TextSnippetSource): string {
  const terms = extractSearchTerms(query)
  const fields = [
    source.title.trim(),
    source.summary.trim(),
    source.content.trim(),
    source.path.trim(),
    source.tags.trim(),
  ].filter((value) => !isBlank(value))

  const matchedField = fields.find((value) => containsAnySearchTerm(value, terms))
  const fallbackField = [
    source.summary.trim(),
    source.content.trim(),
    source.path.trim(),
    source.title.trim(),
    source.tags.trim(),
  ].find((value) => !isBlank(value))

  if (!matchedField && !fallbackField) return isBlank(source.summary)
      ? truncate(source.content, KnowledgeIndexConfig.TEXT_SNIPPET_LENGTH)
      : source.summary

  return trimSnippetAroundMatch(matchedField ?? fallbackField ?? '', terms)
}

/** 构造最近文档搜索结果。 */
export function buildRecentKnowledgeResult(
  knowledge: KnowledgeRecord,
  now: number = Date.now()
): KnowledgeSearchResult {
  return {
    ...knowledge,
    score: calculateFreshnessScore(knowledge, now),
    matchType: KnowledgeMatchTypes.RECENT,
    snippet: isBlank(knowledge.summary) ? truncate(knowledge.content, 160) : knowledge.summary,
  }
}

/** 抽取查询词；知识搜索保留 /，方便路径片段参与匹配。 */
function extractSearchTerms(query: string): string[] {
  return unique(
    query
      .replace(/[^\p{L}\p{N}\s/_-]/gu, ' ')
      .trim()
      .split(/\s+/)
      .map((term) => term.trim().toLowerCase())
      .filter((term) => !isBlank(term))
  )
}

/** 判断字段是否包含任一查询词。 */
function containsAnySearchTerm(value: string, terms: string[]): boolean {
  if (isEmpty(terms)) return false

  const normalizedValue = value.toLowerCase()
  return terms.some((term) => normalizedValue.includes(term))
}

/** 围绕第一处命中截取摘要，保留少量上下文。 */
function trimSnippetAroundMatch(value: string, terms: string[]): string {
  if (value.length <= KnowledgeIndexConfig.TEXT_SNIPPET_LENGTH) return value

  const normalizedValue = value.toLowerCase()
  const firstMatchIndex = first(
    terms
      .map((term) => normalizedValue.indexOf(term))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)
  )

  if (!isNumber(firstMatchIndex)) return truncate(value, KnowledgeIndexConfig.TEXT_SNIPPET_LENGTH)

  // 起点向前挪一点，结果里能看到命中词前后的语义。
  const start = Math.max(
    0,
    firstMatchIndex - KnowledgeIndexConfig.TEXT_SNIPPET_CONTEXT_CHARS
  )
  const end = Math.min(value.length, start + KnowledgeIndexConfig.TEXT_SNIPPET_LENGTH)
  const slice = value.slice(start, end).trim()

  return [start > 0 ? '…' : '', slice, end < value.length ? '…' : ''].join('')
}

/** 半衰期时间衰减函数。 */
function calculateTimeDecayScore(
  timestamp: number,
  now: number,
  halfLifeDays: number
): number {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0

  const ageMs = Math.max(0, now - timestamp)
  const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000
  if (halfLifeMs <= 0) return 0

  return clamp(Math.exp((-Math.LN2 * ageMs) / halfLifeMs), 0, 1)
}

/**
 * 知识查询辅助方法兼容门面。
 *
 * @deprecated 内部实现已改为无状态纯函数；新代码不需要创建 helper 实例。
 */
export class KnowledgeQueryHelper {
  public normalizeSearchLimit(limit: number | undefined): number {
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
