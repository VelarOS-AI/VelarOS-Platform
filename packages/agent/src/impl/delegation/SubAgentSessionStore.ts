// 域：子 Agent 线程的**内存存储**——线程记录、对话历史，以及执行结束后的有限保留。
//
// ## 生命周期
// 线程先挂在派发它的顶层执行上；执行结束时 `clearExecution` 把它们**脱离执行、转入保留期**，而不是
// 删掉：同一父会话的后续执行可以带 thread_id 续跑，子 Agent 带着之前读过的上下文接着干，不必从头
// 再读一遍。续跑时 `attachToExecution` 把线程挂到新的执行上，中断、relay 与下一次收尾因此都按新
// 执行生效。
//
// ## 保留上限（数值单源在 AgentExecutionLimits.subAgentRetained*）
//  - 空闲 TTL：从脱离执行（或其后最后一次运行收尾）起算，过期即丢；
//  - 每父会话 / 全局条数：只数已脱离执行的线程，超出按最近使用淘汰；执行中的线程不被淘汰；
//  - 可续跑性：历史为空（首轮前就结束，没有可续的上下文）或序列化超出体积上限（续跑比新派更贵）
//    的线程不可续跑，脱离执行后直接丢。
// 清理不用计时器：派发器每次派发前调 `prune`，执行收尾的 `clearExecution` 也顺手清一次。
import type { ModelMessage } from 'ai'

import { isEmpty, isNotNull, isNull, toNullable, toOptional } from '@velaros-ai/core'

import type { SubAgentSessionRecord, SubAgentSessionStatus, SubAgentTaskRequest, SubAgentTaskResult } from '../../types/agent.js'
import type { CreateSubAgentSessionInput, DetachedThreadCandidate,SubAgentReleasedThread, SubAgentThreadRetention, SubAgentThreadRetentionLimits, ThreadRetentionState } from '../../types/delegation.js'
import { measureThreadHistoryChars } from '../../utils/delegation/thread-retention'
import { resolveAgentExecutionLimits } from '../../utils/loop/execution-limits'

/** 建 {@link SubAgentSessionStore} 时的装配项；两项都可缺省，产品一般只传 limits。 */
interface SubAgentSessionStoreOptions {
  /** 保留上限；缺省取 `resolveAgentExecutionLimits()` 的默认值。 */
  limits?: SubAgentThreadRetentionLimits
  /** 时钟（epoch 毫秒），供测试注入；缺省 `Date.now()`。 */
  now?: () => number
}

function addToIndex(index: Map<string, Set<string>>, key: string, threadId: string): void {
  const threads = index.get(key) ?? new Set<string>()
  threads.add(threadId)
  index.set(key, threads)
}

function removeFromIndex(index: Map<string, Set<string>>, key: string, threadId: string): void {
  const threads = index.get(key)
  if (!threads) return
  threads.delete(threadId)
  if (threads.size === 0) index.delete(key)
}

/**
 * 子 Agent 线程内存存储：执行期挂在执行上，执行结束后按父会话有限保留，供续跑复用上下文。
 *
 * 派发器持一台、跟着进程活；全部在内存，进程重启即空。线程在这里有两种处境——「挂在某次执行上」和
 * 「已脱离执行、处于保留期」，几乎所有动词的语义差别都来自这个区分。清理不靠计时器，靠每次派发前的 `prune`。
 */
