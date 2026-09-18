import { createTurnContextSessionLedgers } from '@velaros-ai/agent'
import { isEmpty, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { MemoryRecallInspectOperation, MemoryTurnContextSourceId } from '../../contract/constants.js'
import type { MemoryTurnContextDeltaSource } from '../../contract/provides.js'
import type { MemoryTurnRecallDeps } from '../../types/host.js'
import type {
  MemoryTurnRecallInput,
  MemoryTurnRecallResult,
} from '../../types/memory.js'
import { formatRecallSummary, truncateRecallText } from '../../utils/recall.js'
import { MemoryTuning } from '../../utils/tuning.js'

const log = Log.tag('MemoryTurnRecall')

/**
 * 回合开始记忆自动召回协调器。
 *
 * 发送被接受后在后台按 Claim 与树路径召回，结果写入只对模型可见的增量账本，
 * 在运行内下一模型轮注入，不进入 renderer 的 composer chip 或会话展示。
 *
 * 同一记忆每个会话只注入一次；召回失败只记日志，绝不影响发送。
 */
export interface MemoryTurnRecallCoordinatorApi {
  /** 发送被接受后调用；同步返回，召回在后台完成。 */
  notifyUserMessage(input: MemoryTurnRecallInput): void
  /** 可等待的召回：给外部引擎在拼提示词之前用，超过硬预算就返回空。 */
  recallUserMessage(input: MemoryTurnRecallInput): Promise<MemoryTurnRecallResult>
  /** 造一个回合上下文增量源，交给宿主注册。 */
  createTurnContextSource(): MemoryTurnContextDeltaSource
  /** 会话结束：清掉这个会话的账本与去重表。 */
  clearSession(sessionId: string): void
}

/** 回合召回协调器实现。 */
export class MemoryTurnRecallCoordinator implements MemoryTurnRecallCoordinatorApi {
  /** 运行轨迹可供审计/手动召回，但不应作为下一项任务的自动语义上下文。 */
  private static readonly AutomaticRecallExcludedSourceTypes = [
    'workspace_event',
    'execution_event',
    'computer_use',
  ] as const

  private readonly ledgers = createTurnContextSessionLedgers(MemoryTurnContextSourceId, {
    maxEntries: MemoryTuning.recall.ledgerMaxEntries,
    notifyRenderer: false,
  })
  private readonly injectedIdsBySession = new Map<string, Set<string>>()
  /** 在途召回闩：sessionId → { 认领令牌, 上闩时刻 }（时刻供惰性看门狗判活）。 */
  private readonly inFlightSessions = new Map<string, { token: number; startedAt: number }>()
  private inFlightLatchSeq = 0

  constructor(private readonly deps: MemoryTurnRecallDeps) {}

  /** 发送接受后调用；同步返回，召回在后台完成。 */
  public notifyUserMessage(input: MemoryTurnRecallInput): void {
    // 自动记忆关闭时既不采集也不注入，与 EvidenceBridge.canCapture 语义一致。
    if (!this.isRecallAllowed(input.sessionId)) return
    const query = input.query.trim().slice(0, MemoryTuning.recall.queryMaxChars)
    if (query.length < MemoryTuning.recall.minQueryChars) return
    // 上一轮召回还在跑（模型选择最长 4s）说明用户在快速连发，跳过本轮避免堆积。
    if (this.isRecallInFlight(input.sessionId)) return

    const releaseLatch = this.acquireInFlightLatch(input.sessionId)
    void this.recall(input, query, true)
      .catch((error) => {
        log.debug('turn memory recall failed; skipping injection', {
          sessionId: input.sessionId,
          error: AppError.getMessage(error),
        })
      })
      .finally(releaseLatch)
  }

  /**
   * 在途闩查询，**惰性看门狗**：闩比硬预算还老 = 那次召回不会再回来了，就地放行。
   *
   * 惰性而不是挂定时器：判定发生在唯一会被它挡住的那次调用上，不留计时器、不占进程生命周期，
   * 也不需要任何解闩通知机制。
   */
  private isRecallInFlight(sessionId: string): boolean {
    const latch = this.inFlightSessions.get(sessionId)
    if (!latch) return false
    if (Date.now() - latch.startedAt < MemoryTuning.recall.inFlightWatchdogMs) return true

    log.debug('turn memory recall latch expired by watchdog; recall never settled', { sessionId })
    this.inFlightSessions.delete(sessionId)
    return false
  }

  /**
   * 上闩并交回解闩函数。
   *
   * 解闩按 token 认领：看门狗放行后那次僵死召回若干年后真回来了，它的 `.finally` 不许把**后来**
   * 那把闩解掉（否则会放进第三次并发召回）。
   */
  private acquireInFlightLatch(sessionId: string): () => void {
    this.inFlightLatchSeq += 1
    const token = this.inFlightLatchSeq
    this.inFlightSessions.set(sessionId, { token, startedAt: Date.now() })

    return () => {
      if (this.inFlightSessions.get(sessionId)?.token === token)
        this.inFlightSessions.delete(sessionId)
    }
  }

  /**
   * 外部引擎发送前的可等待入口。
   *
   * 与 Solo 的 {@link notifyUserMessage} 完全分离：调用方最多等待 2 秒；关闭、并发、失败或超时
   * 都返回空结果，绝不拦发送且本轮不重试。召回项直接回给引擎 prompt，不写 turn-context
   * 账本，避免同一份记忆再被下一轮上下文源重复投递。
   */
  public async recallUserMessage(
    input: MemoryTurnRecallInput,
    timeoutMs = MemoryTuning.recall.awaitableTimeoutMs
  ): Promise<MemoryTurnRecallResult> {
    if (!this.isRecallAllowed(input.sessionId)) return { summaries: [] }
    const query = input.query.trim().slice(0, MemoryTuning.recall.queryMaxChars)
    if (query.length < MemoryTuning.recall.minQueryChars || this.isRecallInFlight(input.sessionId))
      return { summaries: [] }

    // 这一路同样只在 settle 时解闩：等待超时只是本轮放弃，闩还挂在那条永不回来的请求上。
    const releaseLatch = this.acquireInFlightLatch(input.sessionId)
    let expired = false
    const timers = new TimerScope({ name: 'MemoryTurnRecallCoordinator.awaitableRecall' })
    const sources: Array<{ sourceId: string; label: string }> = []
    const recallTask = this.recall(input, query, false, () => expired, sources)
      .then((summaries) => isEmpty(summaries) ? { summaries } : { summaries, sources })
      .catch((error) => {
        log.debug('awaitable turn memory recall failed; skipping injection', {
          sessionId: input.sessionId,
          error: AppError.getMessage(error),
        })
        return { summaries: [] }
      })
      .finally(releaseLatch)

    try {
      return await Promise.race([
        recallTask,
        new Promise<MemoryTurnRecallResult>((resolve) => {
          timers.after(Math.min(timeoutMs, MemoryTuning.recall.awaitableTimeoutMs), () => {
            expired = true
            resolve({ summaries: [] })
          })
        }),
      ])
    } finally {
      timers.dispose()
    }
  }

  /** 环境回合上下文 source adapter：纯内存读账本，无 IO。 */
  public createTurnContextSource(): MemoryTurnContextDeltaSource {
    return {
      id: 'memory.recall',
      scopes: this.deps.turnContextScopes,
      rendererVisible: false,
      peekCached: (input) => {
        const cached = this.ledgers.peek(input.sessionId, input)
        return {
          ...cached,
          deltas: this.isRecallAllowed(input.sessionId) ? cached.deltas : [],
          anchors: [],
        }
      },
    }
  }

  private isRecallAllowed(sessionId: string): boolean {
    return (this.deps.isEnabled?.() ?? true) && (this.deps.isSessionRecallAllowed?.(sessionId) ?? true)
  }

  public clearSession(sessionId: string): void {
    this.ledgers.clearSession(sessionId)
    this.injectedIdsBySession.delete(sessionId)
  }

  private async recall(
    input: MemoryTurnRecallInput,
    query: string,
    appendToLedger: boolean,
    isExpired: () => boolean = () => false,
    selectedSources?: Array<{ sourceId: string; label: string }>
  ): Promise<string[]> {
    const scope = this.deps.resolveScope({
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      contextId: input.contextId,
    })
    let candidates = await this.deps.recall(query, {
      limit: MemoryTuning.recall.candidateLimit,
      workspaceRoot: input.workspaceRoot?.trim() || undefined,
      scopeId: scope.scopeId,
      excludeSessionId: input.sessionId,
      excludeAgentConversationEchoes: true,
      excludeConversationObservations: true,
      excludeSourceTypes: [...MemoryTurnRecallCoordinator.AutomaticRecallExcludedSourceTypes],
    })
    if (isEmpty(candidates) && (this.deps.isAutomaticDeepRecallEnabled?.() ?? true)) {
      candidates = await this.deps.recall(query, {
        limit: MemoryTuning.recall.candidateLimit,
        workspaceRoot: input.workspaceRoot?.trim() || undefined,
        scopeId: scope.scopeId,
        excludeSessionId: input.sessionId,
        excludeAgentConversationEchoes: true,
        excludeConversationObservations: true,
        excludeSourceTypes: [...MemoryTurnRecallCoordinator.AutomaticRecallExcludedSourceTypes],
        includeDormant: true,
        deep: true,
      })
    }
    if (isExpired() || !this.isRecallAllowed(input.sessionId)) return []

    const injectedIds = this.injectedIdsFor(input.sessionId)
    const excludedSourceTypes = new Set<string>(MemoryTurnRecallCoordinator.AutomaticRecallExcludedSourceTypes)
    const freshCandidates = candidates.filter((candidate) =>
      !injectedIds.has(candidate.id)
      && candidate.predicate !== 'conversation_observation'
      && (
        !candidate.sourceTypes?.length
        || candidate.sourceTypes.some((sourceType) => !excludedSourceTypes.has(sourceType))
      ))
    if (isEmpty(freshCandidates)) return []

    const summaries: string[] = []
    for (const memory of freshCandidates.slice(0, MemoryTuning.recall.maxInjectPerTurn)) {
      injectedIds.add(memory.id)
      const summaryText = formatRecallSummary(memory)
      summaries.push(summaryText)
      selectedSources?.push({ sourceId: 'memory.recall', label: `记忆：${truncateRecallText(memory.title, MemoryTuning.recall.summaryLabelChars)}` })
      if (appendToLedger) {
        this.ledgers.append(input.sessionId, {
          label: `记忆：${truncateRecallText(memory.title, MemoryTuning.recall.summaryLabelChars)}`,
          summaryText,
          inspect: { tool: MemoryRecallInspectOperation, argsHint: { id: memory.id } },
        })
      }
    }
    return summaries
  }

  private injectedIdsFor(sessionId: string): Set<string> {
    const existing = this.injectedIdsBySession.get(sessionId)
    if (existing) return existing

    const created = new Set<string>()
    this.injectedIdsBySession.set(sessionId, created)
    while (this.injectedIdsBySession.size > MemoryTuning.recall.injectedSessionsMax) {
      const oldest = this.injectedIdsBySession.keys().next().value
      if (!oldest) break
      this.injectedIdsBySession.delete(oldest)
    }
    return created
  }

}
