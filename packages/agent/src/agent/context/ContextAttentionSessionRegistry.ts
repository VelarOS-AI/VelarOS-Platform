import { isEmpty,toNullable } from '@velaros-ai/core'
import type { ChatContextDebugTraceEntry } from '@velaros-ai/core/types'

import { shortHash } from './providerRequest/contentHash'
import { ContextRetrievalBoundedRecentMap } from './retrieval/BoundedRecentMap'
import {
  type ContextAttentionBlockOutcome,
  ContextAttentionOutcomeRecorder,
} from './ContextAttentionOutcomeRecorder'
import type { ContextAttentionReplayRecorder } from './ContextAttentionReplayRecorder'
import type { ContextAttentionRouterResult } from './ContextAttentionRouter'
import type { ContextWorkingSetBlock } from './ContextLedger'

/**
 * 注意力路由的会话级运行时状态**登记处**（每个宿主一个实例）。
 *
 * 三个职责：
 * 1. 记住每个会话上一次已应用路由的降级动作，供路由器做跨回合粘滞（稳定提供方前缀缓存）；
 * 2. 持有宿主注入的回放记录器工厂，把每次路由决策落盘给 context:replay / context:benchmark 消费；
 * 3. 汇集 recall_context 的结果信号（召回成功/引用失效）到 OutcomeRecorder，
 *    反馈给下一轮路由：反复召回的块提升为 inline，召回失败的块永不再降级。
 *
 * **块身份内容寻址（跨回合正确性）**：块的位置键 `message:<index>` 只在单次编译内有效——
 * compactHistory 折叠旧 turns 后 index 整体平移，用位置键存粘滞/outcome 会把上轮 `message:12`
 * 的降级与召回计数错套到本轮位于 12 的另一条消息上。故跨回合状态一律按**内容指纹**（块正文
 * 的 shortHash）寻址，读时用本轮真实块重建位置键映射：内容漂移到新位置的块仍继承其状态，
 * 落到旧位置的新块不会误继承。召回引用→指纹映射有界（LRU），不再只增不清无界增长。
 *
 * agent-runtime 不感知存储路径；宿主（桌面主进程）在组装时通过构造参数 `replayRecorderFactory`
 * 注入落盘实现。状态收进实例后，多宿主同进程装配各持一份、互不串会话。
 */

const DefaultMaxTrackedSessions = 128
/** 单会话召回引用→内容指纹映射的上限（有界，防止折叠句柄只增不清无界增长）。 */
const MaxRecallRefsPerSession = 512

/** 块的内容指纹：跨回合稳定的身份键（位置键 `message:<index>` 压缩后会漂移，不可跨回合用）。 */
function contextAttentionBlockSignature(block: ContextWorkingSetBlock): string {
  return shortHash(block.contentText ?? '')
}

export type ContextAttentionReplayRecorderFactory = (
  sessionId: string
) => Nullable<ContextAttentionReplayRecorder>

export interface ContextAttentionRecallOutcomeInput {
  /** recall_context 使用的引用：blockId、toolCallId、tool:*、ctx-payload:* 均可。 */
  ref: string
  /** 召回是否找到内容；false 记为 missing-context（降级不可恢复的强负信号）。 */
  found: boolean
}

/**
 * outcome 回学的旁路观察端口。**只写不读**——本 registry 的运行时权威仍是内存 OutcomeRecorder
 * （LRU），观察者不参与回学决策。窄结构接口不 import 观测域；宿主决定记录介质与领域映射。
 */
export interface ContextAttentionOutcomeObserver {
  recordContextAttentionOutcome(
    sessionId: string,
    input: { blockId: string; found: boolean; retainedUtility: Nullable<number> }
  ): void
}

export interface ContextAttentionSessionRegistryOptions {
  /** 宿主注入的回放记录器工厂；缺省关闭落盘。 */
  replayRecorderFactory?: LooseOptional<ContextAttentionReplayRecorderFactory>
  /** 跨回合粘滞状态的最大会话数；超过后按 updatedAt 淘汰最旧。 */
  maxTrackedSessions?: LooseOptional<number>
}

interface ContextAttentionSessionState {
  /** 上一次已应用路由的降级动作，按**内容指纹**寻址（跨回合稳定，压缩位移后不漂移）。 */
  downgradesByContentSig: Map<string, ChatContextDebugTraceEntry['action']>
  /** 召回引用 → 内容指纹归因：折叠句柄指引模型用 toolCallId 或 blockId 召回；有界 LRU。 */
  recallSigByRef: ContextRetrievalBoundedRecentMap<string>
  /** outcome 按内容指纹入账（OutcomeRecorder 的 blockId 槽承载指纹，对其透明）。 */
  outcomeRecorder: ContextAttentionOutcomeRecorder
  updatedAt: number
}

