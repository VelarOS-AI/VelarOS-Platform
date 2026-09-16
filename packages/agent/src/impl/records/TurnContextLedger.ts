import { isEmpty, isNotNull } from '@velaros-ai/core'

import type { TurnContextDelta, TurnContextSourceId, TurnContextSourcePeekInput } from '../../types/agent.js'
import type { TurnContextLedgerAppendInput, TurnContextLedgerPeekResult } from '../../types/records.js'
import { AgentTuning } from '../../utils/tuning'

/** 进程代次：重启后与持久化旧 cursor 不匹配，消费方不回放旧 delta 只重发 anchors。 */
export const TurnContextProcessGeneration: string = `g_${Date.now().toString(36)}_${Math.random()
  .toString(36)
  .slice(2, 10)}`

/**
 * 一个会话里一个 source 的环境 delta 账本，内存 ring buffer：seq 从 1 单调递增，
 * 超过 `maxEntries` 就淘汰最旧的并记下缺口边界，`peek` 纯内存读、不做任何 IO。
 *
 * 正文在 `append` 那一刻定稿（事件发生时就格式化好），消费方只管原样投给模型。
 * 实现是 `TurnContextLedger`，由 `TurnContextSessionLedgers` 按「会话 × source」建和管。
 */
export interface TurnContextLedgerApi {
  /** 本账本的代次，建的时候定死不再变。消费方拿它判断自己的 cursor 还算不算数：对不上就整段换掉，不做增量回放。 */
  readonly generation: string
  /** 记一条新的环境变化，分配下一个 seq 并返回落好的 delta；超出容量时淘汰最旧的几条，并把缺口边界记到 `droppedBeforeSeq`，下次 peek 会如实报给消费方。 */
  append(input: TurnContextLedgerAppendInput): TurnContextDelta
  /** 状态型 source 专用：先清空整本账，再记这一条，永远只留最新的一份事实。刻意不动 `droppedBeforeSeq`——容量淘汰是「你漏看了」要报缺口，取代是「那条已经不成立」，消费方本来就不该再看到它。 */
  replaceLatest(input: TurnContextLedgerAppendInput): TurnContextDelta
  /** 取消费方还没看过的那批 delta：`afterSeq` 是它上次消费到的位置，`generation` 是它手里的代次。代次对不上时不回放任何旧 delta，只交出当前基底让它重新对齐。纯读，不改账本状态。 */
  peek(input: Pick<TurnContextSourcePeekInput, 'afterSeq' | 'generation'>): TurnContextLedgerPeekResult
}

/**
 * 单会话单 source 的环境 delta 账本（内存 ring buffer）。
 *
 * - seq 从 1 单调递增；超出 maxEntries 淘汰最旧并记录缺口边界。
 * - summaryText/label 在 append 时一次性定稿（事件时格式化），此后任何消费方不得重排版。
 * - peek 为纯内存读取，无任何 IO。
 */
export class TurnContextLedger implements TurnContextLedgerApi {
  private nextSeq = 1
  private items: TurnContextDelta[] = []
  /** 有淘汰发生时，最旧保留项的 seq；无淘汰为 null。 */
  private droppedBeforeSeq: Nullable<number> = null

  constructor(
    private readonly sourceId: TurnContextSourceId,
    private readonly maxEntries: number,
    public readonly generation: string = TurnContextProcessGeneration,
  ) {}

  public append(input: TurnContextLedgerAppendInput): TurnContextDelta {
    const seq = this.nextSeq
    this.nextSeq += 1

    const delta: TurnContextDelta = {
      id: `${this.sourceId}#${seq}`,
      sourceId: this.sourceId,
      seq,
      occurredAt: input.occurredAt ?? Date.now(),
      label: input.label,
      summaryText: input.summaryText,
      inspect: input.inspect,
    }

    this.items.push(delta)
    if (this.items.length > this.maxEntries) {
      this.items = this.items.slice(this.items.length - this.maxEntries)
      this.droppedBeforeSeq = this.items[0]!.seq
    }

    return delta
  }

  /**
   * **状态型 source 专用**：后来者取代前任，本账本永远只留最新一条。
   *
   * 事件型 source（「报了 3 条错」「用户选中了对象 X」）天然是流水——每条都是独立事实，
   * 全都要投。**状态型 source 不是**：「运行已停止」与「服务正在运行」是同一个事实的两个
   * 版本，把它们一起投给模型，模型就会读到自相矛盾的两句话。
   *
   * 实测事故：运行能力重建时如实记了一条「运行已停止」（**当时是对的**），随后启动操作
   * 又记了一条运行态。两条都躺在账本里，下一回合被一起投出去，模型读了前一条，断定
   * 「服务已经停止了，需要先启动它」，于是多跑了一次启动操作。**陈旧不是记错，是没失效。**
   *
   * 语义刻意与容量淘汰区分：不动 `droppedBeforeSeq`。容量淘汰是「装不下了，你漏看了东西」，
   * 需要向消费方报缺口；取代是「那条已经不成立了」，消费方本来就不该再看到它，不是缺口。
   */
  public replaceLatest(input: TurnContextLedgerAppendInput): TurnContextDelta {
    this.items = []
    return this.append(input)
  }

  public peek(input: Pick<TurnContextSourcePeekInput, 'afterSeq' | 'generation'>): TurnContextLedgerPeekResult {
    const tailSeq = this.nextSeq - 1
    const headSeq = !isEmpty(this.items) ? this.items[0]!.seq : this.nextSeq

    // 代次不匹配（重启后持久化旧 cursor）：不回放旧 delta，只交出当前基底。
    if (isNotNull(input.generation) && input.generation !== this.generation) return {
        generation: this.generation,
        headSeq,
        tailSeq,
        deltas: [],
      }

    const afterSeq = Math.max(0, input.afterSeq)
    const deltas = this.items.filter((item) => item.seq > afterSeq)
    const hasGap = isNotNull(this.droppedBeforeSeq) && afterSeq + 1 < this.droppedBeforeSeq

    return {
      generation: this.generation,
      headSeq,
      tailSeq,
      droppedBeforeSeq: hasGap ? this.droppedBeforeSeq! : undefined,
      deltas,
    }
  }
}

/** 单条回合上下文账本的条目上限，值在 `AgentTuning.records.turnContextLedgerMaxEntries`。 */
export const DefaultLedgerMaxEntries: number = AgentTuning.records.turnContextLedgerMaxEntries
/** 最多同时为多少个会话保留账本，值在 `AgentTuning.records.turnContextMaxSessions`。 */
export const DefaultMaxSessions: number = AgentTuning.records.turnContextMaxSessions

