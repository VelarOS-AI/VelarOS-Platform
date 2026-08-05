import {
  normalizeSessionLineageId,
  normalizeSessionLineageIdList,
} from "@velaros-ai/agent";
import type {
  ChatContextReadEvidenceRequest,
  ChatContextReadEvidenceResult,
  ChatContextReadToolPayloadRequest,
  ChatContextRetrievalIndexDiagnostics,
  ChatContextRetrievalIndexLoadSource,
  ChatContextRetrievalIndexSourceFingerprint,
  ChatContextRetrievedPayload,
  ChatContextRetrievePayloadRequest,
  ChatContextSearchConversationHistoryItem,
  ChatContextSearchConversationHistoryRequest,
  ChatContextSearchConversationHistoryResult,
  ChatContextSearchTerminalOutputItem,
  ChatContextSearchTerminalOutputRequest,
  ChatContextSearchTerminalOutputResult,
  SessionLineageContext,
} from "@velaros-ai/agent/protocol";
import {
  isEmpty,
  isFiniteNumber,
  isNotNull,
  isPositiveNumber,
  numberOrNull,
  toNullable,
} from "@velaros-ai/core";

import type { ContextGovernanceSessionRegistry } from "../residency/ContextGovernanceSession";
import type { ContextRecord } from "../residency/ContextRecord";
import { compareStableStrings } from "../residency/determinism";
import { readMessageText } from "../residency/messageFacts";
import type { ContextResidencyLedger } from "../residency/ResidencyLedger";

import { chatSearchRanking } from "./search/Ranking";
import { chatSearchText } from "./search/Text";
import {
  ContextRetrievalBoundedCounter,
  ContextRetrievalBoundedRecentMap,
} from "./BoundedRecentMap";
import { ContextRetrievalIndexBuilder } from "./IndexBuilder";
import {
  type ChatContextRetrievalIndexSnapshot,
  type ChatContextRetrievalIndexStore,
  ChatContextRetrievalIndexVersion,
  contextRetrievalFingerprintIsComparable,
  contextRetrievalFingerprintsEqual,
} from "./IndexSnapshot";
import {
  ContextRetrievalPayloadReader,
  paginateSerializedText,
} from "./PayloadReader";
import {
  ContextRetrievalQueryTraceStore,
  type ContextRetrievalQueryTraceStoreOptions,
} from "./QueryTraceStore";
import { ContextRetrievalReferenceReader } from "./ReferenceReader";
import {
  contextRetrievalReferences,
  type LogReadSnippet,
  type ReferencedLogPath,
} from "./References";
import type {
  RetrievalPayloadStorePort,
  RetrievalStateStorePort,
} from "./sessionStorePorts";

const DefaultRetrievalCountEntryLimit = 4_096;
const DefaultIndexBuildTelemetrySessionLimit = 512;
const DefaultTerminalOutputPayloadCandidateLimit = 64;
/**
 * 内存索引缓存的会话数上限。
 *
 * 缓存的是整份索引快照（长会话可达数 MB），所以宁小勿大：真正的热点只有"当前正在跑的那个
 * 会话"，8 个槽位足以覆盖并行子 agent + 用户手动切换，再多只是拿内存换命不中的概率。
 */
const DefaultCachedIndexSessionLimit = 8;

type ChatContextRetrievalIndexToolPayload =
  ChatContextRetrievalIndexSnapshot["toolPayloads"][number];

interface ChatContextRetrievalServiceOptions {
  maxRetrievalCountEntries?: LooseOptional<number>;
  maxIndexBuildTelemetrySessions?: LooseOptional<number>;
  maxTerminalOutputPayloadCandidates?: LooseOptional<number>;
  maxCachedIndexSessions?: LooseOptional<number>;
  queryTrace?: ContextRetrievalQueryTraceStoreOptions;
}

/** 账本 ref 解析结果：命中的记录 + 该 ref 对应的全保真层引用（per-part 优先）。 */
interface ResolvedLedgerRecord {
  record: ContextRecord;
  payloadRef: Nullable<string>;
}

/** 内存索引缓存条目：快照 + 它成立时的源指纹。 */
interface CachedRetrievalIndex {
  fingerprint: ChatContextRetrievalIndexSourceFingerprint;
  snapshot: ChatContextRetrievalIndexSnapshot;
}

/**
 * 单次 loadRetrievalIndex 的构建遥测，合并进 diagnostics。
 */
interface RetrievalIndexBuildTelemetry {
  /** 本次命中 fresh 磁盘索引还是内存 rebuild。 */
  lastLoadSource: ChatContextRetrievalIndexLoadSource;
  /** rebuild 耗时 ms；loadFresh 命中时为 null。 */
  lastBuildDurationMs: LooseOptional<number>;
  /** 索引 snapshot.builtAt。 */
  lastBuiltAt: LooseOptional<number>;
}

/**
 * 上下文检索的**主进程门面**（`IPC` 层直接调用）。
 *
 * ## 模块分层
 * ```
 * ChatContextRetrievalService（本类：`API` + 重复计数 + 索引 `load` 编排）
 *   ├─ ContextRetrievalIndexBuilder + ChatContextRetrievalIndexStore
 *   ├─ chatSearchRanking + chatSearchText
 *   ├─ ContextRetrievalPayloadReader + ContextRetrievalReferenceReader
 *   └─ ContextRetrievalQueryTraceStore
 * ```
 *
 * ## 两类「重复」防护
 * | 机制 | 键 | 触发 `warning` |
 * |------|-----|--------------|
 * | `retrievalCounts` | `session:scope:handle` 或 `evidence:id` | 第 2+ 次 `retrieve`/`read` |
 * | `queryTraceStore` | `session:scope:kind:normalizedQuery` | 第 2+ 次同类 `search` |
 *
 * ## 与 SessionSearchService 的区别
 * 本服务仅操作**单个 `sessionId`** 的会话上下文索引；`SessionSearchService` 跨会话扫持久层。
 */
