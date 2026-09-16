import type { ChatContextRetrievalQueryKind, ChatContextRetrievalQueryTraceEntry } from '../../types/agent.js'
import type { RetrievalQueryRegistration } from '../../types/retrieval.js'
import { normalizeRetrievalLimit } from '../../utils/retrieval/limits'
import { chatSearchRanking } from '../../utils/retrieval/ranking'
import { AgentTuning } from '../../utils/tuning'

import { ContextRetrievalBoundedCounter } from './ContextRetrievalBoundedCounter'

/** 建 `ContextRetrievalQueryTraceStore` 时给的两个容量上限；两项都可以不传，不传就用本文件的缺省值。 */
interface ContextRetrievalQueryTraceStoreOptions {
  /** 查询计数表最多记多少个键，缺省 4096；键是「会话+scope+kind+归一化查询」，满了按最近使用淘汰，被淘汰的查询重新从 1 数起。 */
  maxQueryCountEntries?: LooseOptional<number>
  /** 每个会话保留多少条最近的 trace，缺省 24；只影响 `getRecent` 能回溯多远，超出的从最旧的丢。 */
  maxRecentQueryTracesPerSession?: LooseOptional<number>
}

/**
 * 搜索查询的计数与 trace 存档对外这一面：搜之前登记一次拿到重复次数，搜完记一条 trace，诊断时把最近几条取回来。
 *
 * 实现是 `ContextRetrievalQueryTraceStore`，每个 `ChatContextRetrievalService` 实例持一个；只在内存里、进程重启清零。
 * 它按 **query 文本**去重（键是 `{sessionId}:{retrievalScopeId}:{kind}:{normalizedQuery}`），跟按 handle/证据 id 去重的 `retrievalCounts` 分工不同。
 */
export interface ContextRetrievalQueryTraceStoreApi {
  /** 在 `search*` 开始前调：按归一化后的查询签名把计数加一，返回这次的 registration（带 `retrievalCount` 和 `repeated`），调用方要原样带到 `record` 里去。 */
  register(input: {
    /** 这次搜索属于哪个会话；trace 按它分桶，`getRecent` 也按它取。 */
    sessionId: string
    /** 去重的作用范围 id：通常等于 sessionId，agent 也可以传更窄的（比如单次工具执行的 id），换一个 scope 计数就从头数。 */
    retrievalScopeId: string
    /** 搜的是哪一类内容：`conversation-history` 还是 `terminal-output`；同样的词在两类里分开计数。 */
    kind: ChatContextRetrievalQueryKind
    /** 用户/模型原样给的查询串，只用来算签名，不做展示。 */
    query: string
    /** 已经过 `normalizeSearchTerms` 拆好的检索词；和 query 一起决定归一化签名，所以换个写法搜同一批词会算成重复。 */
    terms: string[]
  }): RetrievalQueryRegistration
  /** 在 `search*` 结束后调：把这次搜索的规模、命中和返回项组装成一条 trace 追加到该会话的环形队列并返回它；`retrievalCount` 到 2 次起 trace 里会带上「换个查法」的 warning。 */
  record(input: {
    /** 这次搜索属于哪个会话；决定 trace 进哪个队列。 */
    sessionId: string
    /** 与 `register` 时同一个 scope id，原样回传。 */
    retrievalScopeId: string
    /** 与 `register` 时同一个 kind，原样回传。 */
    kind: ChatContextRetrievalQueryKind
    /** 原始查询串，会原样记进 trace 供诊断页展示。 */
    query: string
    /** `register` 返回的那个对象；重复次数和归一化签名都从它来，不要自己拼。 */
    registration: RetrievalQueryRegistration
    /** 这次搜索的搜索空间大小：history 是消息总数，terminal 是 logReference 总数。用来判断「搜遍了还是没搜到」。 */
    totalCandidates: number
    /** semanticScore > 0 的条数，含没返回给调用方的那些；和 returnedCount 一比就知道是不是被截断了。 */
    matchedCount: number
    /** 全部命中项的分数，供 `buildRetrievalScoreStats` 分桶统计；不排序要求。 */
    matchedScores: number[]
    /** 真正返回给调用方的 top 项，按分数从高到低；trace 只留前几条的 handleId 和去重后的 matchReasons。 */
    returnedItems: Array<{
      /** 这条结果的句柄 id，模型后续引用它而不是再搜一遍。 */
      handleId: string
      /** 这条结果的综合得分，第一条的分数会记成 trace 的 topScore。 */
      score: number
      /** 这条为什么被判为命中（词命中、路径命中等），跨条目去重后留前 10 条进 trace。 */
      matchReasons: string[]
    }>
  }): ChatContextRetrievalQueryTraceEntry
  /** 取某个会话最近的搜索 trace，按记录先后排；没搜过或已被挤掉时给空数组（不抛）。诊断面板和自检用。 */
  getRecent(sessionId: string): ChatContextRetrievalQueryTraceEntry[]
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
class ContextRetrievalQueryTraceStore implements ContextRetrievalQueryTraceStoreApi {
  /** 每个 session 保留的最近 trace 条数（环形队列 tail）。 */
  private readonly maxRecentQueryTracesPerSession: number
  /** retrievalCount 达到此值时在 trace.warning 提示重复搜索。 */
  private readonly repeatedSearchWarningThreshold = 2

  /** 键 → 累计搜索次数（进程内，不持久化）。 */
  private readonly queryCounts: ContextRetrievalBoundedCounter
  /** sessionId → 最近 trace 列表（最多 maxRecentQueryTracesPerSession）。 */
  private readonly recentQueryTracesBySession = new Map<string, ChatContextRetrievalQueryTraceEntry[]>()

  constructor(options: ContextRetrievalQueryTraceStoreOptions = {}) {
    this.maxRecentQueryTracesPerSession = normalizeRetrievalLimit(
      options.maxRecentQueryTracesPerSession,
      AgentTuning.retrieval.maxRecentQueryTracesPerSession
    )
    this.queryCounts = new ContextRetrievalBoundedCounter(
      normalizeRetrievalLimit(options.maxQueryCountEntries, AgentTuning.retrieval.maxQueryCountEntries)
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
}

export { ContextRetrievalQueryTraceStore, type ContextRetrievalQueryTraceStoreOptions }
