import { collectToolCalls } from "../detect/index.js";
import type {
  Budget,
  BudgetUsage,
  Observation,
  PartialBudget,
} from "../protocol/index.js";

export type BudgetLimit = keyof Budget;

export function resolveBudget(
  base: Budget,
  override: PartialBudget | null,
): Budget {
  if (!override) return base;
  return {
    toolCalls:
      override.toolCalls === undefined ? base.toolCalls : override.toolCalls,
    workingMs:
      override.workingMs === undefined ? base.workingMs : override.workingMs,
    wallClockMs:
      override.wallClockMs === undefined
        ? base.wallClockMs
        : override.wallClockMs,
    tokens: override.tokens === undefined ? base.tokens : override.tokens,
    legs: override.legs === undefined ? base.legs : override.legs,
  };
}

function maximumNullable(
  current: number | null,
  next: number | null,
): number | null {
  if (current === null) return next;
  if (next === null) return current;
  return Math.max(current, next);
}

export class BudgetLedger {
  private readonly startedAt: number;
  private currentUsage: BudgetUsage;

  constructor(
    private readonly now: () => number,
    startedAt = now(),
  ) {
    this.startedAt = startedAt;
    this.currentUsage = {
      toolCalls: null,
      workingMs: null,
      wallClockMs: 0,
      tokens: null,
      legs: 0,
    };
  }

  public observe(observation: Observation): void {
    const calls =
      observation.coverage.turns === "none"
        ? null
        : collectToolCalls(observation).length;
    const tokens = observation.usage?.totalTokens ?? null;
    this.currentUsage = {
      ...this.currentUsage,
      toolCalls: maximumNullable(this.currentUsage.toolCalls, calls),
      wallClockMs: Math.max(0, this.now() - this.startedAt),
      tokens: maximumNullable(this.currentUsage.tokens, tokens),
    };
  }

  public observeDriverUsage(usage: BudgetUsage): void {
    this.currentUsage = {
      toolCalls: maximumNullable(this.currentUsage.toolCalls, usage.toolCalls),
      workingMs: maximumNullable(this.currentUsage.workingMs, usage.workingMs),
      wallClockMs: Math.max(
        this.currentUsage.wallClockMs ?? 0,
        usage.wallClockMs ?? 0,
      ),
      tokens: maximumNullable(this.currentUsage.tokens, usage.tokens),
      legs: Math.max(this.currentUsage.legs, usage.legs),
    };
  }

  public finishLeg(): void {
    this.currentUsage = {
      ...this.currentUsage,
      wallClockMs: Math.max(0, this.now() - this.startedAt),
      legs: this.currentUsage.legs + 1,
    };
  }

  public snapshot(): BudgetUsage {
    return {
      ...this.currentUsage,
      wallClockMs: Math.max(
        this.currentUsage.wallClockMs ?? 0,
        this.now() - this.startedAt,
      ),
    };
  }

  public exceeded(limit: Budget): BudgetLimit | null {
    const usage = this.snapshot();
    const fields: readonly BudgetLimit[] = [
      "toolCalls",
      "workingMs",
      "wallClockMs",
      "tokens",
      "legs",
    ];
    for (const field of fields) {
      const maximum = limit[field];
      const consumed = usage[field];
      if (maximum !== null && consumed !== null && consumed > maximum)
        return field;
    }
    return null;
  }
}
