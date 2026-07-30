import { isEmpty, isFiniteNumber,isNotNull, isPositiveNumber, numberOrNull, toNullable } from '@velaros-ai/core'
import type {
  ChatContextReadEvidenceRequest,
  ChatContextReadEvidenceResult,
  ChatContextReadToolPayloadRequest,
  ChatContextRetrievalIndexDiagnostics,
  ChatContextRetrievalIndexLoadSource,
  ChatContextRetrievedPayload,
  ChatContextRetrievePayloadRequest,
  ChatContextSearchConversationHistoryItem,
  ChatContextSearchConversationHistoryRequest,
  ChatContextSearchConversationHistoryResult,
  ChatContextSearchTerminalOutputItem,
  ChatContextSearchTerminalOutputRequest,
  ChatContextSearchTerminalOutputResult,
  SessionLineageContext,
} from '@velaros-ai/core/types'
import {
  normalizeSessionLineageId,
  normalizeSessionLineageIdList,
} from '@velaros-ai/core/utils/sessionLineage'

import type { ContextGovernanceSessionRegistry } from '../residency/ContextGovernanceSession'
import { compareStableStrings } from '../residency/determinism'

import { chatSearchRanking } from './search/Ranking'
import { chatSearchText } from './search/Text'
import {
  ContextRetrievalBoundedCounter,
  ContextRetrievalBoundedRecentMap,
} from './BoundedRecentMap'
import { ContextRetrievalIndexBuilder } from './IndexBuilder'
import {
  type ChatContextRetrievalIndexSnapshot,
  type ChatContextRetrievalIndexStore,
} from './IndexSnapshot'
import { ContextRetrievalPayloadReader } from './PayloadReader'
import {
  ContextRetrievalQueryTraceStore,
  type ContextRetrievalQueryTraceStoreOptions,
} from './QueryTraceStore'
import { ContextRetrievalReferenceReader } from './ReferenceReader'
import {
  contextRetrievalReferences,
  type LogReadSnippet,
  type ReferencedLogPath,
} from './References'
import type {
  RetrievalPayloadStorePort,
  RetrievalStateStorePort,
} from './sessionStorePorts'

const DefaultRetrievalCountEntryLimit = 4_096
const DefaultIndexBuildTelemetrySessionLimit = 512
const DefaultTerminalOutputPayloadCandidateLimit = 64

type ChatContextRetrievalIndexToolPayload =
  ChatContextRetrievalIndexSnapshot['toolPayloads'][number]

interface ChatContextRetrievalServiceOptions {
  maxRetrievalCountEntries?: LooseOptional<number>
  maxIndexBuildTelemetrySessions?: LooseOptional<number>
  maxTerminalOutputPayloadCandidates?: LooseOptional<number>
  queryTrace?: ContextRetrievalQueryTraceStoreOptions
}

/**
 * 单次 loadRetrievalIndex 的构建遥测，合并进 diagnostics。
 */
interface RetrievalIndexBuildTelemetry {
  /** 本次命中 fresh 磁盘索引还是内存 rebuild。 */
  lastLoadSource: ChatContextRetrievalIndexLoadSource
  /** rebuild 耗时 ms；loadFresh 命中时为 null。 */
  lastBuildDurationMs: LooseOptional<number>
  /** 索引 snapshot.builtAt。 */
  lastBuiltAt: LooseOptional<number>
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
  private readonly retrievalCounts: ContextRetrievalBoundedCounter

  /** 搜索 query  trace 与重复 search 检测。 */
  private readonly queryTraceStore: ContextRetrievalQueryTraceStore

  /** 日志/artifact 读盘。 */
  private readonly referenceReader = new ContextRetrievalReferenceReader()

  /** 索引构建（messages + toolPayloads + evidence）。 */
  private readonly indexBuilder: ContextRetrievalIndexBuilder

  /** handle → 正文展开。 */
  private readonly payloadReader: ContextRetrievalPayloadReader

