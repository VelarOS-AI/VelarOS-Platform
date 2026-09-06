import { extractSessionSearchTerms } from "@velaros-ai/agent";
import type { ChatContextRetrievalScoreStats } from "@velaros-ai/agent/protocol";
import { isEmpty, isPresent } from "@velaros-ai/core";

import { chatSearchText } from "./Text";

/**
 * {@link chatSearchRanking.rankContextText} 的完整打分输出。
 * 供会话搜索、history 搜索、terminal 搜索与 query trace 共用。
 */
interface RankingSignals {
  /** 最终排序分 = semanticScore +（命中时）recency 微调；用于结果排序。 */
  score: number;
  /** 纯语义相关分（词项/路径/符号/错误/计划等加权之和），≤0 表示未命中。 */
  semanticScore: number;
  /** 人类可读命中原因，如「词项匹配」「路径重合」；空数组表示无有效信号。 */
  matchReasons: string[];
  /** 与 query 路径 hint 重合的路径；无重合时退回正文内提取的前 4 条路径 hint。 */
  pathHints: string[];
  /** 与 query 符号 hint 重合的标识符；无重合时退回正文内提取的前 4 条。 */
  symbolHints: string[];
  /** 消息在会话中的时间序位置，0=最早，1=最新；仅传入 index/total 时有意义。 */
  recencyScore: number;
  /** 正文中命中的错误关键词（最多 4 个逗号拼接）；用于 agent 收窄「同类报错」检索。 */
  errorFingerprint: LooseOptional<string>;
}

/**
 * 会话/上下文检索共用的**纯关键词机械打分**（无 `embedding`、无向量库）。
 *
 * ## 谁在用
 * - {@link SessionSearchService}：跨会话消息搜索
 * - {@link ChatContextRetrievalService}：`searchConversationHistory` / `searchTerminalOutput`
 * - {@link ContextRetrievalQueryTraceStore}：`query` 签名归一化、分数分布统计
 *
 * ## 打分流水线（`rankContextText`）
 * 1. 从 `query` 与正文分别提取 `pathHints` / `symbolHints`
 * 2. 计算 `termScore`、`exactPhraseScore`、`pathScore`、`symbolScore`、`errorScore`、`planScore`
 * 3. 加权合成 `semanticScore`；若 `semanticScore>0` 再叠 `recencyScore×0.12` 得 `score`
 *
 * 导出单例 {@link chatSearchRanking}，全进程共用同一套权重与 `needle` 词表。
 */
class ChatSearchRanking {
  /**
   * 错误类 needle 词表。仅当 **query 与正文同时包含** 表中任一词时 errorScore=1。
   * 典型场景：用户搜 "timeout error"，正文也有 stack trace / 超时字样。
   */
  private readonly errorNeedleTerms = [
    "base_revision_mismatch",
    "denied",
    "error",
    "exception",
    "failed",
    "failure",
    "fatal",
    "mismatch",
    "panic",
    "stack",
    "timeout",
    "trace",
    "异常",
    "报错",
    "失败",
    "错误",
    "超时",
  ];

  /**
   * 计划/待办类 needle 词表。判定逻辑同 errorNeedleTerms。
   * 用于「还有哪些 todo / 阻塞项」类 query 与历史 plan 文本的弱关联。
   */
  private readonly planNeedleTerms = [
    "blocked",
    "next",
    "open issue",
    "pending",
    "plan",
    "remaining",
    "todo",
    "unresolved",
    "下一步",
    "待办",
    "未完成",
    "计划",
    "阻塞",
  ];

  /**
   * 符号 hint 提取时的英文停用词。过滤 message/search/session 等泛化词，
   * 避免把普通英文句子拆出一堆无信息 token。
   */
  private readonly commonSymbolStopWords = new Set([
    "about",
    "after",
    "before",
    "context",
    "could",
    "error",
    "failed",
    "from",
    "handle",
    "history",
    "message",
    "need",
    "please",
    "result",
    "search",
    "session",
    "should",
    "that",
    "this",
    "tool",
    "with",
  ]);