export interface SubAgentSessionStoreApi {
  /** 新建一条线程记录（状态 pending、历史为空）并挂到发起它的执行上，返回建好的记录。 */
  createSession(input: CreateSubAgentSessionInput): SubAgentSessionRecord
  /** 按 thread_id 取线程记录；已被丢弃（过期、挤出、父会话释放）或从没建过时返回 null。 */
  getSession(threadId: string): Nullable<SubAgentSessionRecord>
  /**
   * 改线程的状态或请求参数（请求参数按字段合并，不整份替换），返回改后的记录；线程不在返回 null。
   *
   * 只刷 `updated_at`，**不算一次使用**——保留期的最近使用位次由 `appendRunResult` / `attachToExecution` 推进。
   */
  updateSession(
    threadId: string,
    patch: { status?: SubAgentSessionStatus; request?: Partial<SubAgentTaskRequest> }
  ): Nullable<SubAgentSessionRecord>
  /** 追加一次运行的结果并把这条线程记为「刚用过」；一次运行收尾调一次，线程不在则什么都不做。 */
  appendRunResult(threadId: string, result: SubAgentTaskResult): void
  /** 取线程的对话历史副本；线程不在返回空数组。续跑时拿它当 worker 的起始历史。 */
  getHistory(threadId: string): ModelMessage[]
  /**
   * 回写线程历史（轮次边界由 worker 调），并作废已缓存的历史字数。
   *
   * 线程已被丢弃时**什么都不做**：还在收尾的 worker 晚到的回写不许把历史复活成一份无主数据。
   */
  setHistory(threadId: string, history: ModelMessage[]): void
  /** 此刻挂在该执行上的线程记录（不含已脱离执行、处于保留期的）；派发器据此列出「本次执行派了谁」。 */
  listByExecution(executionId: string): SubAgentSessionRecord[]
  /** 改线程状态的便捷入口，等价于只带 status 的 `updateSession`。 */
  setStatus(threadId: string, status: SubAgentSessionStatus): void
  /**
   * 续跑时把线程从原执行（或保留期）摘下来、挂到发起续跑的这次执行上，并记为刚用过；线程不在返回 false。
   *
   * 挂过去之后中断、relay 与收尾时的脱离都按新执行生效。
   */
  attachToExecution(threadId: string, executionId: string): boolean
  /**
   * 这条线程此刻还能不能续跑，以及（能续时）保留到什么时候。
   *
   * 只看历史：空历史 = 首轮前就结束、没有可续的上下文；超出体积上限 = 续跑比新派还贵。
   * **不看状态**——failed / aborted 的线程照样能续，运行中的线程由派发器另按「正在运行」处理。
   */
  describeRetention(threadId: string): SubAgentThreadRetention
  /**
   * 顶层执行结束：挂在它上面的线程**脱离执行转入保留期**（不删除），随后按上限清理一次。
   *
   * 仍在跑的线程也照样脱离——派发器会中断它们，收尾成 aborted 后同样可续跑。
   */
  clearExecution(executionId: string): void
  /**
   * 父会话被删除：丢掉它的全部线程（含仍挂在执行上的），返回被丢的线程及其当时挂靠的执行。
   *
   * 调用方拿着返回值去中断还在跑的 worker——存储自己不认识 worker。
   */
  releaseParentSession(parentSessionId: string): SubAgentReleasedThread[]
  /**
   * 按空闲 TTL、可续跑性与条数上限清理已脱离执行的线程；挂在执行上的一概不动。
   *
   * 每次派发前先调它，后面的「这条线程还在不在」才答得准；执行收尾时也顺手清一次。
   * 条数上限先按父会话淘汰、再按全局淘汰，都按最近使用排序。
   */
  prune(): void
}

class SubAgentSessionStore implements SubAgentSessionStoreApi {
  /** 已经走到终态的线程状态：只有它们才谈得上保留与淘汰。 */
  private static readonly TerminalThreadStatuses: ReadonlySet<SubAgentSessionStatus> = new Set<SubAgentSessionStatus>([
    'completed',
    'failed',
    'aborted',
    'wind_down',
  ])

  private readonly sessions = new Map<string, SubAgentSessionRecord>()
  private readonly historyByThread = new Map<string, ModelMessage[]>()
  private readonly retentionByThread = new Map<string, ThreadRetentionState>()
  /** 执行 → 挂在它上面的线程（只含未脱离执行的）。 */
  private readonly executionIndex = new Map<string, Set<string>>()
  /** 父会话 → 它派出的全部线程（含保留期内的）。 */
  private readonly parentSessionIndex = new Map<string, Set<string>>()
  private readonly limits: SubAgentThreadRetentionLimits
  private readonly now: () => number
  private useSequence = 0

  constructor(options: SubAgentSessionStoreOptions = {}) {
    this.limits = options.limits ?? resolveAgentExecutionLimits()
    this.now = options.now ?? (() => Date.now())
  }

  public createSession(input: CreateSubAgentSessionInput): SubAgentSessionRecord {
    const now = this.now()
    const request: SubAgentTaskRequest = {
      subagent_type: input.subagentType,
      prompt: input.prompt,
      description: input.description,
      tool_scope: input.toolScope,
      tool_categories: input.toolCategories ? [...input.toolCategories] : undefined,
      mode: input.mode ?? 'sync',
      readonly: input.readonly,
      model: toOptional(input.model),
      route_category: toOptional(input.routeCategory),
      agent_name: input.agentName,
      ...input.request,
    }
    const record: SubAgentSessionRecord = {
      thread_id: input.threadId,
      execution_id: input.executionId,
      parent_session_id: input.parentSessionId,
      resource_id: toOptional(input.resourceId),
      subagent_type: input.subagentType,
      status: 'pending',
      created_at: now,
      updated_at: now,
      request,
      results: [],
    }
    this.sessions.set(input.threadId, record)
    this.historyByThread.set(input.threadId, [])
    this.retentionByThread.set(input.threadId, {
      lastUsedAt: now,
      lastUseSequence: this.nextUseSequence(),
      detachedAt: null,
      historyChars: 0,
    })
    addToIndex(this.executionIndex, input.executionId, input.threadId)
    addToIndex(this.parentSessionIndex, input.parentSessionId, input.threadId)
    return record
  }