export class ContextAttentionSessionRegistry {
  private readonly sessionStates = new Map<string, ContextAttentionSessionState>()
  private readonly replayRecordersBySessionId = new Map<string, ContextAttentionReplayRecorder>()
  private readonly replayRecorderFactory: Nullable<ContextAttentionReplayRecorderFactory>
  private readonly maxTrackedSessions: number
  /** outcome 观察端口（宿主晚绑，缺省 null）。 */
  private outcomeObserver: Nullable<ContextAttentionOutcomeObserver> = null

  constructor(options: ContextAttentionSessionRegistryOptions = {}) {
    this.replayRecorderFactory = toNullable(options.replayRecorderFactory)
    this.maxTrackedSessions = options.maxTrackedSessions ?? DefaultMaxTrackedSessions
  }

  /** 晚绑 outcome 观察端口；只写不读，运行时回学仍走内存 recorder。 */
  public setOutcomeObserver(observer: ContextAttentionOutcomeObserver): void {
    this.outcomeObserver = observer
  }

  /**
   * 读取会话上一次已应用路由的降级动作，按**本轮真实块**重建位置键 → 动作映射；无记录返回 null。
   *
   * 存储按内容指纹寻址：这里对每个当前块算指纹，命中上轮降级则以该块**本轮的** blockId 为键
   * 回填。压缩位移后，内容仍在的块继承其粘滞、落到旧位置的新块不误继承。
   */
  public readSessionActions(
    sessionId: LooseOptional<string>,
    blocks: readonly ContextWorkingSetBlock[]
  ): Nullable<ReadonlyMap<string, ChatContextDebugTraceEntry['action']>> {
    const key = sessionId?.trim()
    if (!key) return null

    const state = this.sessionStates.get(key)
    if (!state || state.downgradesByContentSig.size === 0) return null

    const actionsByBlockId = new Map<string, ChatContextDebugTraceEntry['action']>()
    for (const block of blocks) {
      const action = state.downgradesByContentSig.get(contextAttentionBlockSignature(block))
      if (action) actionsByBlockId.set(block.id, action)
    }

    return actionsByBlockId.size > 0 ? actionsByBlockId : null
  }

  /**
   * 记录本次已应用路由的降级动作快照。
   *
   * 只在路由真正改写了提供方消息时调用（ledgerActionsByBlockId 非空即已应用）；
   * shadow/校验失败回退不更新粘滞状态。
   *
   * blocks 用于建立召回归因：折叠句柄让模型用 toolCallId（tool-payload）或
   * blockId（context-handle）召回，这里把两种 ref 都映射回 blockId。
   */
  public writeSessionActions(
    sessionId: LooseOptional<string>,
    route: ContextAttentionRouterResult,
    blocks?: readonly ContextWorkingSetBlock[]
  ): void {
    const key = sessionId?.trim()
    if (!key || route.ledgerActionsByBlockId.size === 0) return

    const state = this.resolveSessionState(key)
    const blockById = new Map((blocks ?? []).map((block) => [block.id, block]))
    state.downgradesByContentSig = new Map()

    for (const entry of route.trace) {
      if (entry.action !== 'handle' && entry.action !== 'summarize') continue

      const block = blockById.get(entry.target)
      if (!block) continue

      const sig = contextAttentionBlockSignature(block)
      state.downgradesByContentSig.set(sig, entry.action)

      // 召回引用 → 内容指纹：折叠句柄让模型用 blockId（context-handle 摘要）或
      // toolCallId（tool-payload）召回，两种 ref 都指向同一内容指纹。
      state.recallSigByRef.set(block.id, sig)
      const toolCallId = block.provenance?.toolCallId?.trim()
      if (toolCallId) {
        state.recallSigByRef.set(toolCallId, sig)
        state.recallSigByRef.set(`tool:${toolCallId}`, sig)
      }
    }

    state.updatedAt = Date.now()
  }

