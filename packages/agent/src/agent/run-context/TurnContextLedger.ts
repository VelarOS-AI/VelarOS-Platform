import { isEmpty, isFalse, isNotNull, isUndefined } from '@velaros-ai/core'

import type {
  TurnContextDelta,
  TurnContextInspectHint,
  TurnContextSourceId,
  TurnContextSourcePeekInput,
} from '../../protocol/types/turnContext'

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

export interface TurnContextLedgerAppendInput {
  occurredAt?: number
  label: string
  summaryText: string
  inspect?: TurnContextInspectHint
}

export interface TurnContextLedgerPeekResult {
  generation: string
  headSeq: number
  tailSeq: number
  droppedBeforeSeq?: number
  deltas: TurnContextDelta[]
}

/**
 * 单会话单 source 的环境 delta 账本（内存 ring buffer）。
 *
 * - seq 从 1 单调递增；超出 maxEntries 淘汰最旧并记录缺口边界。
 * - summaryText/label 在 append 时一次性定稿（事件时格式化），此后任何消费方不得重排版。
 * - peek 为纯内存读取，无任何 IO。
 */
export class TurnContextLedger {
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

const DefaultLedgerMaxEntries = 100
const DefaultMaxSessions = 64

export type TurnContextAppendListener = (sessionId: string, sourceId: TurnContextSourceId) => void

/**
 * 环境 delta 写入通知总线（每宿主一个实例，经 composition 注入给账本与订阅方）。
 *
 * 可见 source 的 append 广播给订阅方（IPC 推送层自行防抖后通知 renderer 重新 peek）。
 * 状态收进实例后，多宿主同进程装配各持一份、互不串会话/串宿主——不再靠模块级全局 Set。
 * 监听器异常逐个隔离，绝不冒泡进账本写入。
 */
export class TurnContextAppendHub {
  private readonly listeners = new Set<TurnContextAppendListener>()

  /** 订阅任意 source 的 delta 写入；返回退订函数。 */
  public subscribe(listener: TurnContextAppendListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 广播一次写入通知；逐监听器隔离异常。 */
  public emit(sessionId: string, sourceId: TurnContextSourceId): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId, sourceId)
      } catch {
        // arch-guard:silent-catch-ok 通知失败不影响账本写入。
      }
    }
  }
}

/** 按 sessionId 惰性建账本；超出会话数按插入序淘汰最旧（Map 迭代序即插入序）。 */
export class TurnContextSessionLedgers {
  private readonly ledgers = new Map<string, TurnContextLedger>()

  constructor(
    private readonly sourceId: TurnContextSourceId,
    private readonly options: {
      maxEntries?: number
      maxSessions?: number
      notifyRenderer?: boolean
      /** 可见 source 的写入广播总线（每宿主一个实例，经 composition 注入）；缺省则不广播。 */
      appendHub?: TurnContextAppendHub
    } = {},
  ) {}

  /** 唯一写入口：定稿 delta 并广播变更通知（供 pre-send chips 实时刷新）。 */
  public append(sessionId: string, input: TurnContextLedgerAppendInput): TurnContextDelta {
    const delta = this.for(sessionId).append(input)
    if (!isFalse(this.options.notifyRenderer)) this.options.appendHub?.emit(sessionId, this.sourceId)
    return delta
  }

  /**
   * 状态型 source 的写入口：语义见 {@link TurnContextLedger.replaceLatest}。
   *
   * 与 {@link append} 一样广播——pre-send chips 要立刻换成新状态，而不是等下一次事件。
   */
  public replaceLatest(sessionId: string, input: TurnContextLedgerAppendInput): TurnContextDelta {
    const delta = this.for(sessionId).replaceLatest(input)
    if (!isFalse(this.options.notifyRenderer)) this.options.appendHub?.emit(sessionId, this.sourceId)
    return delta
  }

  private for(sessionId: string): TurnContextLedger {
    const existing = this.ledgers.get(sessionId)
    if (existing) return existing

    // 每个账本实例一个代次：容量淘汰后重建的这一本 seq 从 1 起，旧 cursor 必须失配才不会吞它。
    const ledger = new TurnContextLedger(
      this.sourceId,
      this.options.maxEntries ?? DefaultLedgerMaxEntries,
      nextTurnContextLedgerGeneration(),
    )
    this.ledgers.set(sessionId, ledger)
    while (this.ledgers.size > (this.options.maxSessions ?? DefaultMaxSessions)) {
      const oldest = this.ledgers.keys().next().value
      if (isUndefined(oldest)) break
      this.ledgers.delete(oldest)
    }
    return ledger
  }

  public peek(
    sessionId: string,
    input: Pick<TurnContextSourcePeekInput, 'afterSeq' | 'generation'>,
  ): TurnContextLedgerPeekResult {
    const existing = this.ledgers.get(sessionId)
    if (existing) return existing.peek(input)

    // 无账本 = 该会话尚无事件：交出空基底，不为只读 peek 创建实例。
    return {
      generation: TurnContextProcessGeneration,
      headSeq: 1,
      tailSeq: 0,
      deltas: [],
    }
  }

  public clearSession(sessionId: string): void {
    this.ledgers.delete(sessionId)
  }
}
