import { isFiniteNumber } from '@velaros-ai/core'
import type {
  ChatContextRetrievalQueryKind,
  ChatContextRetrievalQueryTraceEntry,
} from '@velaros-ai/core/types'

import { chatSearchRanking } from './search/Ranking'
import { ContextRetrievalBoundedCounter } from './BoundedRecentMap'

const DefaultMaxRecentQueryTracesPerSession = 24
const DefaultMaxQueryCountEntries = 4_096

interface ContextRetrievalQueryTraceStoreOptions {
  maxQueryCountEntries?: LooseOptional<number>
  maxRecentQueryTracesPerSession?: LooseOptional<number>
}

/**
 * {@link ContextRetrievalQueryTraceStore.register} 的返回值。
 * 由 search* 方法持有并传入 {@link ContextRetrievalQueryTraceStore.record}。
 */
interface RetrievalQueryRegistration {
  /** 与 register 入参一致，回传便于 record 写 trace。 */
  retrievalScopeId: string
  /** normalizeQuerySignature 结果，用于 trace 展示与去重键。 */
  normalizedQuery: string
  /** 本 scope 内该 query 第几次搜索（从 1 起）。 */
  retrievalCount: number
  /** retrievalCount > 1。 */
  repeated: boolean
}

/**
 * 单次 `agent` **`retrievalScope`** 内的搜索 `query` 计数与 `trace` 环形缓冲。
 *
 * ## 与 `retrievalCounts` 的分工
 * - 本 `Store`：按 **query 文本**（`conversation-history` / `terminal-output`）去重
 * - {@link ChatContextRetrievalService.retrievalCounts}：按 **`handle` / `evidenceId`** 去重
 *
 * ## `Map` 键格式
 * `{sessionId}:{retrievalScopeId}:{kind}:{normalizedQuery}`
 *
 * `retrievalScopeId` 通常等于 `sessionId`，也可由 `agent` 传入子 `scope`（如单次 `tool` 执行 `id`）。
 *
 * 每 `Service` 实例一个 `Store`；进程重启后计数清零。
 */
class ContextRetrievalQueryTraceStore {
  /** 每个 session 保留的最近 trace 条数（环形队列 tail）。 */
  private readonly maxRecentQueryTracesPerSession: number
  /** retrievalCount 达到此值时在 trace.warning 提示重复搜索。 */
  private readonly repeatedSearchWarningThreshold = 2

  /** 键 → 累计搜索次数（进程内，不持久化）。 */
  private readonly queryCounts: ContextRetrievalBoundedCounter
  /** sessionId → 最近 trace 列表（最多 maxRecentQueryTracesPerSession）。 */
  private readonly recentQueryTracesBySession = new Map<string, ChatContextRetrievalQueryTraceEntry[]>()

  constructor(options: ContextRetrievalQueryTraceStoreOptions = {}) {
    this.maxRecentQueryTracesPerSession = this.normalizeLimit(
      options.maxRecentQueryTracesPerSession,
      DefaultMaxRecentQueryTracesPerSession
    )
    this.queryCounts = new ContextRetrievalBoundedCounter(
      this.normalizeLimit(options.maxQueryCountEntries, DefaultMaxQueryCountEntries)
    )
  }

  /**
   * 在 search* **开始前**调用：递增计数并返回 registration。
   *
   * @param input.kind `conversation-history` | `terminal-output`
   * @param input.terms 已由 normalizeSearchTerms 处理
   */
  public register(input: {
    sessionId: string
    retrievalScopeId: string
    kind: ChatContextRetrievalQueryKind
    query: string
    terms: string[]
  }): RetrievalQueryRegistration {
    const normalizedQuery = chatSearchRanking.normalizeQuerySignature(input.query, input.terms)
    const key = [
      input.sessionId,
      input.retrievalScopeId,
      input.kind,
      normalizedQuery,
    ].join(':')
    const retrievalCount = this.queryCounts.increment(key)

    return {
      retrievalScopeId: input.retrievalScopeId,
      normalizedQuery,
      retrievalCount,
      repeated: retrievalCount > 1,
    }
  }

  /**
   * 在 `search*` **结束后**调用：组装 `trace` 并追加到 `session` 环形队列。
   *
   * @param input.totalCandidates 搜索空间大小（`history`=消息总数，`terminal`=`logReference` 总数）
   * @param input.matchedCount `semanticScore>0` 的条数（含未返回的）
   * @param input.matchedScores 全部命中项 `score`，供 `scoreStats` 分桶
   * @param input.returnedItems 实际返回给调用方的 `top items`（含 `handleId`、`score`、`matchReasons`）
   */
  public record(input: {
    sessionId: string
    retrievalScopeId: string
    kind: ChatContextRetrievalQueryKind
    query: string
    registration: RetrievalQueryRegistration
    totalCandidates: number
    matchedCount: number
    matchedScores: number[]
    returnedItems: Array<{
      handleId: string
      score: number
      matchReasons: string[]
    }>
  }): ChatContextRetrievalQueryTraceEntry {
    const repeatedWarning = input.registration.retrievalCount >=
      this.repeatedSearchWarningThreshold
      ? '当前执行范围内已搜索过该检索查询；请使用已返回的 handle/证据 ID，或通过新的文件路径、符号或错误指纹收窄查询。'
      : null
    const trace: ChatContextRetrievalQueryTraceEntry = {
      id: `retrieval-query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: input.sessionId,
      retrievalScopeId: input.retrievalScopeId,
      kind: input.kind,
      query: input.query,
      normalizedQuery: input.registration.normalizedQuery,
      requestedAt: Date.now(),
      repeated: input.registration.repeated,
      retrievalCount: input.registration.retrievalCount,
      totalCandidates: input.totalCandidates,
      matchedCount: input.matchedCount,
      returnedCount: input.returnedItems.length,
      topScore: input.returnedItems[0]?.score,
      topHandleIds: input.returnedItems.slice(0, 6).map((item) => item.handleId),
      matchReasons: [
        ...new Set(input.returnedItems.flatMap((item) => item.matchReasons)),
      ].slice(0, 10),
      scoreStats: chatSearchRanking.buildRetrievalScoreStats(input.matchedScores),
      warning: repeatedWarning,
    }
    const traces = this.recentQueryTracesBySession.get(input.sessionId) ?? []
    this.recentQueryTracesBySession.set(
      input.sessionId,
      [...traces, trace].slice(-this.maxRecentQueryTracesPerSession)
    )
    return trace
  }

  /**
   * 供 diagnostics 返回最近搜索 trace；无记录时 []。
   */
  public getRecent(sessionId: string): ChatContextRetrievalQueryTraceEntry[] {
    return this.recentQueryTracesBySession.get(sessionId.trim()) ?? []
  }

  private normalizeLimit(value: LooseOptional<number>, fallback: number): number {
    if (!isFiniteNumber(value)) return fallback

    return Math.max(1, Math.floor(value))
  }
}

export {
  ContextRetrievalQueryTraceStore,
  type ContextRetrievalQueryTraceStoreOptions,
  type RetrievalQueryRegistration,
}
