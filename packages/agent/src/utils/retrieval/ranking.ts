import { isEmpty, isPresent } from "@velaros-ai/core";

import type { ChatContextRetrievalScoreStats } from '../../types/agent.js'
import type { RankingSignals } from '../../types/retrieval.js'
import { extractSessionSearchTerms } from "../chat/session-search-text";

import { chatSearchText } from "./text";

const PathHintExtensions = new Set([
  "cjs", "css", "cts", "go", "html", "java", "js", "json", "jsx", "kt", "log",
  "md", "mjs", "mts", "py", "rs", "scss", "sh", "sql", "swift", "toml", "ts",
  "tsx", "txt", "xml", "yaml", "yml",
]);
const PathHintTrailingPunctuation = `),.;:'"\`]`;

/**
 * 判一个字符能否出现在路径段里：ASCII 字母、数字，或 `_` `.` `-` 三者之一；空值一律为假。
 * 刻意只认 ASCII——路径提示是从自由文本里扫出来的，放开非 ASCII 会把整句中文当成一个路径段吃进去。
 */
function isAsciiPathSegmentCharacter(character: LooseOptional<string>): boolean {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    character === "_" ||
    character === "." ||
    character === "-"
  );
}

/**
 * 判一个 token 是不是一条**完整可用**的路径提示：可以 `~/` 或 `/` 开头，其余字符必须全是合法路径段字符，
 * 并且**至少含一个目录分隔符**、最后一段非空。
 * 两条硬要求都是为压误报：没有分隔符的裸单词不算路径；以 `/` 结尾或出现连续 `//` 的判假——
 * 前者是目录不是文件，后者多半是从 URL 或散文里切坏的碎片。
 */
function isCompletePathToken(value: string): boolean {
  let start = 0;
  if (value.startsWith("~/")) start = 2;
  else if (value.startsWith("/")) start = 1;

  let segmentLength = 0;
  let hasDirectorySeparator = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (character === "/") {
      if (segmentLength === 0) return false;
      hasDirectorySeparator = true;
      segmentLength = 0;
      continue;
    }
    if (!isAsciiPathSegmentCharacter(character)) return false;
    segmentLength += 1;
  }
  return hasDirectorySeparator && segmentLength > 0;
}

/**
 * 从右往左逐个剥掉路径提示尾部的标点（`)` `,` `.` `;` `:` 引号 反引号 `]`）。
 * 路径出现在自由文本里几乎总跟着标点（`见 src/a.ts。`、`（见 src/a.ts）`），不剥就永远匹配不上真实文件名。
 * 只剥尾部，不动开头与中间——路径中间的点是扩展名分隔符，剥掉就毁了。
 */
function trimPathHintPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && PathHintTrailingPunctuation.includes(value[end - 1] ?? "")) end -= 1;
  return value.slice(0, end);
}

/**
 * 判这个 token 的**文件名部分**是否带一个已知扩展名（小写比对，白名单见 `PathHintExtensions`）。
 * 点必须落在最后一个 `/` 之后（否则那是目录名里的点，不是扩展名），也不能是整串的最后一个字符（`a.` 不算）。
 * 用白名单而不是"有点就算"：`v1.2.3`、`example.com` 这类形状与文件名一模一样，放进来就是满地假路径提示。
 */
function hasCompletePathHintExtension(value: string): boolean {
  const basenameStart = value.lastIndexOf("/") + 1;
  const extensionStart = value.lastIndexOf(".");
  if (extensionStart <= basenameStart || extensionStart === value.length - 1) return false;
  return PathHintExtensions.has(value.slice(extensionStart + 1).toLowerCase());
}

/**
 * 错误类 needle 词表。仅当 **query 与正文同时包含** 表中任一词时 errorScore=1。
 * 典型场景：用户搜 "timeout error"，正文也有 stack trace / 超时字样。
 */
const errorNeedleTerms = [
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
  ]

/**
 * 计划/待办类 needle 词表。判定逻辑同 errorNeedleTerms。
 * 用于「还有哪些 todo / 阻塞项」类 query 与历史 plan 文本的弱关联。
 */
const planNeedleTerms = [
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
  ]

/**
 * 符号 hint 提取时的英文停用词。过滤 message/search/session 等泛化词，
 * 避免把普通英文句子拆出一堆无信息 token。
 */
const commonSymbolStopWords = new Set([
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
  ])

/**
 * 标识符 token 正则：JS/TS 风格变量名，至少 3 字符（`\w$` 重复 2 次 + 首字符）。
 */
const symbolHintPattern = /\b[A-Za-z_$][\w$]{2,}\b/g

