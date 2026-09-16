import { isEmpty, isNotNull } from '@velaros-ai/core'

import type { TurnContextDelta, TurnContextInspectHint, TurnContextSourceId, TurnContextSourcePeekInput } from '../../types/agent.js'


/** 进程代次：重启后与持久化旧 cursor 不匹配，消费方不回放旧 delta 只重发 anchors。 */
export const TurnContextProcessGeneration = `g_${Date.now().toString(36)}_${Math.random()
  .toString(36)
  .slice(2, 10)}`

let ledgerInstanceSeq = 0

/**
 * 账本实例代次 = 进程代次 + 实例序号。
 *
 * 账本被容量淘汰后重建时 `seq` 从 1 重新开始，而消费方的 cursor 还停在旧账本的 seq 20；
 * 代次不换代的话 `peek` 的 `seq > 20` 会把重建后的前 20 条 delta 全部静默吞掉，连缺口提示都
 * 没有（审计 U37）。换代让协议既有的"generation 不同直接替换 cursor"分支自动兜住这件事，
 * 不需要任何额外通知机制。
 */
export function nextTurnContextLedgerGeneration(): string {
  ledgerInstanceSeq += 1
  return `${TurnContextProcessGeneration}.${ledgerInstanceSeq.toString(36)}`
}

/** 往账本里记一条环境变化要填的东西：正文在这一刻就定稿，之后谁都不许重排版。 */
export interface TurnContextLedgerAppendInput {
  /** 这件事发生的时刻（毫秒时间戳）；不填就取写入时刻。事后补记时才需要显式传。 */
  occurredAt?: number
  /** 这条 delta 的短标签，投给模型时当这一行的抬头，例如来源名或操作名。 */
  label: string
  /** 投给模型的正文，`append` 时就得是最终形态：消费方原样投递，不再截断、不再拼接、不再改格式。 */
  summaryText: string
  /** 可选的细看线索：告诉模型想看全貌该调哪个工具、带什么参数。不填表示这条看完就够了。 */
  inspect?: TurnContextInspectHint
}

/** `peek` 的结果：既给这次要投的 delta，也给回下次 peek 该带的游标基底。 */
export interface TurnContextLedgerPeekResult {
  /** 本账本的代次；和消费方手里的对不上，说明账本换过一茬，消费方要整段替换自己的 cursor 而不是接着往下读。 */
  generation: string
  /** 当前还留着的最旧那条的 seq；账本空时等于下一个要发的 seq。 */
  headSeq: number
  /** 至今发出过的最大 seq；消费方消费完这批后把 cursor 记到这里。 */
  tailSeq: number
  /** 有 delta 因容量被淘汰、而且正好落在这次请求的区间里时，给出最旧保留项的 seq，表示「这条之前的你没看到」。没缺口时不带这个字段。 */
  droppedBeforeSeq?: number
  /** 这次该投的 delta，按 seq 从小到大；`afterSeq` 之后的全部，可能为空数组。 */
  deltas: TurnContextDelta[]
}

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

export const DefaultLedgerMaxEntries = 100
export const DefaultMaxSessions = 64



