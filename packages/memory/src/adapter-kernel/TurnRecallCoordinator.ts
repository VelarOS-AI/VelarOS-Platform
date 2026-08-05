import { TurnContextSessionLedgers } from '@velaros-ai/agent/run-context'
import { isEmpty, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { MemoryRecallItem, MemoryStoreBackend } from '..'

import type { MemoryHostScopeResolver } from './HostContracts'

const log = Log.tag('MemoryTurnRecall')

/** 短于该长度的用户消息（如“继续”“好的”）不值得触发召回。 */
const RecallMinQueryChars = 4
/** 召回查询截断长度：只取用户消息头部，避免长粘贴文本拖慢全文检索。 */
const RecallQueryMaxChars = 600
/** 树路径召回候选上限。 */
const RecallCandidateLimit = 12
/** 单轮最多注入条数。 */
const RecallMaxInjectPerTurn = 3
/** delta 账本容量：注入是低频小量事件，16 条足够覆盖积压。 */
const RecallLedgerMaxEntries = 16
/** 已注入去重集的会话数上限，超出按插入序淘汰。 */
const InjectedSessionsMax = 128
/** 引擎发送前可等待召回的硬预算；超时后本轮跳过，不阻塞发送、不重试。 */
const AwaitableRecallTimeoutMs = 2_000
/**
 * 在途闩的看门狗预算：闩比它还老就当那次召回不会回来了，就地放行。
 *
 * 解闩原本完全依赖 promise settle，而召回一路打到 embedding 网关的 HTTP 请求上，
 * Node fetch 没有默认超时——远端 TCP 挂起（不断也不回）时 `.finally` 永不执行，此后该会话的
 * 自动记忆召回在进程剩余生命周期内彻底静默失效（审计 U38）。取值比 `AwaitableRecallTimeoutMs`
 * 宽得多：这道门防的是"永远不回来"，不是"慢"，误伤一次在跑的召回比闩死一个会话更亏。
 */
const InFlightLatchWatchdogMs = 30_000
/** 运行轨迹可供审计/手动召回，但不应作为下一项任务的自动语义上下文。 */
const AutomaticRecallExcludedSourceTypes = [
  'workspace_event',
  'execution_event',
  'computer_use',
] as const

export interface MemoryTurnRecallDeps {
  /**
   * 召回动词。由 capability token 解析出的后端提供——本协调器不认识后端是树、文件还是
   * 并联了向量索引，只认窄端口的 `recall`。
   */
  recall: MemoryStoreBackend['recall']
  /** 自动记忆总开关；关闭后不采集也不注入召回。 */
  isEnabled?: () => boolean
  isAutomaticDeepRecallEnabled?: () => boolean
  resolveScope: MemoryHostScopeResolver
  turnContextScopes: readonly string[]
}

export interface MemoryTurnRecallInput {
  sessionId: string
  /** 用户本轮输入的原始文本（不含冻结的环境块）。 */
  query: string
  workspaceRoot?: LooseOptional<string>
  contextId?: LooseOptional<string>
}

/** 供外部引擎 prompt 前缀消费的只读召回结果；空数组表示关闭、跳过、失败或超时。 */
export interface MemoryTurnRecallResult {
  summaries: string[]
}

/**
 * Structural view of Kernel's generic turn-context source contract.
 * Keeping it local lets this adapter compile while Core moves from product
 * workspace enums to opaque capability scope ids.
 */
export interface MemoryTurnContextDeltaSource {
  id: string
  scopes: readonly string[]
  rendererVisible?: boolean
  peekCached: (input: {
    sessionId: string
    afterSeq: number
    generation: Nullable<string>
  }) => ReturnType<TurnContextSessionLedgers['peek']> & { anchors: [] }
}

/**
 * 回合开始记忆自动召回协调器。
 *
 * 发送被接受后在后台按 Claim 与树路径召回，结果写入只对模型可见的增量账本，
 * 在运行内下一模型轮注入，不进入 renderer 的 composer chip 或会话展示。
 *
 * 同一记忆每个会话只注入一次；召回失败只记日志，绝不影响发送。
 */
export class MemoryTurnRecallCoordinator {
  private readonly ledgers = new TurnContextSessionLedgers('memory.recall', {
    maxEntries: RecallLedgerMaxEntries,
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
    if (!(this.deps.isEnabled?.() ?? true)) return
    const query = input.query.trim().slice(0, RecallQueryMaxChars)
    if (query.length < RecallMinQueryChars) return
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
    if (Date.now() - latch.startedAt < InFlightLatchWatchdogMs) return true

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
    timeoutMs = AwaitableRecallTimeoutMs
  ): Promise<MemoryTurnRecallResult> {
    if (!(this.deps.isEnabled?.() ?? true)) return { summaries: [] }
    const query = input.query.trim().slice(0, RecallQueryMaxChars)
    if (query.length < RecallMinQueryChars || this.isRecallInFlight(input.sessionId))
      return { summaries: [] }

    // 这一路同样只在 settle 时解闩：等待超时只是本轮放弃，闩还挂在那条永不回来的请求上。
    const releaseLatch = this.acquireInFlightLatch(input.sessionId)
    let expired = false
    const timers = new TimerScope({ name: 'MemoryTurnRecallCoordinator.awaitableRecall' })
    const recallTask = this.recall(input, query, false, () => expired)
      .then((summaries) => ({ summaries }))
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
          timers.after(Math.min(timeoutMs, AwaitableRecallTimeoutMs), () => {
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
      peekCached: (input) => ({
        ...this.ledgers.peek(input.sessionId, input),
        anchors: [],
      }),
    }
  }

  public clearSession(sessionId: string): void {
    this.ledgers.clearSession(sessionId)
    this.injectedIdsBySession.delete(sessionId)
  }

  private async recall(
    input: MemoryTurnRecallInput,
    query: string,
    appendToLedger: boolean,
    isExpired: () => boolean = () => false
  ): Promise<string[]> {
    const scope = this.deps.resolveScope({
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      contextId: input.contextId,
    })
    let candidates = await this.deps.recall(query, {
      limit: RecallCandidateLimit,
      workspaceRoot: input.workspaceRoot?.trim() || undefined,
      scopeId: scope.scopeId,
      excludeSessionId: input.sessionId,
      excludeAgentConversationEchoes: true,
      excludeConversationObservations: true,
      excludeSourceTypes: [...AutomaticRecallExcludedSourceTypes],
    })
    if (isEmpty(candidates) && (this.deps.isAutomaticDeepRecallEnabled?.() ?? true)) {
      candidates = await this.deps.recall(query, {
        limit: RecallCandidateLimit,
        workspaceRoot: input.workspaceRoot?.trim() || undefined,
        scopeId: scope.scopeId,
        excludeSessionId: input.sessionId,
        excludeAgentConversationEchoes: true,
        excludeConversationObservations: true,
        excludeSourceTypes: [...AutomaticRecallExcludedSourceTypes],
        includeDormant: true,
        deep: true,
      })
    }
    if (isExpired()) return []

    const injectedIds = this.injectedIdsFor(input.sessionId)
    const excludedSourceTypes = new Set<string>(AutomaticRecallExcludedSourceTypes)
    const freshCandidates = candidates.filter((candidate) =>
      !injectedIds.has(candidate.id)
      && candidate.predicate !== 'conversation_observation'
      && (
        !candidate.sourceTypes?.length
        || candidate.sourceTypes.some((sourceType) => !excludedSourceTypes.has(sourceType))
      ))
    if (isEmpty(freshCandidates)) return []

    const summaries: string[] = []
    for (const memory of freshCandidates.slice(0, RecallMaxInjectPerTurn)) {
      injectedIds.add(memory.id)
      const summaryText = this.formatSummary(memory)
      summaries.push(summaryText)
      if (appendToLedger) {
        this.ledgers.append(input.sessionId, {
          label: `记忆：${this.truncate(memory.title, 16)}`,
          summaryText,
          inspect: { tool: 'memory:get', argsHint: { id: memory.id } },
        })
      }
    }
    return summaries
  }

  private formatSummary(memory: MemoryRecallItem): string {
    const body = (memory.summary || '')
      .replace(/\s+/g, ' ')
      .trim()
    const path = memory.path.map((node) => node.title).filter(Boolean).join(' → ')
    return [
      memory.retrievalReason === 'deep'
        ? '这是一次模糊的深层回忆；若用于回答，必须向用户说明它可能已经过时。'
        : '',
      `相关记忆「${this.truncate(memory.title, 48)}」：${this.truncate(body, 200)}`,
      path ? `树路径：${this.truncate(path, 160)}` : '',
      `来源：${memory.evidenceIds.length} 条 Evidence；置信度 ${memory.confidence.toFixed(2)}`,
    ].filter(Boolean).join('\n')
  }

  private injectedIdsFor(sessionId: string): Set<string> {
    const existing = this.injectedIdsBySession.get(sessionId)
    if (existing) return existing

    const created = new Set<string>()
    this.injectedIdsBySession.set(sessionId, created)
    while (this.injectedIdsBySession.size > InjectedSessionsMax) {
      const oldest = this.injectedIdsBySession.keys().next().value
      if (!oldest) break
      this.injectedIdsBySession.delete(oldest)
    }
    return created
  }

  private truncate(value: string, maxLength: number): string {
    const normalized = value.trim()
    if (normalized.length <= maxLength) return normalized
    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
  }
}