  /**
   * 回学信号入口：recall_context 每次精确取回后调用。
   *
   * 只统计能归因到路由降级块的召回；payload-planner 等其它折叠机制的引用
   * 不属于注意力路由的决策，直接忽略。
   */
  public recordRecallOutcome(
    sessionId: LooseOptional<string>,
    input: ContextAttentionRecallOutcomeInput
  ): Nullable<ContextAttentionBlockOutcome> {
    const key = sessionId?.trim()
    const ref = input.ref.trim()
    if (!key || !ref) return null

    const state = this.sessionStates.get(key)
    if (!state) return null

    const contentSig = state.recallSigByRef.get(ref)
    if (!contentSig) return null

    state.updatedAt = Date.now()
    const outcome = state.outcomeRecorder.record({
      blockId: contentSig,
      action: state.downgradesByContentSig.get(contentSig) ?? 'inline',
      signal: input.found ? 'recalled' : 'missing-context',
    })
    if (this.outcomeObserver) {
      try {
        this.outcomeObserver.recordContextAttentionOutcome(key, {
          blockId: contentSig,
          found: input.found,
          retainedUtility: outcome.retainedUtility,
        })
      } catch {
        // arch-guard:silent-catch-ok 旁路观察失败不得冒泡进回学；无 warn 通道故静默
      }
    }
    return outcome
  }

  /**
   * 读取会话累计的块级结果信号，按**本轮真实块**重建位置键 → outcome 映射；无记录返回 null。
   *
   * outcome 按内容指纹入账，这里对每个当前块算指纹并回填其**本轮的** blockId，压缩位移后
   * 召回/失败计数仍准确归到内容对应的块，不错套。
   */
  public readSessionOutcomes(
    sessionId: LooseOptional<string>,
    blocks: readonly ContextWorkingSetBlock[]
  ): Nullable<ReadonlyMap<string, ContextAttentionBlockOutcome>> {
    const key = sessionId?.trim()
    if (!key) return null

    const state = this.sessionStates.get(key)
    if (!state) return null

    const snapshot = state.outcomeRecorder.snapshot()
    if (isEmpty(snapshot.blocks)) return null

    const outcomeBySig = new Map(snapshot.blocks.map((outcome) => [outcome.blockId, outcome]))
    const outcomesByBlockId = new Map<string, ContextAttentionBlockOutcome>()
    for (const block of blocks) {
      const outcome = outcomeBySig.get(contextAttentionBlockSignature(block))
      if (outcome) outcomesByBlockId.set(block.id, outcome)
    }

    return outcomesByBlockId.size > 0 ? outcomesByBlockId : null
  }

  /** 按会话解析（并缓存）回放记录器；未注入工厂时返回 null。 */
  public resolveReplayRecorder(
    sessionId: LooseOptional<string>
  ): Nullable<ContextAttentionReplayRecorder> {
    const key = sessionId?.trim()
    if (!key || !this.replayRecorderFactory) return null

    const cached = this.replayRecordersBySessionId.get(key)
    if (cached) return cached

    const recorder = this.replayRecorderFactory(key)
    if (recorder) this.replayRecordersBySessionId.set(key, recorder)
    return recorder
  }

  /**
   * 失效通道：丢弃某会话的全部跨回合注意力状态（粘滞/召回归因/outcome）。
   *
   * 内容寻址已让压缩位移自愈（漂移块的旧指纹自然不再命中），此 API 供宿主在硬上下文事件
   * （会话重置 / handoff / 清空）时显式清场，避免陈旧指纹长尾滞留。
   */
  public invalidateSession(sessionId: LooseOptional<string>): void {
    const key = sessionId?.trim()
    if (!key) return
    this.sessionStates.delete(key)
    this.replayRecordersBySessionId.delete(key)
  }

  private resolveSessionState(key: string): ContextAttentionSessionState {
    const existing = this.sessionStates.get(key)
    if (existing) return existing

    const created: ContextAttentionSessionState = {
      downgradesByContentSig: new Map(),
      recallSigByRef: new ContextRetrievalBoundedRecentMap<string>(MaxRecallRefsPerSession),
      outcomeRecorder: new ContextAttentionOutcomeRecorder(),
      updatedAt: Date.now(),
    }
    this.sessionStates.set(key, created)
    this.evictOldestSessionsBeyondLimit()
    return created
  }

  private evictOldestSessionsBeyondLimit(): void {
    if (this.sessionStates.size <= this.maxTrackedSessions) return

    const oldestFirst = [...this.sessionStates.entries()].sort(
      (left, right) => left[1].updatedAt - right[1].updatedAt
    )
    for (const [sessionId] of oldestFirst.slice(0, this.sessionStates.size - this.maxTrackedSessions)) {
      this.sessionStates.delete(sessionId)
      this.replayRecordersBySessionId.delete(sessionId)
    }
  }
}