  public getSession(threadId: string): Nullable<SubAgentSessionRecord> {
    return toNullable(this.sessions.get(threadId))
  }

  public updateSession(
    threadId: string,
    patch: {
      status?: SubAgentSessionStatus
      request?: Partial<SubAgentTaskRequest>
    }
  ): Nullable<SubAgentSessionRecord> {
    const existing = this.sessions.get(threadId)
    if (!existing) return null
    const updated: SubAgentSessionRecord = {
      ...existing,
      ...patch,
      request: patch.request ? { ...existing.request, ...patch.request } : existing.request,
      updated_at: this.now(),
    }
    this.sessions.set(threadId, updated)
    return updated
  }

  /** 记下一次运行的结果；运行收尾即算一次使用。 */
  public appendRunResult(threadId: string, result: SubAgentTaskResult): void {
    const existing = this.sessions.get(threadId)
    if (!existing) return
    const now = this.now()
    existing.results.push(result)
    existing.updated_at = now
    this.touch(threadId, now)
  }

  public getHistory(threadId: string): ModelMessage[] {
    return [...(this.historyByThread.get(threadId) ?? [])]
  }

  /**
   * 回写线程历史。线程已被丢弃（淘汰、过期或父会话释放）时什么都不做：仍在收尾的 worker 晚到的
   * 回写不许把历史复活成一份无主数据。
   */
  public setHistory(threadId: string, history: ModelMessage[]): void {
    const session = this.sessions.get(threadId)
    if (!session) return
    this.historyByThread.set(threadId, [...history])
    session.updated_at = this.now()
    const retention = this.retentionByThread.get(threadId)
    if (retention) retention.historyChars = null
  }

  /** 此刻挂在该执行上的线程（不含已脱离执行、处于保留期的）。 */
  public listByExecution(executionId: string): SubAgentSessionRecord[] {
    const threadIds = this.executionIndex.get(executionId)
    if (!threadIds) return []
    return [...threadIds]
      .map((threadId) => this.sessions.get(threadId))
      .filter((session): session is SubAgentSessionRecord => !!session)
  }

  public setStatus(threadId: string, status: SubAgentSessionStatus): void {
    this.updateSession(threadId, { status })
  }

  /**
   * 续跑时把线程挂到发起续跑的执行上（从原执行或保留期摘下），并计一次使用；线程不存在返回 false。
   */
  public attachToExecution(threadId: string, executionId: string): boolean {
    const record = this.sessions.get(threadId)
    const retention = this.retentionByThread.get(threadId)
    if (!record || !retention) return false
    removeFromIndex(this.executionIndex, record.execution_id, threadId)
    const now = this.now()
    this.sessions.set(threadId, { ...record, execution_id: executionId, updated_at: now })
    addToIndex(this.executionIndex, executionId, threadId)
    retention.detachedAt = null
    this.touch(threadId, now)
    return true
  }

  /**
   * 线程此刻能否续跑。只看历史：空历史 = 首轮前就结束、没有可续的上下文；超出体积上限 = 续跑比
   * 新派更贵。不看状态——运行中的线程由派发器另按「正在运行」处理。
   */
  public describeRetention(threadId: string): SubAgentThreadRetention {
    const history = this.historyByThread.get(threadId)
    const retention = this.retentionByThread.get(threadId)
    if (!history || !retention) return { resumable: false, reason: 'not-found' }
    if (isEmpty(history)) return { resumable: false, reason: 'empty-history' }
    if (measureThreadHistoryChars(retention, history) > this.limits.subAgentRetainedHistoryMaxChars)
      return { resumable: false, reason: 'history-too-large' }
    return { resumable: true, retainedUntil: this.resolveRetainedUntil(retention) }
  }

  /**
   * 顶层执行结束：挂在它上面的线程脱离执行、转入保留期（不删除），随后按上限清理一次。
   *
   * 仍在运行的线程也照样脱离——派发器会中断它们，它们收尾成 aborted 后同样可续跑（历史只在轮次
   * 边界回写，中断丢掉的是没跑完的那一轮，留下的历史是自洽的）。
   */
  public clearExecution(executionId: string): void {
    const threadIds = this.executionIndex.get(executionId)
    this.executionIndex.delete(executionId)
    const now = this.now()
    for (const threadId of threadIds ?? []) {
      const retention = this.retentionByThread.get(threadId)
      if (retention) retention.detachedAt = now
    }
    this.prune()
  }

