

/** 模块稳定身份。 */
export const EvidenceModuleId = 'velaros:evidence' as const;

/** 模块稳定身份。 */
export const SearchModuleId = 'velaros:search' as const;

/** 搜索与证据读取对外约定的上限；都写在 velaros:search、velaros:evidence 的声明里。 */
export const SearchLimits = Object.freeze({
  /** 一次搜索的 query 最多多少字符。 */
  queryChars: 16_000,
  /** 给搜索模型的背景说明最多多少字符。 */
  contextChars: 24_000,
  /** 一次搜索最多限定多少个来源。 */
  sources: 64,
  /** 一次搜索最多带多少个已知资源。 */
  anchors: 32,
  /** 刷新证据时一页最多多少条。 */
  refreshItems: 16,
  /** 证据检索的 query 最多多少字符。 */
  evidenceQueryChars: 8_000,
  /** 一次证据检索最多多少个候选。 */
  candidates: 100,
  /** 一次证据读取最多多少字节。 */
  readBytes: 60_000,
  /** 不给 limit 时一次证据检索的候选数。 */
  defaultCandidates: 16,
  /** 不给 maxBytes 时一次证据读取的字节数。 */
  defaultReadBytes: 8_000,
  /** 一份搜索报告的 JSON 最多多少字符。 */
  reportChars: 24_000,
})
