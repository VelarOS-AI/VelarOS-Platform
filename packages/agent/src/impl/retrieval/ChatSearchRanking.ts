// 会话搜索打分：把一句查询折成词条，再给每段文本打分并裁出片段。
import type { ChatContextRetrievalScoreStats } from '../../types/agent'
import type { RankingSignals } from '../../types/retrieval'
import { buildHeadTailSnippet, buildRetrievalScoreStats, buildSearchSnippet, normalizeQuerySignature, normalizeSearchTerms, rankContextText } from '../../utils/retrieval/ranking'

/**
 * 会话搜索的打分面：召回服务与产品的本地搜索共用同一套词条切分、打分与片段裁剪，
 * 两边出的排序必须一致，所以只有这一份实现。无状态，进程内共用一份。
 */
export interface ChatSearchRankingApi {
  /** 把一句查询切成检索词条。 */
  normalizeSearchTerms(query: string): string[]
  /** 算一次查询的签名，用来判断两次搜索是不是同一个问题。 */
  normalizeQuerySignature(query: string, terms: string[]): string
  /** 给一段文本按查询打分。 */
  rankContextText(input: {
    query: string;
    terms: string[];
    text: string;
    index?: number;
    total?: number;
  }): RankingSignals
  /** 按命中位置裁出展示片段；没命中返回 null。 */
  buildSearchSnippet(text: string, terms: string[], maxChars: number): LooseOptional<string>
  /** 没有命中位置时按首尾裁出片段。 */
  buildHeadTailSnippet(text: string, maxChars: number): LooseOptional<string>
  /** 汇总一次召回的分数分布，用于诊断。 */
  buildRetrievalScoreStats(scores: number[]): ChatContextRetrievalScoreStats
}

/** 方法逐个转调 utils/retrieval/ranking 里的纯函数；这里只负责把它们收成一件对外能力。 */
class ChatSearchRanking implements ChatSearchRankingApi {
  public normalizeSearchTerms(query: string): string[] {
    return normalizeSearchTerms(query)
  }

  public normalizeQuerySignature(query: string, terms: string[]): string {
    return normalizeQuerySignature(query, terms)
  }

  public rankContextText(input: {
    query: string;
    terms: string[];
    text: string;
    index?: number;
    total?: number;
  }): RankingSignals {
    return rankContextText(input)
  }

  public buildSearchSnippet(text: string, terms: string[], maxChars: number): LooseOptional<string> {
    return buildSearchSnippet(text, terms, maxChars)
  }

  public buildHeadTailSnippet(text: string, maxChars: number): LooseOptional<string> {
    return buildHeadTailSnippet(text, maxChars)
  }

  public buildRetrievalScoreStats(scores: number[]): ChatContextRetrievalScoreStats {
    return buildRetrievalScoreStats(scores)
  }
}

/** 会话搜索打分面（无状态，进程内共用一份）。 */
export const chatSearchRanking: ChatSearchRankingApi = new ChatSearchRanking()