class ChatContextRetrievalService {
  /**
   * handle / evidence 重复读取计数。
   * 键：`{sessionId}:{retrievalScopeId}:{handleId}` 或 `…:evidence:{evidenceId}`。
   */
  private readonly retrievalCounts: ContextRetrievalBoundedCounter;

  /** 搜索 query  trace 与重复 search 检测。 */
  private readonly queryTraceStore: ContextRetrievalQueryTraceStore;

  /** 日志/artifact 读盘。 */
  private readonly referenceReader = new ContextRetrievalReferenceReader();

  /** 索引构建（messages + toolPayloads + evidence）。 */
  private readonly indexBuilder: ContextRetrievalIndexBuilder;

  /** handle → 正文展开。 */
  private readonly payloadReader: ContextRetrievalPayloadReader;

  /** sessionId → 最近一次索引 load/rebuild 遥测。 */
  private readonly indexBuildTelemetryBySession: ContextRetrievalBoundedRecentMap<RetrievalIndexBuildTelemetry>;
  /** sessionId → 正在进行的 loadFresh/rebuild，避免并发查询重复构建同一索引。 */
  private readonly pendingIndexLoads = new Map<
    string,
    Promise<ChatContextRetrievalIndexSnapshot>
  >();
  /**
   * sessionId → 最近一份索引快照 + 它的源指纹。
   *
   * 指纹一致就直接复用内存快照：省掉 readFile + JSON.parse 整份索引（长会话几十 MB），
   * 只留一次目录 stat。`kind=all` 的一次召回本来要串行走两遍完整流程，未命中句柄时还要再来
   * 两遍，这段延迟直接叠在模型等待上。
   */
  private readonly cachedIndexBySession: ContextRetrievalBoundedRecentMap<CachedRetrievalIndex>;
  private readonly terminalOutputPayloadCandidateLimit: number;

  constructor(
    payloadStore: RetrievalPayloadStorePort,
    stateStore: RetrievalStateStorePort,
    /**
     * 治理会话登记处；每次召回都是一次**缺页（fault）**，经此记进驻留账本。
     * fault 率是策略好坏的核心信号，也是 epoch 排序里"高者缓降"的输入（设计 §4C）。
     */
    private readonly governanceSessions: ContextGovernanceSessionRegistry,
    /** 检索索引存储端口；宿主注入文件系统实现（落盘策略与新鲜度指纹在宿主侧）。 */
    private readonly indexStore: ChatContextRetrievalIndexStore,
    options: ChatContextRetrievalServiceOptions = {},
  ) {
    this.retrievalCounts = new ContextRetrievalBoundedCounter(
      this.normalizeLimit(
        options.maxRetrievalCountEntries,
        DefaultRetrievalCountEntryLimit,
      ),
    );
    this.queryTraceStore = new ContextRetrievalQueryTraceStore(
      options.queryTrace,
    );
    this.indexBuildTelemetryBySession = new ContextRetrievalBoundedRecentMap(
      this.normalizeLimit(
        options.maxIndexBuildTelemetrySessions,
        DefaultIndexBuildTelemetrySessionLimit,
      ),
    );
    this.terminalOutputPayloadCandidateLimit = this.normalizeLimit(
      options.maxTerminalOutputPayloadCandidates,
      DefaultTerminalOutputPayloadCandidateLimit,
    );
    this.cachedIndexBySession = new ContextRetrievalBoundedRecentMap(
      this.normalizeLimit(
        options.maxCachedIndexSessions,
        DefaultCachedIndexSessionLimit,
      ),
    );
    this.indexBuilder = new ContextRetrievalIndexBuilder(
      payloadStore,
      stateStore,
    );
    this.payloadReader = new ContextRetrievalPayloadReader(
      payloadStore,
      stateStore,
      this.referenceReader,
    );
  }