  /**
   * 父会话被删除：丢掉它的全部线程（含仍挂在执行上的），返回被丢的线程及其挂靠的执行，供调用方
   * 中断还在运行的 worker。
   */
  public releaseParentSession(parentSessionId: string): SubAgentReleasedThread[] {
    const released = [...(this.parentSessionIndex.get(parentSessionId) ?? [])].map(
      (threadId): SubAgentReleasedThread => ({
        threadId,
        executionId: this.resolveAttachedExecution(threadId),
      })
    )
    for (const { threadId } of released) this.dropThread(threadId)
    return released
  }

  /** 按空闲 TTL、可续跑性与条数上限清理已脱离执行的线程；执行中的线程不受影响。 */
  public prune(): void {
    const now = this.now()
    const candidates: DetachedThreadCandidate[] = []
    for (const [threadId, retention] of this.retentionByThread) {
      if (isNull(retention.detachedAt)) continue
      const record = this.sessions.get(threadId)
      if (!record || this.shouldDropDetachedThread(record, retention, retention.detachedAt, now)) {
        this.dropThread(threadId)
        continue
      }
      candidates.push({
        threadId,
        parentSessionId: record.parent_session_id,
        lastUseSequence: retention.lastUseSequence,
      })
    }

    const candidatesByParent = new Map<string, DetachedThreadCandidate[]>()
    for (const candidate of candidates) {
      const siblings = candidatesByParent.get(candidate.parentSessionId) ?? []
      siblings.push(candidate)
      candidatesByParent.set(candidate.parentSessionId, siblings)
    }
    const keptPerParent = [...candidatesByParent.values()].flatMap((siblings) =>
      this.evictLeastRecentlyUsed(siblings, this.limits.subAgentRetainedThreadsPerSession)
    )
    this.evictLeastRecentlyUsed(keptPerParent, this.limits.subAgentRetainedThreadsTotal)
  }

  private shouldDropDetachedThread(
    record: SubAgentSessionRecord,
    retention: ThreadRetentionState,
    detachedAt: number,
    now: number
  ): boolean {
    const idleSince = Math.max(detachedAt, retention.lastUsedAt)
    if (now - idleSince > this.limits.subAgentRetainedThreadIdleTtlMs) return true
    // 执行收尾时还在跑的线程正被中断，等它收尾再判可续跑性。
    if (!SubAgentSessionStore.TerminalThreadStatuses.has(record.status)) return false
    return !this.describeRetention(record.thread_id).resumable
  }

  /** 超出上限时按最近使用淘汰最久未用的线程，返回留下的。 */
  private evictLeastRecentlyUsed(
    threads: readonly DetachedThreadCandidate[],
    limit: number
  ): DetachedThreadCandidate[] {
    if (threads.length <= limit) return [...threads]
    const byRecency = [...threads].sort((left, right) => right.lastUseSequence - left.lastUseSequence)
    for (const evicted of byRecency.slice(limit)) this.dropThread(evicted.threadId)
    return byRecency.slice(0, limit)
  }

  private resolveRetainedUntil(retention: ThreadRetentionState): Nullable<number> {
    if (
      this.limits.subAgentRetainedThreadsPerSession === 0 ||
      this.limits.subAgentRetainedThreadsTotal === 0
    )
      return null
    // 挂在执行上的线程空闲期还没开始（从脱离执行起算），此刻 + TTL 是保守下界。
    const idleSince = isNull(retention.detachedAt)
      ? this.now()
      : Math.max(retention.detachedAt, retention.lastUsedAt)
    return idleSince + this.limits.subAgentRetainedThreadIdleTtlMs
  }

  private resolveAttachedExecution(threadId: string): Nullable<string> {
    const record = this.sessions.get(threadId)
    const retention = this.retentionByThread.get(threadId)
    if (!record || !retention || isNotNull(retention.detachedAt)) return null
    return record.execution_id
  }

  private touch(threadId: string, now: number): void {
    const retention = this.retentionByThread.get(threadId)
    if (!retention) return
    retention.lastUsedAt = now
    retention.lastUseSequence = this.nextUseSequence()
  }

  private nextUseSequence(): number {
    this.useSequence += 1
    return this.useSequence
  }

  private dropThread(threadId: string): void {
    const record = this.sessions.get(threadId)
    if (record) {
      // 已脱离执行的线程早已不在执行索引里，摘除是空操作；仍挂着的必须摘下。
      removeFromIndex(this.executionIndex, record.execution_id, threadId)
      removeFromIndex(this.parentSessionIndex, record.parent_session_id, threadId)
    }
    this.sessions.delete(threadId)
    this.historyByThread.delete(threadId)
    this.retentionByThread.delete(threadId)
  }
}

export { SubAgentSessionStore }
export type { SubAgentSessionStoreOptions }
