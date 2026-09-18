/** 检索评分：文本与向量分数归一化、新鲜度衰减、命中摘要、混合融合，以及路径/符号/来源类型的加权。 */

import { clamp, compact, first, isBlank, isEmpty, isNumber, last, truncate, unique } from '@velaros-ai/core'

import { KnowledgeIndexConfig, KnowledgeMatchTypes } from '../contract/constants.js'
import type {
  KnowledgeRecord,
  KnowledgeSearchOptions,
  KnowledgeSearchResult,
} from '../types/knowledge.js'
import type {
  HybridCandidate,
  RankedKnowledgeCandidate,
  TextSnippetSource,
} from '../types/storage.js'

import { KnowledgeTuning } from './tuning.js'

/**
 * `knowledge_search_fts` 的 bm25 列权重，按列顺序排：文档 id、路径、标题、摘要、正文、标签。
 * 这是「哪一列更能代表一次命中」这条规则本身，跟着规则留在这里，不进可调参数表。
 */
const KnowledgeTextSearchColumnWeights = [0, 5, 10, 6, 1.5, 4] as const

/** 拼出 FTS 查询里的 bm25 列权重参数。 */
export function buildTextSearchColumnWeights(): string {
  return KnowledgeTextSearchColumnWeights.join(', ')
}

/** 规范化搜索 limit，避免调用方传入过大或非法的数量。 */
export function normalizeSearchLimit(limit: Optional<number>): number {
  return clamp(
    limit ?? KnowledgeIndexConfig.DEFAULT_SEARCH_LIMIT,
    1,
    KnowledgeIndexConfig.MAX_SEARCH_LIMIT
  )
}

/** LanceDB 的 cosine distance 转成越大越相关的 0-1 分数。 */
export function normalizeVectorScore(score: number): number {
  // cosine distance 的取值范围是 0-2，除以 2 再取反就是相关度。
  return clamp(1 - score / 2, 0, 1)
}

/** 把 SQLite bm25 名次和列表位置合成文本相关性分数。 */
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

/** 半衰期时间衰减：越久远越接近 0。 */
function calculateTimeDecayScore(
  timestamp: number,
  now: number,
  halfLifeDays: number
): number {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0

  const ageMs = Math.max(0, now - timestamp)
  // 天 → 毫秒：24 小时 × 60 分 × 60 秒 × 1000 毫秒。
  const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000
  if (halfLifeMs <= 0) return 0

  return clamp(Math.exp((-Math.LN2 * ageMs) / halfLifeMs), 0, 1)
}

/** 根据访问时间和更新时间算出一份知识的新鲜度。 */
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

  // 「被用过」和「被更新过」都说明这份知识可能更贴近当前任务。
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

/** 抽取查询词；知识搜索保留 `/`，方便路径片段参与匹配。 */
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

/** 判断一个字段里是不是包含任一查询词。 */
function containsAnySearchTerm(value: string, terms: string[]): boolean {
  if (isEmpty(terms)) return false

  const normalizedValue = value.toLowerCase()
  return terms.some((term) => normalizedValue.includes(term))
}

/** 围绕第一处命中截取摘要，两侧各保留少量上下文。 */
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

/** 构造一条「最近知识」搜索结果，用在空查询上。 */
export function buildRecentKnowledgeResult(
  knowledge: KnowledgeRecord,
  now: number = Date.now()
): KnowledgeSearchResult {
  return {
    ...knowledge,
    score: calculateFreshnessScore(knowledge, now),
    matchType: KnowledgeMatchTypes.RECENT,
    snippet: isBlank(knowledge.summary)
      ? truncate(knowledge.content, KnowledgeTuning.query.recentSnippetChars)
      : knowledge.summary,
  }
}

/** 把一条向量命中的 chunk 正文截成摘要。 */
export function buildVectorMatchSnippet(content: string): string {
  return truncate(content, KnowledgeTuning.query.vectorSnippetChars)
}

/** 文本候选与向量候选融合：两边都命中的按权重合分，摘要保留文本那一条。 */
export function mergeHybridCandidates(
  textScores: Map<string, HybridCandidate>,
  vectorScores: Map<string, HybridCandidate>
): Map<string, HybridCandidate> {
  const merged = new Map(textScores)

  for (const [id, vectorCandidate] of vectorScores) {
    const textCandidate = merged.get(id)
    if (!textCandidate) {
      merged.set(id, vectorCandidate)
      continue
    }

    merged.set(id, {
      id,
      score:
        vectorCandidate.score * KnowledgeIndexConfig.VECTOR_WEIGHT +
        textCandidate.score * KnowledgeIndexConfig.TEXT_WEIGHT,
      snippet: textCandidate.snippet,
      matchType: KnowledgeMatchTypes.HYBRID,
    })
  }

  return merged
}

/** 把召回候选按文档 id 融合成一张表，顺带把命中类型收回知识库自己的取值。 */
export function mergeRankedCandidates(
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

/** 按路径提示给更相关的文件轻微加权。 */
export function applyPathHintBoost(
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
      boost = Math.max(boost, KnowledgeTuning.query.exactHintBoost)
      continue
    }

    if (
      normalizedPath.includes(normalizedHint) ||
      normalizedPath.includes(last(normalizedHint.split('/')) ?? normalizedHint)
    ) {
      // 模糊路径或文件名命中给较小加权。
      boost = Math.max(boost, KnowledgeTuning.query.fuzzyHintBoost)
    }
  }

  return clamp((score + boost), 0, 1)
}

/** 按符号提示给代码文档加权。 */
export function applySymbolHintBoost(
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
      // tags 里存着 kind:name / export:name 这类结构化符号标签，精确命中更可信。
      boost = Math.max(boost, KnowledgeTuning.query.exactHintBoost)
      continue
    }

    if (normalizedTags.some((tag) => tag.includes(normalizedHint))) {
      boost = Math.max(boost, KnowledgeTuning.query.fuzzyHintBoost)
    }
  }

  return clamp((score + boost), 0, 1)
}

/** 用户显式要了某类来源时，给匹配的文档一个很小的稳定加权。 */
export function applySourceKindBoost(
  score: number,
  knowledge: KnowledgeRecord,
  requestedSourceKinds: KnowledgeSearchOptions['sourceKinds']
): number {
  if (!requestedSourceKinds?.length) return score

  return requestedSourceKinds.includes(knowledge.sourceKind)
    ? clamp((score + KnowledgeTuning.query.sourceKindBoost), 0, 1)
    : score
}

/** 把一批候选补齐成完整结果，取不到文档的候选丢掉。 */
export function attachKnowledgeDocuments(
  candidates: readonly RankedKnowledgeCandidate[],
  documentMap: Map<string, KnowledgeRecord>
): KnowledgeSearchResult[] {
  return compact(candidates.map((candidate) => {
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