  /**
   * 路径 hint 正则：匹配 `src/foo/bar.ts` 形式目录路径，或带常见源码/配置扩展名的文件名。
   * 全局匹配，collectPathHints 内最多保留 16 条、单条至少 4 字符。
   */
  private readonly pathHintPattern =
    /(?:[~.]?\/)?(?:[\w.-]+\/)+[\w.-]+|[\w.-]+\.(?:[cm]?[jt]sx?|json|md|css|scss|py|rs|go|java|kt|swift|ya?ml|toml|html|xml|sh|sql|log|txt)/gi;

  /**
   * 标识符 token 正则：JS/TS 风格变量名，至少 3 字符（`\w$` 重复 2 次 + 首字符）。
   */
  private readonly symbolHintPattern = /\b[A-Za-z_$][\w$]{2,}\b/g;

  /**
   * query trace 中 scoreStats.buckets 的分桶边界。
   * 顶桶 maxScore=1 使用闭区间 `[min, max]`，其余桶右开。
   */
  private readonly scoreStatBucketDefs = [
    { label: "0.75-1.00", minScore: 0.75, maxScore: 1 },
    { label: "0.50-0.75", minScore: 0.5, maxScore: 0.75 },
    { label: "0.25-0.50", minScore: 0.25, maxScore: 0.5 },
    { label: "0.00-0.25", minScore: 0, maxScore: 0.25 },
  ] as const;

  /**
   * 从用户 query 提取归一化检索词项（小写、去标点、拆词/ CJK 等）。
   * 实现委托 `@velaros-ai/agent.extractSessionSearchTerms`。
   */
  public normalizeSearchTerms(query: string): string[] {
    return extractSessionSearchTerms(query);
  }

  /**
   * 将 query 规范化为「同一 scope 内是否重复搜索」用的签名。
   *
   * - 有词项时：词项排序后用空格拼接（顺序无关）
   * - 无词项时：整句小写 + 折叠空白
   *
   * 供 {@link ContextRetrievalQueryTraceStore.register} 作为 Map 键的一部分。
   */
  public normalizeQuerySignature(query: string, terms: string[]): string {
    const normalized = query.toLowerCase().replace(/\s+/g, " ").trim();
    const termSignature = [...terms].sort().join(" ");
    return termSignature || normalized;
  }

