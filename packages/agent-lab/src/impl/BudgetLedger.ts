/**
 * 用量账本：一本账只记它自己那段时间的用量。整程一本、每段再开一本，两本各自和各自的预算比。
 */
import type { BudgetLimit } from '../contract/constants.js'
import type { Budget, BudgetUsage, Observation } from '../types/agent-lab.js'
import { exceededBudget, maximumNullable } from '../utils/budget.js'
import { collectToolCalls } from '../utils/measure/normalize.js'

/**
 * 一本用量账本。
 *
 * **口径**：墙钟从这本账开张时算起，工具调用与 token 取这段时间里驱动报上来的累计值。
 * 整程一本（旅程开头开），每段再开一本（`beginLeg`）：段预算拿本段账本比，整程预算拿整程账本比。
 * 两者混用就是「第二段刚开始就被整程时间判成超预算」的来源，而驱动那边的等待本来就是按本段计时的。
 * 账本是包内的东西，不出包。
 */
export interface BudgetLedgerApi {
  /** 开一本只记本段的账本：墙钟从现在起算，段预算按它判。 */
  beginLeg: () => BudgetLedgerApi
  /** 记一次观测：工具调用按 `unique-tool-call` 数，token 取观测里的总量，墙钟刷到现在。 */
  observe: (observation: Observation) => void
  /** 记一次驱动自己报的用量：每一维都取「已知的较大者」，驱动报不出来的维度不覆盖已有的。 */
  observeDriverUsage: (usage: BudgetUsage) => void
  /** 记一段跑完：墙钟刷到现在，段数加一。 */
  finishLeg: () => void
  /** 取这一刻的用量快照；墙钟总是刷到现在。 */
  snapshot: () => BudgetUsage
  /** 这本账超了哪一维就返回哪一维；都没超返回 `null`。 */
  exceeded: (limit: Budget) => BudgetLimit | null
}

export class BudgetLedger implements BudgetLedgerApi {
  private readonly startedAt: number

  private currentUsage: BudgetUsage

  constructor(
    private readonly now: () => number,
    startedAt = now()
  ) {
    this.startedAt = startedAt
    this.currentUsage = { toolCalls: null, workingMs: null, wallClockMs: 0, tokens: null, legs: 0 }
  }

  public beginLeg(): BudgetLedgerApi {
    return new BudgetLedger(this.now, this.now())
  }

  public observe(observation: Observation): void {
    const calls =
      observation.coverage.turns === 'none' ? null : collectToolCalls(observation).length
    const tokens = observation.usage?.totalTokens ?? null
    this.currentUsage = {
      ...this.currentUsage,
      toolCalls: maximumNullable(this.currentUsage.toolCalls, calls),
      wallClockMs: Math.max(0, this.now() - this.startedAt),
      tokens: maximumNullable(this.currentUsage.tokens, tokens),
    }
  }

  public observeDriverUsage(usage: BudgetUsage): void {
    this.currentUsage = {
      toolCalls: maximumNullable(this.currentUsage.toolCalls, usage.toolCalls),
      workingMs: maximumNullable(this.currentUsage.workingMs, usage.workingMs),
      wallClockMs: Math.max(this.currentUsage.wallClockMs ?? 0, usage.wallClockMs ?? 0),
      tokens: maximumNullable(this.currentUsage.tokens, usage.tokens),
      legs: Math.max(this.currentUsage.legs, usage.legs),
    }
  }

  public finishLeg(): void {
    this.currentUsage = {
      ...this.currentUsage,
      wallClockMs: Math.max(0, this.now() - this.startedAt),
      legs: this.currentUsage.legs + 1,
    }
  }

  public snapshot(): BudgetUsage {
    return {
      ...this.currentUsage,
      wallClockMs: Math.max(this.currentUsage.wallClockMs ?? 0, this.now() - this.startedAt),
    }
  }

  public exceeded(limit: Budget): BudgetLimit | null {
    return exceededBudget(this.snapshot(), limit)
  }
}
