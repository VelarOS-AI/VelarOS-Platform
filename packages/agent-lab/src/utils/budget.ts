/**
 * 预算的两件事：段预算怎么覆盖整程预算，以及一份用量有没有超过一份预算。
 * 账本与轮询驱动共用这一份判定，两边口径因此一定一致。
 */
import type { BudgetLimit } from '../contract/constants.js'
import { BudgetLimits } from '../contract/constants.js'
import type { Budget, BudgetUsage, PartialBudget } from '../types/agent-lab.js'

/** 段预算覆盖整程预算：只覆盖段里明确写了的那几维（写 `null` 也算写了，表示这一维不设限）。 */
export function resolveBudget(base: Budget, override: PartialBudget | null): Budget {
  if (!override) return base
  return {
    toolCalls: override.toolCalls === undefined ? base.toolCalls : override.toolCalls,
    workingMs: override.workingMs === undefined ? base.workingMs : override.workingMs,
    wallClockMs: override.wallClockMs === undefined ? base.wallClockMs : override.wallClockMs,
    tokens: override.tokens === undefined ? base.tokens : override.tokens,
    legs: override.legs === undefined ? base.legs : override.legs,
  }
}

/** 这份用量超了哪一维就返回哪一维；没观测到的维度（`null`）不算超。 */
export function exceededBudget(usage: BudgetUsage, budget: Budget): BudgetLimit | null {
  for (const field of BudgetLimits) {
    const maximum = budget[field]
    const consumed = usage[field]
    if (maximum !== null && consumed !== null && consumed > maximum) return field
  }
  return null
}

/** 两个可能未知的数取较大的那个；都未知才是未知。 */
export function maximumNullable(current: number | null, next: number | null): number | null {
  if (current === null) return next
  if (next === null) return current
  return Math.max(current, next)
}
