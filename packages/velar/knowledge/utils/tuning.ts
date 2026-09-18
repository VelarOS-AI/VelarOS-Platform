/**
 * 包内可调参数：超时、缓冲、保留条数、缺省条数、阈值集中在这一张表里，只放数字，每项写清楚它管什么。
 *
 * 对外承诺的上限不在这里，在 `contract/constants.ts`；规则本身的名单跟着规则留在各自的 utils 文件里。
 */
export const KnowledgeTuning = Object.freeze({
  /** 工作区同步的节流。 */
  workspace: Object.freeze({
    /** 同一个工作区两次同步之间的最短间隔（毫秒），避免每次搜索都全量扫盘。 */
    syncTtlMs: 30_000,
  }),
  /** 摄入一份文件时的取舍。 */
  documents: Object.freeze({
    /** 普通文档最多读多少字节，超过就不入库。 */
    maxDocumentBytes: 256 * 1024,
    /** 代码候选最多读多少字节，代码检索走轻量候选策略。 */
    maxCodeFileBytes: 96 * 1024,
    /** 工作区扫描最多下潜几层目录。 */
    maxScanDepth: 6,
    /** 一次代码候选扫描最多检查几个代码文件。 */
    maxCodeScanFiles: 800,
    /** 没传 limit 时返回几个代码候选。 */
    defaultCodeCandidateLimit: 12,
    /** 文档标题最多留多少字符。 */
    titleMaxChars: 120,
    /** 文档摘要最多留多少字符。 */
    summaryMaxChars: 220,
    /** 正文里一行至少多少字符才配当摘要。 */
    summaryMinLineChars: 24,
    /** 代码摘要里最多列几个符号。 */
    codeSummarySymbols: 6,
    /** 代码标签里最多带几个符号。 */
    codeTagSymbols: 12,
  }),
  /** 代码候选的评分与取舍。 */
  codeCandidates: Object.freeze({
    /** 路径匹配分除以它再钳到 0-1。 */
    pathScoreDivisor: 10,
    /** 命中直接路径提示加多少分。 */
    directHintScore: 0.3,
    /** 命中提示文件的 import 目标加多少分。 */
    importedTargetScore: 0.22,
    /** 关系信号最多加到多少分。 */
    relationScoreCap: 0.6,
    /** 符号名完全相同加多少分。 */
    symbolExactScore: 0.38,
    /** 符号名部分包含加多少分。 */
    symbolPartialScore: 0.2,
    /** 只有正文包含提示词加多少分。 */
    symbolContentScore: 0.12,
    /** 符号信号最多加到多少分。 */
    symbolScoreCap: 0.9,
    /** 当前文件 import 了提示文件加多少分。 */
    importRelationScore: 0.18,
    /** import 关系最多加到多少分。 */
    importScoreCap: 0.45,
    /** 候选池先留 limit 的几倍作为缓冲，最终排序后再截断。 */
    bufferMultiplier: 2,
    /** 最多解析几条路径提示的 import 关系。 */
    signalPathHints: 10,
    /** 走代码智能时最多用几条符号提示。 */
    providerSymbolHints: 8,
    /** 走代码智能时每条符号提示最多取几个命中。 */
    providerSymbolHitLimit: 8,
    /** 走代码智能时最多用几条路径提示。 */
    providerPathHints: 6,
  }),
  /** 分块策略。 */
  chunking: Object.freeze({
    /** 单个代码 chunk 最多包含多少行，避免大文件整段进一个向量。 */
    codeChunkMaxLines: 80,
    /** 代码符号分块最多参考多少个符号，限制超大文件的索引成本。 */
    codeChunkMaxSymbols: 18,
    /** 文件头部区块最多保留多少行。 */
    codeHeaderMaxLines: 40,
    /** chunk 前缀里的摘要最多留多少字符。 */
    prefixSummaryChars: 180,
  }),
  /** 检索链路。 */
  query: Object.freeze({
    /** 同一份文档的访问时间最短多久更新一次（毫秒）。 */
    accessTouchThrottleMs: 60_000,
    /** 向量命中的摘要留多少字符。 */
    vectorSnippetChars: 180,
    /** 空查询返回最近知识时摘要留多少字符。 */
    recentSnippetChars: 160,
    /** 显式重建没传 limit 时一次处理几份文档。 */
    reindexDefaultLimit: 50,
    /** 路径或符号精确命中加多少分。 */
    exactHintBoost: 0.18,
    /** 路径或符号模糊命中加多少分。 */
    fuzzyHintBoost: 0.08,
    /** 用户显式要了某类来源时加多少分。 */
    sourceKindBoost: 0.02,
    /** 拼召回上下文时最多带几条结果。 */
    recallSections: 4,
  }),
  /** 嵌入链路。 */
  embedding: Object.freeze({
    /** 查询向量 LRU 的容量：约 128 条 × 1536 维 float ≈ 1.5MB，覆盖召回与去重的高频重复查询。 */
    queryCacheMaxEntries: 128,
  }),
  /** 向量故障抑制。 */
  vectorFailure: Object.freeze({
    /** 同一类故障多久之内只告警一次（毫秒）。 */
    windowMs: 10 * 60_000,
    /** 拿错误文字当去重键时最多截多少字符。 */
    messageKeyChars: 500,
  }),
})
