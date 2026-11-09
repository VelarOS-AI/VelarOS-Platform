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
 * 观测是会话累计快照，段账必须拿真实开段基线求差；原生用量只累计当前 send 段，整程按段相加。
 * 两个来源测的是同一批调用，取已知较大者而不相加。基线或某段原生用量未知时保持未知。
 * 墙钟归本账时钟，完成段数只由运行器登记，不把驱动报的段数再加一次。
 * 账本是包内的东西，不出包。
 */
export interface BudgetLedgerApi {
  /** 用发送前的真实观测开本段账；墙钟仍从实际开段时刻算起。 */
  beginLeg: (baseline: Observation, startedAt: number) => BudgetLedgerApi
  /** 记一次观测：工具调用按 `unique-tool-call` 数，token 取观测里的总量，墙钟刷到现在。 */
  observe: (observation: Observation) => void
  /** 记当前段的原生累计用量；重复采样不重复收费，未知不当成零。 */
  observeDriverUsage: (usage: BudgetUsage) => void
  /** 结清当前段的原生用量，完成段数只加一次。 */
  finishLeg: () => void
  /** 取这一刻的用量快照；墙钟总是刷到现在。 */
  snapshot: () => BudgetUsage
  /** 这本账超了哪一维就返回哪一维；都没超返回 `null`。 */
  exceeded: (limit: Budget) => BudgetLimit | null
}

export class BudgetLedger implements BudgetLedgerApi {
  private readonly baseline: {
    readonly toolCallIds: ReadonlySet<string> | null
    readonly tokens: number | null
  } | null

  private observedToolCalls: number | null = null

  private observedTokens: number | null = null

  private nativeUsage: Pick<BudgetUsage, 'toolCalls' | 'workingMs' | 'tokens'> | null = null

  // 尚无已结束段时的空和；不能拿它替代缺失的当前段读数。
  private finishedNativeUsage: Pick<BudgetUsage, 'toolCalls' | 'workingMs' | 'tokens'> = {
    toolCalls: 0,
    workingMs: 0,
    tokens: 0,
  }

  private completedLegs = 0

  constructor(
    private readonly now: () => number,
    private readonly startedAt = now(),
    baseline: Observation | null = null
  ) {
    this.baseline =
      baseline === null
        ? null
        : {
            toolCallIds:
              baseline.coverage.turns === 'full'
                ? new Set(collectToolCalls(baseline).map((call) => call.id))
                : null,
            tokens: baseline.usage?.totalTokens ?? null,
          }
  }

  public beginLeg(baseline: Observation, startedAt: number): BudgetLedgerApi {
    return new BudgetLedger(this.now, startedAt, baseline)
  }

  public observe(observation: Observation): void {
    let calls: number | null = null
    if (observation.coverage.turns !== 'none') {
      const toolCalls = collectToolCalls(observation)
      if (this.baseline === null) calls = toolCalls.length
      else {
        const baselineIds = this.baseline.toolCallIds
        if (baselineIds !== null)
          calls = toolCalls.filter((call) => !baselineIds.has(call.id)).length
      }
    }
    let tokens = observation.usage?.totalTokens ?? null
    if (this.baseline !== null) {
      if (this.baseline.tokens === null || tokens === null) tokens = null
      else if (tokens < this.baseline.tokens) throw new Error('会话累计 token 不能小于开段基线')
      else tokens -= this.baseline.tokens
    }
    this.observedToolCalls = maximumNullable(this.observedToolCalls, calls)
    this.observedTokens = maximumNullable(this.observedTokens, tokens)
  }

  public observeDriverUsage(usage: BudgetUsage): void {
    this.nativeUsage = {
      toolCalls: maximumNullable(this.nativeUsage?.toolCalls ?? null, usage.toolCalls),
      workingMs: maximumNullable(this.nativeUsage?.workingMs ?? null, usage.workingMs),
      tokens: maximumNullable(this.nativeUsage?.tokens ?? null, usage.tokens),
    }
  }

  public finishLeg(): void {
    this.finishedNativeUsage = {
      toolCalls: this.nativeUsage === null ? null : this.nativeTotal('toolCalls'),
      workingMs: this.nativeUsage === null ? null : this.nativeTotal('workingMs'),
      tokens: this.nativeUsage === null ? null : this.nativeTotal('tokens'),
    }
    this.nativeUsage = null
    this.completedLegs += 1
  }

  public snapshot(): BudgetUsage {
    return {
      toolCalls: maximumNullable(this.observedToolCalls, this.nativeTotal('toolCalls')),
      workingMs: this.nativeTotal('workingMs'),
      wallClockMs: Math.max(0, this.now() - this.startedAt),
      tokens: maximumNullable(this.observedTokens, this.nativeTotal('tokens')),
      legs: this.baseline === null ? this.completedLegs : 1,
    }
  }

  public exceeded(limit: Budget): BudgetLimit | null {
    return exceededBudget(this.snapshot(), limit)
  }

  /** 已结束段与当前段的同源用量求和；缺失任一段就不能声称知道整程总量。 */
  private nativeTotal(field: 'toolCalls' | 'workingMs' | 'tokens'): number | null {
    const completed = this.finishedNativeUsage[field]
    if (this.nativeUsage === null) return this.completedLegs === 0 ? null : completed
    const current = this.nativeUsage[field]
    return completed === null || current === null ? null : completed + current
  }
}