  /**
   * 按动态上下文 **`handle`** 拉取完整 `payload` 正文。
   *
   * `Handle` 分发：
   * - `tool:*` / `ctx-payload:*` / `ctx-user-payload:*` → `PayloadReader.retrieveToolPayload`
   * - `message:*` → `PayloadReader.retrieveMessagePayload`
   * - 驻留账本认识的 ref（记录 id / payloadRef / toolCallId / 折叠信封 ref）→ 账本原文
   *   （也是上面两条**未命中时**的兜底：全保真层被 GC 不等于内容没了）
   * - 其它 → `found=false`, `kind=unknown`
   *
   * `retrievalScopeId` 默认 `sessionId`；同一 `scope` 内重复请求同一 `handle` 会告警。
   */
  public async retrieveContextPayload(
    request: ChatContextRetrievePayloadRequest,
  ): Promise<ChatContextRetrievedPayload> {
    const sessionId = request.sessionId.trim();
    const handleId = request.handleId.trim();
    const jsonPath = request.jsonPath?.trim() || null;
    const retrievalScopeId = this.resolveRetrievalScopeId(
      sessionId,
      request.retrievalScopeId,
      request.sessionLineage,
    );
    const maxChars = chatSearchText.clampMaxChars(request.maxChars);
    const offset = Math.max(0, Math.round(request.offset ?? 0));
    // offset 纳入去重键:分页续读不是重复检索,不该吃 repeated 告警。
    const countKey = `${sessionId}:${retrievalScopeId}:${handleId}:${jsonPath ?? ""}:${offset}`;
    const retrievalCount = this.retrievalCounts.increment(countKey);
    const repeated = retrievalCount > 1;

    // member=session：会话即资源作用域，工具 payload handle 不再做跨 context 可见性闸门；
    // 直接展开（句柄无效时 payloadReader 自然返回 found=false）。
    // `ctx-user-payload:` = 超大 user 正文的全保真句柄，与工具 payload 同表落盘，同一条路展开。
    if (
      handleId.startsWith("tool:") ||
      handleId.startsWith("ctx-payload:") ||
      handleId.startsWith("ctx-user-payload:")
    ) {
      const payload = await this.payloadReader.retrieveToolPayload({
        sessionId,
        handleId,
        retrievalScopeId,
        maxChars,
        jsonPath,
        offset,
        repeated,
        retrievalCount,
      });
      if (payload.found) {
        this.governanceSessions.recordFault(sessionId, handleId);
        return payload;
      }

      // 全保真层没有（被 GC/未落盘），但驻留账本可能仍持有这条记录的原文——先问账本再判死。
      const fromLedger = await this.retrieveLedgerRecordPayload({
        sessionId,
        handleId,
        retrievalScopeId,
        maxChars,
        offset,
        repeated,
        retrievalCount,
      });
      if (fromLedger?.found) {
        this.governanceSessions.recordFault(sessionId, handleId);
        return fromLedger;
      }

      return payload;
    }

    if (handleId.startsWith("message:")) {
      const payload = await this.payloadReader.retrieveMessagePayload({
        sessionId,
        handleId,
        retrievalScopeId,
        maxChars,
        repeated,
        retrievalCount,
      });
      if (payload.found)
        this.governanceSessions.recordFault(sessionId, handleId);
      return payload;
    }

    // 驻留账本记录 id（`ctx-r000123`）与折叠信封里的任意 ref：账本自己就是权威副本。
    // 超大 user 正文的安全阀发的正是记录 id 形态的 handle，没有这条路它就是死链（审计 U6/U10）。
    const ledgerPayload = await this.retrieveLedgerRecordPayload({
      sessionId,
      handleId,
      retrievalScopeId,
      maxChars,
      offset,
      repeated,
      retrievalCount,
    });
    if (ledgerPayload) {
      if (ledgerPayload.found)
        this.governanceSessions.recordFault(sessionId, handleId);
      return ledgerPayload;
    }

    // 铁律1:匹配失败必须列出有效项供自纠,并自动把 ref 当 query 兜底搜一轮——
    // 把"召回失败→模型盲猜重试"的抖动收敛成一次往返。
    const validHandleSamples = await this.listValidHandleSamples(sessionId);
    const fallbackSearch = await this.searchConversationHistory({
      sessionId,
      query: handleId,
      maxResults: 3,
    }).catch(() => null);
    return {
      handleId,
      sessionId,
      found: false,
      kind: "unknown",
      content: null,
      repeated,
      retrievalCount,
      warning: [
        "未知的动态上下文 handle。",
        validHandleSamples.length
          ? `当前会话有效句柄样本(最多10条):${validHandleSamples.join("、")}`
          : null,
        fallbackSearch?.items?.length
          ? "已自动按该 ref 关键词搜索历史,见 fallbackSearch。"
          : null,
      ]
        .filter((item): item is string => Boolean(item))
        .join(" "),
      ...(fallbackSearch?.items?.length
        ? { metadata: { fallbackSearch: fallbackSearch.items } }
        : {}),
    };
  }

  /**
   * 驻留账本记录路由：把 handle 当**账本记录的引用**解析，命中即用账本里的原始消息取回全文。
   *
   * ## 为什么这条路必须存在
   * 折叠信封给模型的 `ref` 有三种形态：`payloadRef`、`toolCallId`、以及**记录 id**
   * （`ctx-r000123`）。前两种落在 payload 存储里，第三种此前没有任何解析器认识：超大 user 正文
   * 的安全阀恰恰只能发第三种（user 消息没有 toolCallId，准入期也拿不到 payloadRef），
   * 于是"正文在磁盘上、模型永远取不回"（审计 U6/U10）。
   *
   * ## 两级取回
   * 1. 记录带 `payloadRef` → 交给 payload 读取器（全保真层，支持 jsonPath/offset 分页）；
   * 2. 否则用账本自己持有的原始消息投影正文（账本记录内容不可变，是这段正文的权威副本）。
   *
   * 治理会话不存在（进程重启/未编译过）时返回 null，让调用方继续走未知 handle 的自纠路径。
   */
  private async retrieveLedgerRecordPayload(input: {
    sessionId: string;
    handleId: string;
    retrievalScopeId: string;
    maxChars: number;
    offset: number;
    repeated: boolean;
    retrievalCount: number;
  }): Promise<Nullable<ChatContextRetrievedPayload>> {
    const session = this.governanceSessions.peek(input.sessionId);
    if (!session) return null;

    const resolved = this.findLedgerRecordByRef(session.ledger, input.handleId);
    if (!resolved) return null;

    const record = resolved.record;
    const payloadRef = resolved.payloadRef?.trim();
    if (payloadRef) {
      const payload = await this.payloadReader.retrieveToolPayload({
        sessionId: input.sessionId,
        handleId: payloadRef,
        retrievalScopeId: input.retrievalScopeId,
        maxChars: input.maxChars,
        offset: input.offset,
        repeated: input.repeated,
        retrievalCount: input.retrievalCount,
      });
      // 全保真层可能已被清理；只有真取到才用它，否则回落账本自持的正文。
      if (payload.found)
        return {
          ...payload,
          handleId: input.handleId,
          metadata: { ...(payload.metadata ?? {}), recordId: record.id },
        };
    }

    // 记录不带消息（合成/隐藏类）时退回它自己的摘录：宁可给"当时留下的那份"，
    // 也不要让模型收到 found=true + 空正文。两者都没有就交回未知 handle 路径。
    const fullText = record.message
      ? readMessageText(record.message)
      : (record.excerpt?.text ?? "");
    if (!fullText) return null;

    const window = paginateSerializedText(fullText, input.offset, input.maxChars);
    return {
      handleId: input.handleId,
      sessionId: input.sessionId,
      found: true,
      kind: "context-record",
      content: window.text,
      repeated: input.repeated,
      retrievalCount: input.retrievalCount,
      warning:
        [
          window.beyondEnd
            ? `offset=${window.offset} 已越过正文末尾(totalChars=${window.totalChars})；正文已读完。`
            : null,
          input.repeated
            ? "当前执行范围内已检索过该记录；请先使用已返回内容，避免重复检索。"
            : null,
        ]
          .filter((item): item is string => Boolean(item))
          .join(" ") || null,
      metadata: {
        recordId: record.id,
        recordKind: record.kind,
        toolCallId: record.toolCallId,
        payloadRef: record.payloadRef,
        retrievalScopeId: input.retrievalScopeId,
        offset: window.offset,
        returnedChars: window.returnedChars,
        totalChars: window.totalChars,
        nextOffset: window.nextOffset,
      },
    };
  }