  /**
   * 对单段 `haystack` 文本做机械相关性打分。
   *
   * @param input.query 原始用户查询（用于完整短语匹配、`needle` 检测）
   * @param input.terms 已归一化词项列表（来自 `normalizeSearchTerms`）
   * @param input.text 待打分正文（消息 `searchableText`、日志内容、工具结果等）
   * @param input.index 可选，当前条目在会话中的序号（`0-based`）
   * @param input.total 可选，会话总条数；与 `index` 一起算 `recencyScore`
   *
   * ### 各子分数含义
   * | 字段 | 计算方式 | 权重 |
   * |------|----------|------|
   * | `termScore` | 命中词项数 / 词项总数 | 0.48 |
   * | `exactPhraseScore` | `query≥4` 字符且正文包含整句 | 0.18 |
   * | `pathScore` | 命中路径数 / `query` 路径 hint 数 | 0.22 |
   * | `symbolScore` | 命中符号数 / `query` 符号 hint 数 | 0.18 |
   * | `errorScore` | `query`+正文均含 `error needle` | 0.16 |
   * | `planScore` | `query`+正文均含 `plan needle` | 0.10 |
   *
   * 最终 `score = semanticScore + (semanticScore>0 ? recencyScore×0.12 : 0)`。
   */
  public rankContextText(input: {
    query: string;
    terms: string[];
    text: string;
    index?: number;
    total?: number;
  }): RankingSignals {
    const lowerText = input.text.toLowerCase();
    const lowerQuery = input.query.toLowerCase();
    const queryPathHints = this.collectPathHints(input.query);
    const textPathHints = this.collectPathHints(input.text);
    const querySymbolHints = this.collectSymbolHints(input.query);
    const textSymbolHints = this.collectSymbolHints(input.text);
    // 路径匹配：全文包含完整 hint，或至少包含 basename（便于 `SessionSearchService.ts` 类短文件名命中）
    const matchedPaths = queryPathHints.filter((hint) => {
      const basenameHint = hint.split("/").pop() ?? hint;
      return (
        lowerText.includes(hint.toLowerCase()) ||
        lowerText.includes(basenameHint.toLowerCase())
      );
    });
    const matchedSymbols = querySymbolHints.filter((hint) =>
      lowerText.includes(hint.toLowerCase()),
    );
    const termScore = isEmpty(input.terms)
      ? 0
      : input.terms.reduce(
          (score, term) => score + (lowerText.includes(term) ? 1 : 0),
          0,
        ) / input.terms.length;
    const exactPhraseScore =
      lowerQuery.length >= 4 && lowerText.includes(lowerQuery) ? 1 : 0;
    const pathScore = isEmpty(queryPathHints)
      ? 0
      : matchedPaths.length / queryPathHints.length;
    const symbolScore = isEmpty(querySymbolHints)
      ? 0
      : matchedSymbols.length / querySymbolHints.length;
    const queryErrorTerms = this.errorNeedleTerms.filter((term) =>
      lowerQuery.includes(term),
    );
    const textErrorTerms = this.errorNeedleTerms.filter((term) =>
      lowerText.includes(term),
    );
    // 必须 query 与正文「都在聊错误」才给分，避免正文偶然出现 error 单词误伤
    const errorScore =
      isEmpty(queryErrorTerms) || isEmpty(textErrorTerms) ? 0 : 1;
    const queryPlanTerms = this.planNeedleTerms.filter((term) =>
      lowerQuery.includes(term),
    );
    const textPlanTerms = this.planNeedleTerms.filter((term) =>
      lowerText.includes(term),
    );
    const planScore = isEmpty(queryPlanTerms) || isEmpty(textPlanTerms) ? 0 : 1;
    const total = Math.max(1, input.total ?? 1);
    const index = Math.max(0, input.index ?? total - 1);
    const recencyScore = total <= 1 ? 1 : index / (total - 1);
    const semanticScore =
      termScore * 0.48 +
      exactPhraseScore * 0.18 +
      pathScore * 0.22 +
      symbolScore * 0.18 +
      errorScore * 0.16 +
      planScore * 0.1;
    const matchReasons = [
      termScore > 0 ? "词项匹配" : null,
      exactPhraseScore > 0 ? "完整短语" : null,
      pathScore > 0 ? "路径重合" : null,
      symbolScore > 0 ? "符号重合" : null,
      errorScore > 0 ? "错误指纹" : null,
      planScore > 0 ? "计划关联" : null,
      semanticScore > 0 && recencyScore >= 0.75 ? "近期轮次" : null,
    ].filter((item): item is string => Boolean(item));
    const score = semanticScore + (semanticScore > 0 ? recencyScore * 0.12 : 0);
    const errorFingerprint = isEmpty(textErrorTerms)
      ? null
      : [...new Set(textErrorTerms)].slice(0, 4).join(",");

    return {
      score,
      semanticScore,
      matchReasons,
      pathHints: isEmpty(matchedPaths)
        ? textPathHints.slice(0, 4)
        : matchedPaths,
      symbolHints: isEmpty(matchedSymbols)
        ? textSymbolHints.slice(0, 4)
        : matchedSymbols,
      recencyScore,
      errorFingerprint,
    };
  }

