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

import type {
  SubAgentSessionRecord,
  SubAgentSessionStatus,
  SubAgentTaskMode,
  SubAgentTaskRequest,
  SubAgentTaskResult,
  SubAgentTypeId,
  TeamModelRouteCategory,
  ToolCategoryId,
} from '@velaros-ai/agent/protocol'
import { isEmpty, isNotNull, isNull, sum, toNullable, toOptional } from '@velaros-ai/core'

import { estimateMessageChars } from '../agent/context/residency/messageFacts'
import { type AgentExecutionLimits, resolveAgentExecutionLimits } from '../agent/ExecutionLimits'

interface CreateSubAgentSessionInput {
  threadId: string
  executionId: string
  parentSessionId: string
  /** 派发时父上下文的资源标识（resourceId）；续跑须在同一资源上。 */
  resourceId?: LooseOptional<string>
  subagentType: SubAgentTypeId
  prompt: string
  description?: LooseOptional<string>
  mode?: SubAgentTaskMode
  readonly?: boolean
  toolScope?: SubAgentTaskRequest['tool_scope']
  toolCategories?: readonly ToolCategoryId[]
  model?: LooseOptional<string>
  routeCategory?: LooseOptional<TeamModelRouteCategory>
  agentName?: string
  request?: Partial<Omit<SubAgentTaskRequest, 'subagent_type' | 'prompt'>>
}

/** 线程保留相关的执行上限（单一数据源在 AgentExecutionLimits）。 */
type SubAgentThreadRetentionLimits = Pick<
  AgentExecutionLimits,
  | 'subAgentRetainedThreadsPerSession'
  | 'subAgentRetainedThreadsTotal'
  | 'subAgentRetainedThreadIdleTtlMs'
  | 'subAgentRetainedHistoryMaxChars'
>

interface SubAgentSessionStoreOptions {
  /** 保留上限；缺省取 `resolveAgentExecutionLimits()` 的默认值。 */
  limits?: SubAgentThreadRetentionLimits
  /** 时钟（epoch 毫秒），供测试注入；缺省 `Date.now()`。 */
  now?: () => number
}

/** 线程不能续跑的原因。 */
type SubAgentThreadUnresumableReason = 'not-found' | 'empty-history' | 'history-too-large'

/** 线程此刻能否续跑，以及大约能留到什么时候。 */
type SubAgentThreadRetention =
  | {
      resumable: true
      /** 保留期限估计（epoch 毫秒）；关闭了跨执行保留（条数上限为 0）时为 null。 */
      retainedUntil: Nullable<number>
    }
  | { resumable: false; reason: SubAgentThreadUnresumableReason }

/** `releaseParentSession` 丢掉的线程；`executionId` 为它仍挂靠的执行，已脱离执行时为 null。 */
interface SubAgentReleasedThread {
  threadId: string
  executionId: Nullable<string>
}

/** 每条线程的保留簿记（不进协议记录）。 */
interface ThreadRetentionState {
  /** 最近一次使用（创建、续跑挂靠、运行收尾）的时刻；空闲 TTL 的起点之一。 */
  lastUsedAt: number
  /** 最近一次使用的单调序号：按它淘汰最久未用的线程，不受时钟精度影响（同一毫秒内的并行派发）。 */
  lastUseSequence: number
  /** 脱离执行的时刻；null = 仍挂在 `record.execution_id` 那次执行上。 */
  detachedAt: Nullable<number>
  /** 历史序列化字符数缓存；历史被改写即作废。 */
  historyChars: Nullable<number>
}

/** 已脱离执行、等待按条数上限裁决的线程。 */
interface DetachedThreadCandidate {
  threadId: string
  parentSessionId: string
  lastUseSequence: number
}

const TerminalThreadStatuses: ReadonlySet<SubAgentSessionStatus> = new Set<SubAgentSessionStatus>([
  'completed',
  'failed',
  'aborted',
  'wind_down',
])

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
 */
class SubAgentSessionStore {
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
    if (this.measureHistoryChars(retention, history) > this.limits.subAgentRetainedHistoryMaxChars)
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
    if (!TerminalThreadStatuses.has(record.status)) return false
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

  private measureHistoryChars(
    retention: ThreadRetentionState,
    history: readonly ModelMessage[]
  ): number {
    if (isNotNull(retention.historyChars)) return retention.historyChars
    const chars = sum(history, estimateMessageChars)
    retention.historyChars = chars
    return chars
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
export type {
  CreateSubAgentSessionInput,
  SubAgentReleasedThread,
  SubAgentSessionStoreOptions,
  SubAgentThreadRetention,
  SubAgentThreadRetentionLimits,
  SubAgentThreadUnresumableReason,
}