  /**
   * 账本记录的 ref 解析：认记录 id、payloadRef、toolCallId（含 `tool:` 前缀形态）与折叠信封的
   * excerpt.ref —— 与 `ContextGovernanceSession.recordFault` 的缺页记账口径逐条对齐
   * （那边认哪几种，这边就必须能取回哪几种，否则会出现"记了 fault 却取不回"的错位）。
   */
  private findLedgerRecordByRef(
    ledger: ContextResidencyLedger,
    ref: string,
  ): Nullable<ResolvedLedgerRecord> {
    const key = ref.trim();
    if (!key) return null;

    const direct = ledger.get(key);
    if (direct) return { record: direct, payloadRef: direct.payloadRef };

    const bare = key.startsWith("tool:") ? key.slice("tool:".length) : key;
    // **从新往旧扫**：同一个 toolCallId 会同时出现在 tool-call 与 tool-result 两条记录上，
    // 正序扫必然先撞上只有参数、没有正文的那条调用记录（模型要的是结果）。倒序还顺带让
    // "最近一次出现"胜出，符合模型手里的 ref 总是来自最近投影这一事实。
    const records = ledger.list();
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]!;
      if (record.payloadRef === key || record.excerpt?.ref === key)
        return { record, payloadRef: record.payloadRef };

