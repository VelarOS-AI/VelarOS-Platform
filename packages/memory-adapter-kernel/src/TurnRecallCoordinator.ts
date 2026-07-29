import { isEmpty,Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TurnContextSessionLedgers } from '@velaros-ai/core/utils/TurnContextLedger'
import type { MemoryDomain, MemoryRecallItem } from '@velaros-ai/memory'

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

export interface MemoryTurnRecallDeps {
  recall: MemoryDomain['recall']
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
  private readonly inFlightSessions = new Set<string>()

  constructor(private readonly deps: MemoryTurnRecallDeps) {}

  /** 发送接受后调用；同步返回，召回在后台完成。 */
  public notifyUserMessage(input: MemoryTurnRecallInput): void {
    // 自动记忆关闭时既不采集也不注入，与 EvidenceBridge.canCapture 语义一致。
    if (!(this.deps.isEnabled?.() ?? true)) return
    const query = input.query.trim().slice(0, RecallQueryMaxChars)
    if (query.length < RecallMinQueryChars) return
    // 上一轮召回还在跑（模型选择最长 4s）说明用户在快速连发，跳过本轮避免堆积。
    if (this.inFlightSessions.has(input.sessionId)) return

    this.inFlightSessions.add(input.sessionId)
    void this.recall(input, query)
      .catch((error) => {
        log.debug('turn memory recall failed; skipping injection', {
          sessionId: input.sessionId,
          error: AppError.getMessage(error),
        })
      })
      .finally(() => {
        this.inFlightSessions.delete(input.sessionId)
      })
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

  private async recall(input: MemoryTurnRecallInput, query: string): Promise<void> {
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
    })
    if (isEmpty(candidates) && (this.deps.isAutomaticDeepRecallEnabled?.() ?? true)) {
      candidates = await this.deps.recall(query, {
        limit: RecallCandidateLimit,
        workspaceRoot: input.workspaceRoot?.trim() || undefined,
        scopeId: scope.scopeId,
        excludeSessionId: input.sessionId,
        excludeAgentConversationEchoes: true,
        includeDormant: true,
        deep: true,
      })
    }

    const injectedIds = this.injectedIdsFor(input.sessionId)
    const freshCandidates = candidates.filter((candidate) => !injectedIds.has(candidate.id))
    if (isEmpty(freshCandidates)) return

    for (const memory of freshCandidates.slice(0, RecallMaxInjectPerTurn)) {
      injectedIds.add(memory.id)
      this.ledgers.append(input.sessionId, {
        label: `记忆：${this.truncate(memory.title, 16)}`,
        summaryText: this.formatSummary(memory),
        inspect: { tool: 'get_memory', argsHint: { id: memory.id } },
      })
    }
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