  /**
   * 为 `UI` / `API` 生成展示用 `snippet`：围绕**最早出现**的命中词项截取。
   *
   * @param text 完整正文
   * @param terms 检索词项（决定锚点位置）
   * @param maxChars 最大字符数；实际截断还经 {@link chatSearchText.truncate}
   * @returns 空正文返回 `null`；无词项命中时从开头取 `maxChars`
   */
  public buildSearchSnippet(
    text: string,
    terms: string[],
    maxChars: number,
  ): LooseOptional<string> {
    const trimmed = text.trim();
    if (!trimmed) return null;

    const lower = trimmed.toLowerCase();
    const firstMatch = terms
      .map((term) => lower.indexOf(term))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];
    // 锚点前留约 1/3 窗口，避免 snippet 从命中词正中间开始
    const start = !isPresent(firstMatch)
      ? 0
      : Math.max(0, firstMatch - Math.floor(maxChars / 3));
    return chatSearchText.truncate(
      trimmed.slice(start, start + maxChars),
      maxChars,
    );
  }

  /**
   * 为日志类证据保留开头和结尾；无正文词项命中时不能再退化成纯文件头摘要。
   */
  public buildHeadTailSnippet(
    text: string,
    maxChars: number,
  ): LooseOptional<string> {
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (trimmed.length <= maxChars) return trimmed;

    const marker = "\n... head/tail excerpt; middle omitted ...\n";
    if (maxChars <= marker.length)
      return chatSearchText.truncate(trimmed, maxChars);
    const contentBudget = maxChars - marker.length;
    const headChars = Math.max(1, Math.floor(contentBudget * 0.35));
    const tailChars = Math.max(1, contentBudget - headChars);
    return `${trimmed.slice(0, headChars)}${marker}${trimmed.slice(-tailChars)}`;
  }

  /**
   * 汇总一批分数的 min/max/average 与分桶计数，写入 query trace。
   *
   * @param scores 通常为「所有命中项」的 score 列表（含未返回给 caller 的条目）
   */
  public buildRetrievalScoreStats(
    scores: number[],
  ): ChatContextRetrievalScoreStats {
    const buckets = this.scoreStatBucketDefs.map((bucket) => ({
      ...bucket,
      count: 0,
    }));
    const normalizedScores = scores.filter((score) => Number.isFinite(score));
    for (const score of normalizedScores) {
      const bucket = buckets.find((item) =>
        item.maxScore === 1
          ? score >= item.minScore && score <= item.maxScore
          : score >= item.minScore && score < item.maxScore,
      );
      if (bucket) {
        bucket.count += 1;
      }
    }

    if (isEmpty(normalizedScores))
      return {
        min: null,
        max: null,
        average: null,
        buckets,
      };

    const min = Math.min(...normalizedScores);
    const max = Math.max(...normalizedScores);
    const average =
      normalizedScores.reduce((total, score) => total + score, 0) /
      normalizedScores.length;

    return {
      min,
      max,
      average,
      buckets,
    };
  }

  /**
   * 用 pathHintPattern 扫描文本，去掉尾部标点，小写化，最多 16 条。
   * @param text query 或正文
   */
  private collectPathHints(text: string): string[] {
    const hints = new Set<string>();
    for (const match of text.matchAll(this.pathHintPattern)) {
      let end = match[0]?.length ?? 0;
      while (end > 0 && `),.;:'"\`]`.includes(match[0]?.[end - 1] ?? '')) end -= 1;
      const value = match[0]?.slice(0, end).toLowerCase();
      if (value && value.length >= 4) {
        hints.add(value);
      }
      if (hints.size >= 16) {
        break;
      }
    }
    return [...hints];
  }

  /**
   * 用 symbolHintPattern 扫描标识符；过滤停用词后，保留：
   * 含 `_`/`$`、camelCase、或长度≥6 的 token。最多 16 条。
   */
  private collectSymbolHints(text: string): string[] {
    const hints = new Set<string>();
    for (const match of text.matchAll(this.symbolHintPattern)) {
      const value = match[0];
      const normalized = value.toLowerCase();
      if (this.commonSymbolStopWords.has(normalized)) {
        continue;
      }

      if (
        value.includes("_") ||
        value.includes("$") ||
        /[A-Z]/.test(value.slice(1)) ||
        value.length >= 6
      ) {
        hints.add(value);
      }

      if (hints.size >= 16) {
        break;
      }
    }
    return [...hints];
  }
}

/** 全进程唯一的打分实例；见 {@link ChatSearchRanking}。 */
const chatSearchRanking = new ChatSearchRanking();

export { chatSearchRanking, type RankingSignals };
