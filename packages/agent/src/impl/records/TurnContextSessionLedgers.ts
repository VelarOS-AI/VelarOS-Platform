import { isFalse, isUndefined } from '@velaros-ai/core'

import type { TurnContextDelta, TurnContextSourceId, TurnContextSourcePeekInput } from '../../types/agent.js'
import type { TurnContextAppendBus, TurnContextLedgerAppendInput, TurnContextLedgerPeekResult } from '../../types/records.js'

import { DefaultLedgerMaxEntries, DefaultMaxSessions, TurnContextLedger, TurnContextProcessGeneration } from './TurnContextLedger'

/**
 * 一个 source 在各会话上的账本登记处：按 sessionId 惰性建 `TurnContextLedger`，会话数超上限时按插入序淘汰最旧的那本。
 * 每开一本就换一个代次（进程代次 + 本实例的账本序号），重建后的账本才不会被消费方的旧 cursor 静默吞掉前几条。
 *
 * 写入是唯一入口：落账之后顺手经 `appendHub` 广播一次变更（`notifyRenderer` 显式传 false 才不广播），
 * 让发送前的环境提示能立刻刷新。实现是 `TurnContextSessionLedgers`，每个 source 一份。
 */
export interface TurnContextSessionLedgersApi {
  /** 往这个会话的账本记一条 delta（没有就先建一本），并广播一次变更通知。返回落好的 delta。 */
  append(sessionId: string, input: TurnContextLedgerAppendInput): TurnContextDelta
  /** 状态型 source 的写入口：清空这个会话的账本只留这一条，同样广播变更——界面上的状态提示要立刻换成新的，而不是等下一次事件。 */
  replaceLatest(sessionId: string, input: TurnContextLedgerAppendInput): TurnContextDelta
  /** 读这个会话还没被消费的 delta。这个会话还没有账本时交出一份空基底（generation 为进程代次、headSeq 1、tailSeq 0），不会为一次只读 peek 建账本。 */
  peek(sessionId: string, input: Pick<TurnContextSourcePeekInput, 'afterSeq' | 'generation'>): TurnContextLedgerPeekResult
  /** 丢掉这个会话的账本；会话关闭或重置时调。下次再写会建一本新的、带新代次的。 */
  clearSession(sessionId: string): void
}

/** 按 sessionId 惰性建账本；超出会话数按插入序淘汰最旧（Map 迭代序即插入序）。 */
export class TurnContextSessionLedgers implements TurnContextSessionLedgersApi {
  private readonly ledgers = new Map<string, TurnContextLedger>()

  /**
   * 本登记处开出的账本序号（每个实例自己数）。
   *
   * 账本被容量淘汰后重建时序号从 1 重新开始，代次里带上它，旧 cursor 才会失配、
   * 不至于把重建后的前几条 delta 静默吞掉（审计 U37）。
   */
  private ledgerInstanceSeq = 0

  constructor(
    private readonly sourceId: TurnContextSourceId,
    private readonly options: {
      maxEntries?: number
      maxSessions?: number
      notifyRenderer?: boolean
      /** 可见 source 的写入广播总线（每宿主一个实例，经 composition 注入）；缺省则不广播。 */
      appendHub?: TurnContextAppendBus
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
    this.ledgerInstanceSeq += 1
    const ledger = new TurnContextLedger(
      this.sourceId,
      this.options.maxEntries ?? DefaultLedgerMaxEntries,
      `${TurnContextProcessGeneration}.${this.ledgerInstanceSeq.toString(36)}`,
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

/** 给一个来源建按会话分档的回合上下文账本。 */
export function createTurnContextSessionLedgers(sourceId: TurnContextSourceId, options: {
      maxEntries?: number
      maxSessions?: number
      notifyRenderer?: boolean
      /** 可见 source 的写入广播总线（每宿主一个实例，经 composition 注入）；缺省则不广播。 */
      appendHub?: TurnContextAppendBus
    } = {}): TurnContextSessionLedgersApi {
  return new TurnContextSessionLedgers(sourceId, options)
}