      // per-part 命中优先用**这一份**结果的 payloadRef：一条 role:'tool' 消息可装 N 份结果，
      // 用记录级 ref 会把第 2..N 份指向第一份的 payload（S2 修的 V12 同款错位）。
      const part = record.toolParts.find(
        (candidate) =>
          candidate.toolCallId === bare || candidate.excerpt?.ref === key,
      );
      if (part) return { record, payloadRef: part.payloadRef };
      if (record.toolCallId === bare)
        return { record, payloadRef: record.payloadRef };
    }

    return null;
  }

  /** 有效句柄样本(≤10):动态工具 payload handle + evidence id,供召回失败时模型自纠。 */
  private async listValidHandleSamples(sessionId: string): Promise<string[]> {
    try {
      const index = await this.loadRetrievalIndex(sessionId);
      const payloadHandles = index.toolPayloads
        .slice(-6)
        .map((entry) => entry.handleId);
      const evidenceIds = index.evidence.slice(-4).map((record) => record.id);
      return [...payloadHandles, ...evidenceIds].slice(0, 10);
    } catch {
      // arch-guard:silent-catch-ok 纠错提示样本是 best-effort；索引暂不可读时返回空样本，不影响主召回错误。
      return [];
    }
  }

  /**
   * 在当前会话**已索引消息**中关键词搜索（无向量）。
   *
   * 流程：
   * 1. queryTraceStore.register
   * 2. loadRetrievalIndex → index.messages
   * 3. 每条 message.searchableText 上 rankContextText（带 recency）
   * 4. semanticScore≤0 且 terms 非空 → 丢弃
   * 5. 按 score 降序、messageIndex 降序排序，取 maxResults
   * 6. queryTraceStore.record → 返回 items + trace
   */
  public async searchConversationHistory(
    request: ChatContextSearchConversationHistoryRequest,
  ): Promise<ChatContextSearchConversationHistoryResult> {
    const sessionId = request.sessionId.trim();
    const query = request.query.trim();
    const retrievalScopeId = this.resolveRetrievalScopeId(
      sessionId,
      request.retrievalScopeId,
      request.sessionLineage,
    );
    const maxResults = chatSearchText.clampMaxResults(request.maxResults);
    const maxChars = chatSearchText.clampMaxChars(request.maxChars);
    const terms = chatSearchRanking.normalizeSearchTerms(query);
    const queryRegistration = this.queryTraceStore.register({
      sessionId,
      retrievalScopeId,
      kind: "conversation-history",
      query,
      terms,
    });
    const index = await this.loadRetrievalIndex(sessionId);
    const totalMessages = index.messages.length;

    const matchedItems = index.messages
      .map(
        (message): LooseOptional<ChatContextSearchConversationHistoryItem> => {
          const ranking = chatSearchRanking.rankContextText({
            query,
            terms,
            text: message.searchableText,
            index: message.messageIndex,
            total: totalMessages,
          });
          if (ranking.semanticScore <= 0 && !isEmpty(terms)) return null;

          return {
            handleId: message.handleId,
            messageId: message.messageId,
            messageIndex: message.messageIndex,
            role: message.role,
            timestamp: message.timestamp,
            score: ranking.score,
            matchReasons: ranking.matchReasons,
            pathHints: ranking.pathHints,
            symbolHints: ranking.symbolHints,
            recencyScore: ranking.recencyScore,
            errorFingerprint: toNullable(ranking.errorFingerprint),
            summary: chatSearchText.truncate(
              message.summary,
              Math.min(240, maxChars),
            ),
            matchedText: toNullable(
              chatSearchRanking.buildSearchSnippet(
                message.text || message.searchableText,
                terms,
                Math.min(900, maxChars),
              ),
            ),
            toolNames: message.toolNames,
          };
        },
      )
      .filter((item): item is ChatContextSearchConversationHistoryItem =>
        Boolean(item),
      )
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;

        return right.messageIndex - left.messageIndex;
      });
    const items = matchedItems.slice(0, maxResults);
    const trace = this.queryTraceStore.record({
      sessionId,
      retrievalScopeId,
      kind: "conversation-history",
      query,
      registration: queryRegistration,
      totalCandidates: totalMessages,
      matchedCount: matchedItems.length,
      matchedScores: matchedItems.map((item) => item.score),
      returnedItems: items.map((item) => ({
        handleId: item.handleId,
        score: item.score,
        matchReasons: item.matchReasons,
      })),
    });
    const retryHints = this.buildEmptySearchRetryHints({
      kind: "conversation-history",
      matchedCount: matchedItems.length,
      totalCandidates: totalMessages,
    });

    return {
      sessionId,
      query,
      totalMessages: index.messages.length,
      items,
      trace,
      retryHints: isEmpty(retryHints) ? undefined : retryHints,
      warning: this.combineSearchWarnings(trace.warning, retryHints),
    };
  }

  /**
   * 读取 Context OS **evidence** 记录（不自动展开 payload 全文）。
   *
   * 从 index.evidence 按 id 查找；命中则 truncate excerpt，并通过
   * resolveEvidencePayloadHandle 给出可选的 payloadHandleId 供后续 retrieve。
   *
   * lifecycle 为 stale / reread-required 时附加过期 warning。
   */
  public async readEvidence(
    request: ChatContextReadEvidenceRequest,
  ): Promise<ChatContextReadEvidenceResult> {
    const sessionId = request.sessionId.trim();
    const evidenceId = request.evidenceId.trim();
    const retrievalScopeId = this.resolveRetrievalScopeId(
      sessionId,
      request.retrievalScopeId,
      request.sessionLineage,
    );
    const maxChars = chatSearchText.clampMaxChars(request.maxChars);
    const countKey = `${sessionId}:${retrievalScopeId}:evidence:${evidenceId}`;
    const retrievalCount = this.retrievalCounts.increment(countKey);
    const repeated = retrievalCount > 1;
    const index = await this.loadRetrievalIndex(sessionId);
    const evidence = index.evidence.find((record) => record.id === evidenceId);

    if (!evidence) {
      // 铁律1:miss 必须列有效项。证据集通常很小,直接回带 {id, kind, path} 样本供自纠。
      const samples = index.evidence
        .slice(-8)
        .map(
          (record) =>
            `${record.id}(${record.kind}${record.path ? `:${record.path}` : ""})`,
        );
      return {
        sessionId,
        evidenceId,
        found: false,
        evidence: null,
        payloadHandleId: null,
        repeated,
        retrievalCount,
        warning: [
          "未在活跃 Context OS 视图或运行时账本中找到该证据。",
          !isEmpty(samples) ? `当前有效证据样本:${samples.join("、")}` : null,
        ]
          .filter((item): item is string => Boolean(item))
          .join(" "),
      };
    }

    const stale =
      evidence.lifecycle === "stale" ||
      evidence.lifecycle === "reread-required";
    const payloadHandleId =
      this.payloadReader.resolveEvidencePayloadHandle(evidence);
    const repeatedWarning = repeated
      ? "当前执行范围内已读过该证据；请使用已返回记录或其 payload handle，勿重复读取。"
      : null;
    const warning = [
      stale
        ? "该证据已过期或需要重读；在依赖旧摘录前请通过注入能力重新读取来源。"
        : null,
      repeatedWarning,
    ]
      .filter((item): item is string => Boolean(item))
      .join(" ");

    return {
      sessionId,
      evidenceId,
      found: true,
      evidence: {
        ...evidence,
        excerpt: evidence.excerpt
          ? chatSearchText.truncate(evidence.excerpt, maxChars)
          : evidence.excerpt,
      },
      payloadHandleId: toNullable(payloadHandleId),
      repeated,
      retrievalCount,
      warning: warning ? warning : null,
    };
  }

  /**
   * 便捷 API：用 payloadRef 或 toolCallId 构造 handle 并调用 retrieveContextPayload。
   * payloadRef 优先于 toolCallId。
   */
  public async readToolPayload(
    request: ChatContextReadToolPayloadRequest,
  ): Promise<ChatContextRetrievedPayload> {
    const payloadRef = request.payloadRef?.trim();
    const toolCallId = request.toolCallId?.trim();

    return this.retrieveContextPayload({
      sessionId: request.sessionId,
      // 防御:调用方可能已带 tool: 前缀(如模型把折叠桩里的完整 handle 当 toolCallId 传),
      // 盲加前缀会变 tool:tool:* 永远 miss。
      handleId:
        payloadRef ||
        (toolCallId?.startsWith("tool:")
          ? toolCallId
          : `tool:${toolCallId ?? ""}`),
      jsonPath: request.jsonPath,
      offset: request.offset,
      retrievalScopeId: request.retrievalScopeId,
      sessionLineage: request.sessionLineage,
      reason: request.reason ?? "读取指定已保存工具 payload",
      maxChars: request.maxChars,
    });
  }

  /**
   * 在工具结果引用的**内部命令日志**中搜索。
   *
   * 与 searchConversationHistory 不同：需要**读盘**每条 logReference。
   *
   * 对 index.toolPayloads 双重循环：
   * - 外层：每个工具 payload
   * - 内层：readReferencedLogs → 对 haystack = searchableText + path + content 打分
   *
   * 命中项带 logPath、truncated、warning（读盘层问题）。
   */
  public async searchTerminalOutput(
    request: ChatContextSearchTerminalOutputRequest,
  ): Promise<ChatContextSearchTerminalOutputResult> {
    const sessionId = request.sessionId.trim();
    const query = request.query.trim();
    const retrievalScopeId = this.resolveRetrievalScopeId(
      sessionId,
      request.retrievalScopeId,
      request.sessionLineage,
    );
    const terms = chatSearchRanking.normalizeSearchTerms(query);
    const queryRegistration = this.queryTraceStore.register({
      sessionId,
      retrievalScopeId,
      kind: "terminal-output",
      query,
      terms,
    });
    const maxResults = chatSearchText.clampMaxResults(request.maxResults);
    const maxChars = chatSearchText.clampMaxChars(request.maxChars);
    const index = await this.loadRetrievalIndex(sessionId);
    const items: ChatContextSearchTerminalOutputItem[] = [];
    const logSnippetByPath = new Map<string, LogReadSnippet>();
    const payloadCandidates = this.selectTerminalOutputPayloadCandidates({
      toolPayloads: index.toolPayloads,
      query,
      terms,
    });

    for (const toolPayload of payloadCandidates) {
      const snippets = await this.readReferencedLogsOnce({
        references: toolPayload.logReferences,
        cacheByPath: logSnippetByPath,
        totalBudgetChars: maxChars,
      });
      for (const snippet of snippets) {
        const content = snippet.content ?? snippet.path;
        const haystack = [
          toolPayload.searchableText,
          snippet.path,
          snippet.source,
          snippet.content ?? "",
        ].join("\n");
        const ranking = chatSearchRanking.rankContextText({
          query,
          terms,
          text: haystack,
        });
        if (ranking.semanticScore <= 0 && !isEmpty(terms)) {
          continue;
        }

        items.push({
          handleId: toolPayload.handleId,
          toolCallId: toolPayload.toolCallId,
          logPath: snippet.path,
          source: snippet.source,
          score: ranking.score,
          matchReasons: ranking.matchReasons,
          snippet:
            (snippet.truncated &&
            !terms.some((term) =>
              content.toLowerCase().includes(term.toLowerCase()),
            )
              ? chatSearchRanking.buildHeadTailSnippet(
                  content,
                  Math.min(1_500, maxChars),
                )
              : chatSearchRanking.buildSearchSnippet(
                  content,
                  terms,
                  Math.min(1_500, maxChars),
                )) ?? "",
          truncated: snippet.truncated,
          warning: snippet.warning,
        });
      }
    }
    const sortedItems = items.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;

      return compareStableStrings(left.logPath, right.logPath);
    });
    const returnedItems = sortedItems.slice(0, maxResults);
    const totalLogReferences = index.toolPayloads.reduce(
      (total, toolPayload) => total + toolPayload.logReferences.length,
      0,
    );
    const trace = this.queryTraceStore.record({
      sessionId,
      retrievalScopeId,
      kind: "terminal-output",
      query,
      registration: queryRegistration,
      totalCandidates: totalLogReferences,
      matchedCount: sortedItems.length,
      matchedScores: sortedItems.map((item) => item.score),
      returnedItems: returnedItems.map((item) => ({
        handleId: item.handleId,
        score: item.score,
        matchReasons: item.matchReasons,
      })),
    });
    const retryHints = this.buildEmptySearchRetryHints({
      kind: "terminal-output",
      matchedCount: sortedItems.length,
      totalCandidates: totalLogReferences,
    });

    return {
      sessionId,
      query,
      items: returnedItems,
      trace,
      retryHints: isEmpty(retryHints) ? undefined : retryHints,
      warning: this.combineSearchWarnings(trace.warning, retryHints),
    };
  }

  /**
   * 返回索引诊断：新鲜度、构建来源/耗时、recentQueries。
   * 若 indexStore 报告 !fresh，会先 loadRetrievalIndex 触发 rebuild 再读 diagnostics。
   */
  public async getRetrievalIndexDiagnostics(
    sessionId: string,
  ): Promise<Nullable<ChatContextRetrievalIndexDiagnostics>> {
    const normalizedSessionId = sessionId.trim();

    let diagnostics =
      await this.indexStore.getDiagnostics?.(normalizedSessionId);
    if (!diagnostics) return null;

    if (!diagnostics.fresh) {
      await this.loadRetrievalIndex(normalizedSessionId);
      diagnostics =
        (await this.indexStore.getDiagnostics?.(normalizedSessionId)) ??
        diagnostics;
    }

    const telemetry =
      this.indexBuildTelemetryBySession.get(normalizedSessionId);

    return {
      ...diagnostics,
      lastLoadSource: telemetry?.lastLoadSource ?? diagnostics.lastLoadSource,
      lastBuildDurationMs:
        telemetry?.lastBuildDurationMs ?? diagnostics.lastBuildDurationMs,
      lastBuiltAt: telemetry?.lastBuiltAt ?? diagnostics.lastBuiltAt,
      recentQueries: this.queryTraceStore.getRecent(normalizedSessionId),
    };
  }

  /**
   * 硬失效通道：会话删除 / 重置时丢弃这个 sessionId 的全部进程内检索状态。
   *
   * 缓存判据是"源指纹一致就复用"，而会话被删后目录消失、指纹多半读不出来，于是**大多数**情况会
   * 自然退化成重建 —— 但那是巧合不是保证：同一 sessionId 被复用、或目录被外部工具原样恢复到旧
   * mtime 时，进程内会继续供应上一段对话的索引，而 8 个槽位的 LRU 让它可以活很久（审计 R8）。
   * 治理侧已经认了"会话没了状态就该没"（`ContextGovernanceSessionRegistry.invalidateSession`），
   * 检索侧跟上：宿主的会话删除路径两个都调。失效是幂等的，多调一次没有代价。
   */
  public invalidateSession(sessionId: LooseOptional<string>): void {
    const key = sessionId?.trim();
    if (!key) return;

    this.cachedIndexBySession.delete(key);
    this.indexBuildTelemetryBySession.delete(key);
    // 在飞的那次 load 也要摘掉合流表：留着的话紧随其后的查询会 await 到一份基于旧数据的快照。
    this.pendingIndexLoads.delete(key);
  }

  /**
   * 加载会话检索索引的核心路径（member=session：索引按 sessionId 唯一）。
   *
   * 0. 采集当前源指纹；与内存缓存一致则直接复用（省掉整份索引的读盘 + 解析）
   * 1. indexStore.loadFresh(sessionId) — 磁盘有且未过期则直接返回
   * 2. 否则 indexBuilder.build → indexStore.save（save 失败仍返回内存 snapshot）
   * 3. 写入 indexBuildTelemetryBySession 供 diagnostics
   */
  private async loadRetrievalIndex(
    sessionId: string,
  ): Promise<ChatContextRetrievalIndexSnapshot> {
    const normalizedSessionId = sessionId.trim();
    const pending = this.pendingIndexLoads.get(normalizedSessionId);
    if (pending) return pending;

    const load = this.loadRetrievalIndexUncoalesced(
      normalizedSessionId,
    ).finally(() => {
      this.pendingIndexLoads.delete(normalizedSessionId);
    });
    this.pendingIndexLoads.set(normalizedSessionId, load);
    return load;
  }

  private async loadRetrievalIndexUncoalesced(
    normalizedSessionId: string,
  ): Promise<ChatContextRetrievalIndexSnapshot> {
    // **构建之前**采样：build 读完数据后才取指纹，会把构建期间落盘的新 blob 算进指纹却不放进
    // 快照，之后每次 loadFresh 都判 fresh，那条工具结果永久漏检索（审计 U7）。
    const fingerprint = await this.readIndexSourceFingerprint(
      normalizedSessionId,
    );
    const cached = this.cachedIndexBySession.get(normalizedSessionId);
    if (
      cached &&
      this.isServiceableCachedIndex(cached, normalizedSessionId) &&
      contextRetrievalFingerprintsEqual(cached.fingerprint, fingerprint)
    ) {
      this.indexBuildTelemetryBySession.set(normalizedSessionId, {
        lastLoadSource: "fresh-index",
        lastBuildDurationMs: null,
        lastBuiltAt: cached.snapshot.builtAt,
      });
      return cached.snapshot;
    }

    const freshIndex = await this.indexStore
      .loadFresh(normalizedSessionId)
      .catch(() => null);
    if (freshIndex) {
      this.cacheRetrievalIndex(
        normalizedSessionId,
        freshIndex,
        freshIndex.sourceFingerprint,
      );
      this.indexBuildTelemetryBySession.set(normalizedSessionId, {
        lastLoadSource: "fresh-index",
        lastBuildDurationMs: null,
        lastBuiltAt: freshIndex.builtAt,
      });
      return freshIndex;
    }

    const buildStartedAt = Date.now();
    const rebuiltIndex = await this.indexBuilder.build(normalizedSessionId);
    await this.indexStore
      .save(normalizedSessionId, rebuiltIndex, { sourceFingerprint: fingerprint })
      .catch(
        () => undefined /* arch-guard:silent-catch-ok 索引已在内存重建成功；持久化失败只影响下次缓存命中，不应让本次召回失败。 */,
      );
    this.cacheRetrievalIndex(normalizedSessionId, rebuiltIndex, fingerprint);
    this.indexBuildTelemetryBySession.set(normalizedSessionId, {
      lastLoadSource: "rebuilt-index",
      lastBuildDurationMs: Date.now() - buildStartedAt,
      lastBuiltAt: rebuiltIndex.builtAt,
    });
    return rebuiltIndex;
  }

  /** 宿主未实现指纹端口时返回 null：缓存与"传旧指纹"两项优化一起退化，行为回到端口之前。 */
  private async readIndexSourceFingerprint(
    sessionId: string,
  ): Promise<Nullable<ChatContextRetrievalIndexSourceFingerprint>> {
    const read = this.indexStore.readSourceFingerprint;
    if (!read) return null;

    return toNullable(
      await read
        .call(this.indexStore, sessionId)
        .catch(
          () => null /* arch-guard:silent-catch-ok 指纹是缓存判据，读不到就当"不可缓存"继续走磁盘路径。 */,
        ),
    );
  }

  /**
   * 缓存条目自校验：快照的身份与 schema 版本必须与当前要的这一份对得上。
   *
   * 指纹只回答"源变没变"，回答不了"这份快照是谁的、还是不是当前结构"。同一 sessionId 复用、
   * 或索引 schema 升级后旧条目继续服役，都是零报错的静默错答（审计 R8）。
   */
  private isServiceableCachedIndex(
    cached: CachedRetrievalIndex,
    sessionId: string,
  ): boolean {
    return (
      cached.snapshot.sessionId === sessionId &&
      cached.snapshot.version === ChatContextRetrievalIndexVersion
    );
  }

  private cacheRetrievalIndex(
    sessionId: string,
    snapshot: ChatContextRetrievalIndexSnapshot,
    fingerprint: Nullable<ChatContextRetrievalIndexSourceFingerprint>,
  ): void {
    // 指纹缺席（或三项全空）时不缓存：没有新鲜度判据的缓存等于把陈旧索引钉死在内存里。
    if (!contextRetrievalFingerprintIsComparable(fingerprint) || !fingerprint) return;

    this.cachedIndexBySession.set(sessionId, { fingerprint, snapshot });
  }

  private selectTerminalOutputPayloadCandidates(input: {
    toolPayloads: ChatContextRetrievalIndexToolPayload[];
    query: string;
    terms: string[];
  }): ChatContextRetrievalIndexToolPayload[] {
    const withLogs = input.toolPayloads.filter(
      (toolPayload) => !isEmpty(toolPayload.logReferences),
    );
    if (withLogs.length <= this.terminalOutputPayloadCandidateLimit)
      return withLogs;

    const ranked = withLogs.map((toolPayload) => {
      const referenceText = toolPayload.logReferences
        .map((reference) => `${reference.path}\n${reference.source}`)
        .join("\n");
      const ranking = chatSearchRanking.rankContextText({
        query: input.query,
        terms: input.terms,
        text: `${toolPayload.searchableText}\n${referenceText}`,
      });
      return { toolPayload, ranking };
    });
    const matched = ranked.filter(
      (item) => item.ranking.score > 0 || item.ranking.semanticScore > 0,
    );
    const candidates = isEmpty(matched) ? ranked : matched;

    return candidates
      .sort((left, right) => {
        if (right.ranking.score !== left.ranking.score)
          return right.ranking.score - left.ranking.score;
        return compareStableStrings(
          left.toolPayload.handleId,
          right.toolPayload.handleId,
        );
      })
      .slice(0, this.terminalOutputPayloadCandidateLimit)
      .map((item) => item.toolPayload);
  }

  private buildEmptySearchRetryHints(input: {
    kind: "conversation-history" | "terminal-output";
    matchedCount: number;
    totalCandidates: number;
  }): string[] {
    if (input.matchedCount > 0) return [];

    const hints = [
      "0 条召回不代表事件没有发生；只表示当前已索引范围和本次 query 没命中。",
      "请换用更少、更罕见的文件名、符号名、错误指纹或用户原话关键词重新搜索。",
    ];

    if (input.totalCandidates <= 0) {
      hints.push(
        input.kind === "terminal-output"
          ? "当前会话没有可搜索的内部终端日志引用；需要命令输出时应先确认相关工具结果是否保存了 logPath。"
          : "当前会话还没有可搜索的历史消息；需要当前状态时请改用对应的注入检查能力。",
      );
    }

    if (input.kind === "terminal-output") {
      hints.push(
        "terminal 搜索只覆盖内部命令日志；如果要找对话结论、普通工具摘要或保存 payload，请用 context:recall kind=conversation/all 或按 ref 精确取回。",
      );
    } else {
      hints.push(
        "conversation 搜索只覆盖已索引聊天记录；如果要找命令输出或测试日志，请用 context:recall kind=terminal/all。",
      );
    }

    return hints;
  }

  private combineSearchWarnings(
    traceWarning: LooseOptional<string>,
    retryHints: string[],
  ): LooseOptional<string> {
    const parts = [traceWarning, ...retryHints].filter((part): part is string =>
      Boolean(part?.trim()),
    );

    return isEmpty(parts) ? null : parts.join(" ");
  }

  private async readReferencedLogsOnce(input: {
    references: ReferencedLogPath[];
    cacheByPath: Map<string, LogReadSnippet>;
    totalBudgetChars: number;
  }): Promise<LogReadSnippet[]> {
    const references = input.references.slice(
      0,
      contextRetrievalReferences.maxReferencedLogs,
    );
    const missingReferences = references.filter(
      (reference) => !input.cacheByPath.has(reference.path),
    );
    if (!isEmpty(missingReferences)) {
      const missingSnippets = await this.referenceReader.readReferencedLogs(
        missingReferences,
        input.totalBudgetChars,
      );
      for (const snippet of missingSnippets) {
        input.cacheByPath.set(snippet.path, snippet);
      }
    }

    return references
      .map((reference): Nullable<LogReadSnippet> => {
        const snippet = input.cacheByPath.get(reference.path);
        if (!snippet) return null;

        return {
          ...snippet,
          source: reference.source,
        };
      })
      .filter((snippet): snippet is LogReadSnippet => isNotNull(snippet));
  }

  private resolveRetrievalScopeId(
    sessionId: string,
    retrievalScopeId: LooseOptional<string>,
    lineage: LooseOptional<SessionLineageContext>,
  ): string {
    const baseScope = retrievalScopeId?.trim() || sessionId;
    const lineageScope = this.buildLineageScopeKey(sessionId, lineage);
    return [baseScope, lineageScope]
      .filter((item): item is string => !!item)
      .join(":");
  }

  private buildLineageScopeKey(
    sessionId: string,
    lineage: LooseOptional<SessionLineageContext>,
  ): Nullable<string> {
    const lineageSessionId = lineage?.sessionId?.trim();
    if (!lineage || !lineageSessionId || lineageSessionId !== sessionId)
      return null;

    const branchId =
      normalizeSessionLineageId(lineage.activeBranchId) || "branch:unknown";
    const checkpointId =
      normalizeSessionLineageId(lineage.activeCheckpointId) || "head";
    const cutoffTimestamp = numberOrNull(lineage.cutoffTimestamp);
    const cutoff = isPositiveNumber(cutoffTimestamp)
      ? String(cutoffTimestamp)
      : "none";
    const visibleBranchKey = normalizeSessionLineageIdList(
      lineage.visibleBranchIds,
    ).join(",");

    return [
      `branch=${branchId}`,
      `checkpoint=${checkpointId}`,
      `cutoff=${cutoff}`,
      `visible=${visibleBranchKey}`,
    ].join("|");
  }

  private normalizeLimit(
    value: LooseOptional<number>,
    fallback: number,
  ): number {
    if (!isFiniteNumber(value)) return fallback;

    return Math.max(1, Math.floor(value));
  }
}

export { ChatContextRetrievalService, type ChatContextRetrievalServiceOptions };