  /** sessionId → 最近一次索引 load/rebuild 遥测。 */
  private readonly indexBuildTelemetryBySession: ContextRetrievalBoundedRecentMap<RetrievalIndexBuildTelemetry>
  /** sessionId → 正在进行的 loadFresh/rebuild，避免并发查询重复构建同一索引。 */
  private readonly pendingIndexLoads = new Map<string, Promise<ChatContextRetrievalIndexSnapshot>>()
  private readonly terminalOutputPayloadCandidateLimit: number

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
    options: ChatContextRetrievalServiceOptions = {}
  ) {
    this.retrievalCounts = new ContextRetrievalBoundedCounter(
      this.normalizeLimit(options.maxRetrievalCountEntries, DefaultRetrievalCountEntryLimit)
    )
    this.queryTraceStore = new ContextRetrievalQueryTraceStore(options.queryTrace)
    this.indexBuildTelemetryBySession = new ContextRetrievalBoundedRecentMap(
      this.normalizeLimit(
        options.maxIndexBuildTelemetrySessions,
        DefaultIndexBuildTelemetrySessionLimit
      )
    )
    this.terminalOutputPayloadCandidateLimit = this.normalizeLimit(
      options.maxTerminalOutputPayloadCandidates,
      DefaultTerminalOutputPayloadCandidateLimit
    )
    this.indexBuilder = new ContextRetrievalIndexBuilder(payloadStore, stateStore)
    this.payloadReader = new ContextRetrievalPayloadReader(
      payloadStore,
      stateStore,
      this.referenceReader
    )
  }

  /**
   * 按动态上下文 **`handle`** 拉取完整 `payload` 正文。
   *
   * `Handle` 分发：
   * - `tool:*` / `ctx-payload:*` → `PayloadReader.retrieveToolPayload`
   * - `message:*` → `PayloadReader.retrieveMessagePayload`
   * - 其它 → `found=false`, `kind=unknown`
   *
   * `retrievalScopeId` 默认 `sessionId`；同一 `scope` 内重复请求同一 `handle` 会告警。
   */
  public async retrieveContextPayload(
    request: ChatContextRetrievePayloadRequest
  ): Promise<ChatContextRetrievedPayload> {
    const sessionId = request.sessionId.trim()
    const handleId = request.handleId.trim()
    const jsonPath = request.jsonPath?.trim() || null
    const retrievalScopeId = this.resolveRetrievalScopeId(
      sessionId,
      request.retrievalScopeId,
      request.sessionLineage
    )
    const maxChars = chatSearchText.clampMaxChars(request.maxChars)
    const offset = Math.max(0, Math.round(request.offset ?? 0))
    // offset 纳入去重键:分页续读不是重复检索,不该吃 repeated 告警。
    const countKey = `${sessionId}:${retrievalScopeId}:${handleId}:${jsonPath ?? ''}:${offset}`
    const retrievalCount = this.retrievalCounts.increment(countKey)
    const repeated = retrievalCount > 1

    // member=session：会话即资源作用域，工具 payload handle 不再做跨 context 可见性闸门；
    // 直接展开（句柄无效时 payloadReader 自然返回 found=false）。
    if (handleId.startsWith('tool:') || handleId.startsWith('ctx-payload:')) {
      const payload = await this.payloadReader.retrieveToolPayload({
        sessionId,
        handleId,
        retrievalScopeId,
        maxChars,
        jsonPath,
        offset,
        repeated,
        retrievalCount,
      })
      if (payload.found) this.governanceSessions.recordFault(sessionId, handleId)
      return payload
    }

    if (handleId.startsWith('message:')) {
      const payload = await this.payloadReader.retrieveMessagePayload({
        sessionId,
        handleId,
        retrievalScopeId,
        maxChars,
        repeated,
        retrievalCount,
      })
      if (payload.found) this.governanceSessions.recordFault(sessionId, handleId)
      return payload
    }

    // 铁律1:匹配失败必须列出有效项供自纠,并自动把 ref 当 query 兜底搜一轮——
    // 把"召回失败→模型盲猜重试"的抖动收敛成一次往返。
    const validHandleSamples = await this.listValidHandleSamples(sessionId)
    const fallbackSearch = await this.searchConversationHistory({
      sessionId,
      query: handleId,
      maxResults: 3,
    }).catch(() => null)
    return {
      handleId,
      sessionId,
      found: false,
      kind: 'unknown',
      content: null,
      repeated,
      retrievalCount,
      warning: [
        '未知的动态上下文 handle。',
        validHandleSamples.length
          ? `当前会话有效句柄样本(最多10条):${validHandleSamples.join('、')}`
          : null,
        fallbackSearch?.items?.length
          ? '已自动按该 ref 关键词搜索历史,见 fallbackSearch。'
          : null,
      ]
        .filter((item): item is string => Boolean(item))
        .join(' '),
      ...(fallbackSearch?.items?.length ? { metadata: { fallbackSearch: fallbackSearch.items } } : {}),
    }
  }

  /** 有效句柄样本(≤10):动态工具 payload handle + evidence id,供召回失败时模型自纠。 */
  private async listValidHandleSamples(sessionId: string): Promise<string[]> {
    try {
      const index = await this.loadRetrievalIndex(sessionId)
      const payloadHandles = index.toolPayloads.slice(-6).map((entry) => entry.handleId)
      const evidenceIds = index.evidence.slice(-4).map((record) => record.id)
      return [...payloadHandles, ...evidenceIds].slice(0, 10)
    } catch {
      return []
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
    request: ChatContextSearchConversationHistoryRequest
  ): Promise<ChatContextSearchConversationHistoryResult> {
    const sessionId = request.sessionId.trim()
    const query = request.query.trim()
    const retrievalScopeId = this.resolveRetrievalScopeId(
      sessionId,
      request.retrievalScopeId,
      request.sessionLineage
    )
    const maxResults = chatSearchText.clampMaxResults(request.maxResults)
    const maxChars = chatSearchText.clampMaxChars(request.maxChars)
    const terms = chatSearchRanking.normalizeSearchTerms(query)
    const queryRegistration = this.queryTraceStore.register({
      sessionId,
      retrievalScopeId,
      kind: 'conversation-history',
      query,
      terms,
    })
    const index = await this.loadRetrievalIndex(sessionId)
    const totalMessages = index.messages.length

    const matchedItems = index.messages
      .map((message): LooseOptional<ChatContextSearchConversationHistoryItem> => {
        const ranking = chatSearchRanking.rankContextText({
          query,
          terms,
          text: message.searchableText,
          index: message.messageIndex,
          total: totalMessages,
        })
        if (ranking.semanticScore <= 0 && !isEmpty(terms)) return null

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
          summary: chatSearchText.truncate(message.summary, Math.min(240, maxChars)),
          matchedText: toNullable(
            chatSearchRanking.buildSearchSnippet(
              message.text || message.searchableText,
              terms,
              Math.min(900, maxChars)
            )
          ),
          toolNames: message.toolNames,
        }
      })
      .filter((item): item is ChatContextSearchConversationHistoryItem => Boolean(item))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score

        return right.messageIndex - left.messageIndex
      })
    const items = matchedItems.slice(0, maxResults)
    const trace = this.queryTraceStore.record({
      sessionId,
      retrievalScopeId,
      kind: 'conversation-history',
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
    })
    const retryHints = this.buildEmptySearchRetryHints({
      kind: 'conversation-history',
      matchedCount: matchedItems.length,
      totalCandidates: totalMessages,
    })

    return {
      sessionId,
      query,
      totalMessages: index.messages.length,
      items,
      trace,
      retryHints: isEmpty(retryHints) ? undefined : retryHints,
      warning: this.combineSearchWarnings(trace.warning, retryHints),
    }
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
    request: ChatContextReadEvidenceRequest
  ): Promise<ChatContextReadEvidenceResult> {
    const sessionId = request.sessionId.trim()
    const evidenceId = request.evidenceId.trim()
    const retrievalScopeId = this.resolveRetrievalScopeId(
      sessionId,
      request.retrievalScopeId,
      request.sessionLineage
    )
    const maxChars = chatSearchText.clampMaxChars(request.maxChars)
    const countKey = `${sessionId}:${retrievalScopeId}:evidence:${evidenceId}`
    const retrievalCount = this.retrievalCounts.increment(countKey)
    const repeated = retrievalCount > 1
    const index = await this.loadRetrievalIndex(sessionId)
    const evidence = index.evidence.find((record) => record.id === evidenceId)

    if (!evidence) {
      // 铁律1:miss 必须列有效项。证据集通常很小,直接回带 {id, kind, path} 样本供自纠。
      const samples = index.evidence
        .slice(-8)
        .map((record) => `${record.id}(${record.kind}${record.path ? `:${record.path}` : ''})`)
      return {
        sessionId,
        evidenceId,
        found: false,
        evidence: null,
        payloadHandleId: null,
        repeated,
        retrievalCount,
        warning: [
          '未在活跃 Context OS 视图或运行时账本中找到该证据。',
          samples.length ? `当前有效证据样本:${samples.join('、')}` : null,
        ]
          .filter((item): item is string => Boolean(item))
          .join(' '),
      }
    }

    const stale = evidence.lifecycle === 'stale' || evidence.lifecycle === 'reread-required'
    const payloadHandleId = this.payloadReader.resolveEvidencePayloadHandle(evidence)
    const repeatedWarning = repeated
      ? '当前执行范围内已读过该证据；请使用已返回记录或其 payload handle，勿重复读取。'
      : null
    const warning = [
      stale
        ? '该证据已过期或需要重读；在依赖旧摘录前请通过注入能力重新读取来源。'
        : null,
      repeatedWarning,
    ]
      .filter((item): item is string => Boolean(item))
      .join(' ')

    return {
      sessionId,
      evidenceId,
      found: true,
      evidence: {
        ...evidence,
        excerpt: evidence.excerpt ? chatSearchText.truncate(evidence.excerpt, maxChars) : evidence.excerpt,
      },
      payloadHandleId: toNullable(payloadHandleId),
      repeated,
      retrievalCount,
      warning: warning ? warning : null,
    }
  }

  /**
   * 便捷 API：用 payloadRef 或 toolCallId 构造 handle 并调用 retrieveContextPayload。
   * payloadRef 优先于 toolCallId。
   */
  public async readToolPayload(
    request: ChatContextReadToolPayloadRequest
  ): Promise<ChatContextRetrievedPayload> {
    const payloadRef = request.payloadRef?.trim()
    const toolCallId = request.toolCallId?.trim()

    return this.retrieveContextPayload({
      sessionId: request.sessionId,
      // 防御:调用方可能已带 tool: 前缀(如模型把折叠桩里的完整 handle 当 toolCallId 传),
      // 盲加前缀会变 tool:tool:* 永远 miss。
      handleId:
        payloadRef ||
        (toolCallId?.startsWith('tool:') ? toolCallId : `tool:${toolCallId ?? ''}`),
      jsonPath: request.jsonPath,
      offset: request.offset,
      retrievalScopeId: request.retrievalScopeId,
      sessionLineage: request.sessionLineage,
      reason: request.reason ?? '读取指定已保存工具 payload',
      maxChars: request.maxChars,
    })
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
    request: ChatContextSearchTerminalOutputRequest
  ): Promise<ChatContextSearchTerminalOutputResult> {
    const sessionId = request.sessionId.trim()
    const query = request.query.trim()
    const retrievalScopeId = this.resolveRetrievalScopeId(
      sessionId,
      request.retrievalScopeId,
      request.sessionLineage
    )
    const terms = chatSearchRanking.normalizeSearchTerms(query)
    const queryRegistration = this.queryTraceStore.register({
      sessionId,
      retrievalScopeId,
      kind: 'terminal-output',
      query,
      terms,
    })
    const maxResults = chatSearchText.clampMaxResults(request.maxResults)
    const maxChars = chatSearchText.clampMaxChars(request.maxChars)
    const index = await this.loadRetrievalIndex(sessionId)
    const items: ChatContextSearchTerminalOutputItem[] = []
    const logSnippetByPath = new Map<string, LogReadSnippet>()
    const payloadCandidates = this.selectTerminalOutputPayloadCandidates({
      toolPayloads: index.toolPayloads,
      query,
      terms,
    })

    for (const toolPayload of payloadCandidates) {
      const snippets = await this.readReferencedLogsOnce({
        references: toolPayload.logReferences,
        cacheByPath: logSnippetByPath,
        totalBudgetChars: maxChars,
      })
      for (const snippet of snippets) {
        const haystack = [
          toolPayload.searchableText,
          snippet.path,
          snippet.source,
          snippet.content ?? '',
        ].join('\n')
        const ranking = chatSearchRanking.rankContextText({
          query,
          terms,
          text: haystack,
        })
        if (ranking.semanticScore <= 0 && !isEmpty(terms)) {
          continue
        }

        items.push({
          handleId: toolPayload.handleId,
          toolCallId: toolPayload.toolCallId,
          logPath: snippet.path,
          source: snippet.source,
          score: ranking.score,
          matchReasons: ranking.matchReasons,
          snippet: chatSearchRanking.buildSearchSnippet(snippet.content ?? snippet.path, terms, Math.min(1_500, maxChars)) ?? '',
          truncated: snippet.truncated,
          warning: snippet.warning,
        })
      }
    }
    const sortedItems = items.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score

      return compareStableStrings(left.logPath, right.logPath)
    })
    const returnedItems = sortedItems.slice(0, maxResults)
    const totalLogReferences = index.toolPayloads.reduce(
      (total, toolPayload) => total + toolPayload.logReferences.length,
      0
    )
    const trace = this.queryTraceStore.record({
      sessionId,
      retrievalScopeId,
      kind: 'terminal-output',
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
    })
    const retryHints = this.buildEmptySearchRetryHints({
      kind: 'terminal-output',
      matchedCount: sortedItems.length,
      totalCandidates: totalLogReferences,
    })

    return {
      sessionId,
      query,
      items: returnedItems,
      trace,
      retryHints: isEmpty(retryHints) ? undefined : retryHints,
      warning: this.combineSearchWarnings(trace.warning, retryHints),
    }
  }

  /**
   * 返回索引诊断：新鲜度、构建来源/耗时、recentQueries。
   * 若 indexStore 报告 !fresh，会先 loadRetrievalIndex 触发 rebuild 再读 diagnostics。
   */
  public async getRetrievalIndexDiagnostics(
    sessionId: string
  ): Promise<Nullable<ChatContextRetrievalIndexDiagnostics>> {
    const normalizedSessionId = sessionId.trim()

    let diagnostics = await (this.indexStore.getDiagnostics?.(normalizedSessionId))
    if (!diagnostics) return null

    if (!diagnostics.fresh) {
      await this.loadRetrievalIndex(normalizedSessionId)
      diagnostics = (await this.indexStore.getDiagnostics?.(normalizedSessionId)) ?? diagnostics
    }

    const telemetry = this.indexBuildTelemetryBySession.get(normalizedSessionId)

    return {
      ...diagnostics,
      lastLoadSource: telemetry?.lastLoadSource ?? diagnostics.lastLoadSource,
      lastBuildDurationMs: telemetry?.lastBuildDurationMs ?? diagnostics.lastBuildDurationMs,
      lastBuiltAt: telemetry?.lastBuiltAt ?? diagnostics.lastBuiltAt,
      recentQueries: this.queryTraceStore.getRecent(normalizedSessionId),
    }
  }

  /**
   * 加载会话检索索引的核心路径（member=session：索引按 sessionId 唯一）。
   *
   * 1. indexStore.loadFresh(sessionId) — 磁盘有且未过期则直接返回
   * 2. 否则 indexBuilder.build → indexStore.save（save 失败仍返回内存 snapshot）
   * 3. 写入 indexBuildTelemetryBySession 供 diagnostics
   */
  private async loadRetrievalIndex(
    sessionId: string
  ): Promise<ChatContextRetrievalIndexSnapshot> {
    const normalizedSessionId = sessionId.trim()
    const pending = this.pendingIndexLoads.get(normalizedSessionId)
    if (pending) return pending

    const load = this.loadRetrievalIndexUncoalesced(normalizedSessionId).finally(() => {
      this.pendingIndexLoads.delete(normalizedSessionId)
    })
    this.pendingIndexLoads.set(normalizedSessionId, load)
    return load
  }

  private async loadRetrievalIndexUncoalesced(
    normalizedSessionId: string
  ): Promise<ChatContextRetrievalIndexSnapshot> {
    const freshIndex = await this.indexStore.loadFresh(normalizedSessionId).catch(() => null)
    if (freshIndex) {
      this.indexBuildTelemetryBySession.set(normalizedSessionId, {
        lastLoadSource: 'fresh-index',
        lastBuildDurationMs: null,
        lastBuiltAt: freshIndex.builtAt,
      })
      return freshIndex
    }

    const buildStartedAt = Date.now()
    const rebuiltIndex = await this.indexBuilder.build(normalizedSessionId)
    await this.indexStore.save(normalizedSessionId, rebuiltIndex).catch(() => undefined)
    this.indexBuildTelemetryBySession.set(normalizedSessionId, {
      lastLoadSource: 'rebuilt-index',
      lastBuildDurationMs: Date.now() - buildStartedAt,
      lastBuiltAt: rebuiltIndex.builtAt,
    })
    return rebuiltIndex
  }

  private selectTerminalOutputPayloadCandidates(input: {
    toolPayloads: ChatContextRetrievalIndexToolPayload[]
    query: string
    terms: string[]
  }): ChatContextRetrievalIndexToolPayload[] {
    const withLogs = input.toolPayloads.filter((toolPayload) => !isEmpty(toolPayload.logReferences))
    if (withLogs.length <= this.terminalOutputPayloadCandidateLimit) return withLogs

    const ranked = withLogs.map((toolPayload) => {
      const referenceText = toolPayload.logReferences
        .map((reference) => `${reference.path}\n${reference.source}`)
        .join('\n')
      const ranking = chatSearchRanking.rankContextText({
        query: input.query,
        terms: input.terms,
        text: `${toolPayload.searchableText}\n${referenceText}`,
      })
      return { toolPayload, ranking }
    })
    const matched = ranked.filter(
      (item) => item.ranking.score > 0 || item.ranking.semanticScore > 0
    )
    const candidates = isEmpty(matched) ? ranked : matched

    return candidates
      .sort((left, right) => {
        if (right.ranking.score !== left.ranking.score) return right.ranking.score - left.ranking.score
        return compareStableStrings(left.toolPayload.handleId, right.toolPayload.handleId)
      })
      .slice(0, this.terminalOutputPayloadCandidateLimit)
      .map((item) => item.toolPayload)
  }

  private buildEmptySearchRetryHints(input: {
    kind: 'conversation-history' | 'terminal-output'
    matchedCount: number
    totalCandidates: number
  }): string[] {
    if (input.matchedCount > 0) return []

    const hints = [
      '0 条召回不代表事件没有发生；只表示当前已索引范围和本次 query 没命中。',
      '请换用更少、更罕见的文件名、符号名、错误指纹或用户原话关键词重新搜索。',
    ]

    if (input.totalCandidates <= 0) {
      hints.push(
        input.kind === 'terminal-output'
          ? '当前会话没有可搜索的内部终端日志引用；需要命令输出时应先确认相关工具结果是否保存了 logPath。'
          : '当前会话还没有可搜索的历史消息；需要当前状态时请改用对应的注入检查能力。'
      )
    }

    if (input.kind === 'terminal-output') {
      hints.push(
        'terminal 搜索只覆盖内部命令日志；如果要找对话结论、普通工具摘要或保存 payload，请用 recall_context kind=conversation/all 或按 ref 精确取回。'
      )
    } else {
      hints.push(
        'conversation 搜索只覆盖已索引聊天记录；如果要找命令输出或测试日志，请用 recall_context kind=terminal/all。'
      )
    }

    return hints
  }

  private combineSearchWarnings(
    traceWarning: LooseOptional<string>,
    retryHints: string[]
  ): LooseOptional<string> {
    const parts = [traceWarning, ...retryHints].filter((part): part is string =>
      Boolean(part?.trim())
    )

    return isEmpty(parts) ? null : parts.join(' ')
  }

  private async readReferencedLogsOnce(input: {
    references: ReferencedLogPath[]
    cacheByPath: Map<string, LogReadSnippet>
    totalBudgetChars: number
  }): Promise<LogReadSnippet[]> {
    const references = input.references.slice(0, contextRetrievalReferences.maxReferencedLogs)
    const missingReferences = references.filter((reference) => !input.cacheByPath.has(reference.path))
    if (!isEmpty(missingReferences)) {
      const missingSnippets = await this.referenceReader.readReferencedLogs(
        missingReferences,
        input.totalBudgetChars
      )
      for (const snippet of missingSnippets) {
        input.cacheByPath.set(snippet.path, snippet)
      }
    }

    return references
      .map((reference): Nullable<LogReadSnippet> => {
        const snippet = input.cacheByPath.get(reference.path)
        if (!snippet) return null

        return {
          ...snippet,
          source: reference.source,
        }
      })
      .filter((snippet): snippet is LogReadSnippet => isNotNull(snippet))
  }

  private resolveRetrievalScopeId(
    sessionId: string,
    retrievalScopeId: LooseOptional<string>,
    lineage: LooseOptional<SessionLineageContext>
  ): string {
    const baseScope = retrievalScopeId?.trim() || sessionId
    const lineageScope = this.buildLineageScopeKey(sessionId, lineage)
    return [baseScope, lineageScope].filter((item): item is string => !!item).join(':')
  }

  private buildLineageScopeKey(
    sessionId: string,
    lineage: LooseOptional<SessionLineageContext>
  ): Nullable<string> {
    const lineageSessionId = lineage?.sessionId?.trim()
    if (!lineage || !lineageSessionId || lineageSessionId !== sessionId) return null

    const branchId = normalizeSessionLineageId(lineage.activeBranchId) || 'branch:unknown'
    const checkpointId = normalizeSessionLineageId(lineage.activeCheckpointId) || 'head'
    const cutoffTimestamp = numberOrNull(lineage.cutoffTimestamp)
    const cutoff = isPositiveNumber(cutoffTimestamp) ? String(cutoffTimestamp) : 'none'
    const visibleBranchKey = normalizeSessionLineageIdList(lineage.visibleBranchIds).join(',')

    return [
      `branch=${branchId}`,
      `checkpoint=${checkpointId}`,
      `cutoff=${cutoff}`,
      `visible=${visibleBranchKey}`,
    ].join('|')
  }

  private normalizeLimit(value: LooseOptional<number>, fallback: number): number {
    if (!isFiniteNumber(value)) return fallback

    return Math.max(1, Math.floor(value))
  }
}

export { ChatContextRetrievalService, type ChatContextRetrievalServiceOptions }