/**
 * query trace 中 scoreStats.buckets 的分桶边界。
 * 顶桶 maxScore=1 使用闭区间 `[min, max]`，其余桶右开。
 */
const scoreStatBucketDefs = [
    { label: "0.75-1.00", minScore: 0.75, maxScore: 1 },
    { label: "0.50-0.75", minScore: 0.5, maxScore: 0.75 },
    { label: "0.25-0.50", minScore: 0.25, maxScore: 0.5 },
    { label: "0.00-0.25", minScore: 0, maxScore: 0.25 },
  ] as const

/**
 * 从用户 query 提取归一化检索词项（小写、去标点、拆词/ CJK 等）。
 * 实现委托 `@velaros-ai/agent.extractSessionSearchTerms`。
 */
export function normalizeSearchTerms(query: string): string[] {
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
export function normalizeQuerySignature(query: string, terms: string[]): string {
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
export function rankContextText(input: {
    query: string;
    terms: string[];
    text: string;
    index?: number;
    total?: number;
  }): RankingSignals {
    const lowerText = input.text.toLowerCase();
    const lowerQuery = input.query.toLowerCase();
    const queryPathHints = collectPathHints(input.query);
    const textPathHints = collectPathHints(input.text);
    const querySymbolHints = collectSymbolHints(input.query);
    const textSymbolHints = collectSymbolHints(input.text);
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
    const queryErrorTerms = errorNeedleTerms.filter((term) =>
      lowerQuery.includes(term),
    );
    const textErrorTerms = errorNeedleTerms.filter((term) =>
      lowerText.includes(term),
    );
    // 必须 query 与正文「都在聊错误」才给分，避免正文偶然出现 error 单词误伤
    const errorScore =
      isEmpty(queryErrorTerms) || isEmpty(textErrorTerms) ? 0 : 1;
    const queryPlanTerms = planNeedleTerms.filter((term) =>
      lowerQuery.includes(term),
    );
    const textPlanTerms = planNeedleTerms.filter((term) =>
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
export function buildSearchSnippet(text: string, terms: string[], maxChars: number): LooseOptional<string> {
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
export function buildHeadTailSnippet(text: string, maxChars: number): LooseOptional<string> {
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (trimmed.length <= maxChars) return trimmed;

    const marker = "\n……只截了开头和结尾，中间省略……\n";
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
export function buildRetrievalScoreStats(scores: number[]): ChatContextRetrievalScoreStats {
    const buckets = scoreStatBucketDefs.map((bucket) => ({
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

/** 单向扫描路径 token，去掉尾部标点，小写化，最多 16 条。 */
function collectPathHints(text: string): string[] {
    const hints = new Set<string>();
    const addHint = (rawValue: string): void => {
      const value = trimPathHintPunctuation(rawValue).toLowerCase();
      if (value.length >= 4) hints.add(value);
    };

    for (let index = 0; index < text.length && hints.size < 16;) {
      const character = text[index] ?? "";
      const startsHomePath = character === "~" && text[index + 1] === "/";
      if (!startsHomePath && character !== "/" && !isAsciiPathSegmentCharacter(character)) {
        index += 1;
        continue;
      }

      const tokenStart = index;
      if (startsHomePath) index += 2;
      while (index < text.length) {
        const tokenCharacter = text[index] ?? "";
        if (tokenCharacter === "/" && text[index + 1] === "/") break;
        if (tokenCharacter !== "/" && !isAsciiPathSegmentCharacter(tokenCharacter)) break;
        index += 1;
      }

      let pathMatchEnd = index;
      while (pathMatchEnd > tokenStart && text[pathMatchEnd - 1] === "/") pathMatchEnd -= 1;
      const pathToken = text.slice(tokenStart, pathMatchEnd);
      if (isCompletePathToken(pathToken)) {
        addHint(pathToken);
      } else {
        const fileToken = trimPathHintPunctuation(
          pathToken.slice(pathToken.lastIndexOf("/") + 1),
        );
        if (hasCompletePathHintExtension(fileToken)) addHint(fileToken);
      }

      if (index === tokenStart) index += 1;
      else if (text[index] === "/" && text[index + 1] === "/") index += 2;
    }
    return [...hints];
  }

/**
 * 用 symbolHintPattern 扫描标识符；过滤停用词后，保留：
 * 含 `_`/`$`、camelCase、或长度≥6 的 token。最多 16 条。
 */
function collectSymbolHints(text: string): string[] {
    const hints = new Set<string>();
    for (const match of text.matchAll(symbolHintPattern)) {
      const value = match[0];
      const normalized = value.toLowerCase();
      if (commonSymbolStopWords.has(normalized)) {
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

