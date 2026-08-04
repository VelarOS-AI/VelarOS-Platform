import { resolveContextWindowBudget } from '@velaros-ai/agent'
import { isFiniteNumber } from '@velaros-ai/core'

import type { ContextLedgerEntry } from './ContextLedger'
import {
  type ContextWorkingSetReclaimAction,
  type ContextWorkingSetZoneId,
  ContextWorkingSetZoneIds,
  type ContextWorkingSetZonePolicy,
  DefaultContextWorkingSetZonePolicies,
} from './ContextWorkingSetZones'

export interface ContextWorkingSetBudgetLedgerEntry {
  zone: string
  estimatedTokens: number
}

export interface ContextWorkingSetBudgetGovernorInput {
  contextWindow: number
  usableContextWindow?: LooseOptional<number>
  reservedOutputTokens?: LooseOptional<number>
  safetyMarginPercent?: LooseOptional<number>
  ledger: readonly ContextWorkingSetBudgetLedgerEntry[]
  policies?: LooseOptional<Record<ContextWorkingSetZoneId, ContextWorkingSetZonePolicy>>
}

export interface ContextWorkingSetZoneBudgetSnapshot {
  zone: ContextWorkingSetZoneId
  reservedTokens: number
  limitTokens: number
  effectiveLimitTokens: number
  usedTokens: number
  overBudgetTokens: number
  priority: number
  reclaimOrder: ContextWorkingSetReclaimAction[]
}

export interface ContextWorkingSetBudgetAllocation {
  contextWindow: number
  usableContextWindow: number
  reservedOutputTokens: number
  safetyMarginPercent: number
  totalUsedTokens: number
  totalOverBudgetTokens: number
  zones: Record<ContextWorkingSetZoneId, ContextWorkingSetZoneBudgetSnapshot>
}

function positiveFloor(value: unknown): number {
  return isFiniteNumber(value) ? Math.max(0, Math.floor(value)) : 0
}

function isContextWorkingSetZoneId(value: string): value is ContextWorkingSetZoneId {
  return (ContextWorkingSetZoneIds as readonly string[]).includes(value)
}

function resolveBudgetEnvelope(input: ContextWorkingSetBudgetGovernorInput): {
  contextWindow: number
  usableContextWindow: number
  reservedOutputTokens: number
  safetyMarginPercent: number
} {
  const explicitUsable = positiveFloor(input.usableContextWindow)
  if (explicitUsable > 0) {
    const contextWindow = Math.max(1, positiveFloor(input.contextWindow), explicitUsable)
    return {
      contextWindow,
      usableContextWindow: explicitUsable,
      reservedOutputTokens: positiveFloor(input.reservedOutputTokens),
      safetyMarginPercent: positiveFloor(input.safetyMarginPercent),
    }
  }

  return resolveContextWindowBudget({
    contextWindow: input.contextWindow,
    reservedOutputTokens: input.reservedOutputTokens,
    safetyMarginPercent: input.safetyMarginPercent,
  })
}

function resolveUsedTokensByZone(
  ledger: readonly ContextWorkingSetBudgetLedgerEntry[]
): Record<ContextWorkingSetZoneId, number> {
  const usedByZone = Object.fromEntries(
    ContextWorkingSetZoneIds.map((zone) => [zone, 0])
  ) as Record<ContextWorkingSetZoneId, number>

  for (const entry of ledger) {
    if (!isContextWorkingSetZoneId(entry.zone)) {
      continue
    }

    usedByZone[entry.zone] += positiveFloor(entry.estimatedTokens)
  }

  return usedByZone
}

function resolveBaseZoneBudgets(
  usableContextWindow: number,
  policies: Record<ContextWorkingSetZoneId, ContextWorkingSetZonePolicy>
): Record<
  ContextWorkingSetZoneId,
  Pick<
    ContextWorkingSetZoneBudgetSnapshot,
    'zone' | 'reservedTokens' | 'limitTokens' | 'priority' | 'reclaimOrder'
  >
> {
  return Object.fromEntries(
    ContextWorkingSetZoneIds.map((zone) => {
      const policy = policies[zone]
      const reservedTokens = Math.floor(usableContextWindow * Math.max(0, policy.reservedRatio))
      const limitTokens = Math.floor(usableContextWindow * Math.max(0, policy.limitRatio))
      return [
        zone,
        {
          zone,
          reservedTokens,
          limitTokens: Math.max(reservedTokens, limitTokens),
          priority: policy.priority,
          reclaimOrder: [...policy.reclaimOrder],
        },
      ]
    })
  ) as Record<
    ContextWorkingSetZoneId,
    Pick<
      ContextWorkingSetZoneBudgetSnapshot,
      'zone' | 'reservedTokens' | 'limitTokens' | 'priority' | 'reclaimOrder'
    >
  >
}

function resolveZoneEffectiveLimit(input: {
  zone: ContextWorkingSetZoneId
  usableContextWindow: number
  baseBudgets: ReturnType<typeof resolveBaseZoneBudgets>
  usedByZone: Record<ContextWorkingSetZoneId, number>
}): number {
  const target = input.baseBudgets[input.zone]
  let borrowableTokens = 0

  for (const otherZone of ContextWorkingSetZoneIds) {
    if (otherZone === input.zone) {
      continue
    }

    const budget = input.baseBudgets[otherZone]
    const protectedFloor = Math.max(budget.reservedTokens, input.usedByZone[otherZone])
    borrowableTokens += Math.max(0, budget.limitTokens - protectedFloor)
  }

  return Math.min(input.usableContextWindow, target.limitTokens + borrowableTokens)
}

export class ContextWorkingSetBudgetGovernor {
  public static allocate(input: ContextWorkingSetBudgetGovernorInput): ContextWorkingSetBudgetAllocation {
    const envelope = resolveBudgetEnvelope(input)
    const usableContextWindow = Math.max(1, Math.floor(envelope.usableContextWindow))
    const policies = input.policies ?? DefaultContextWorkingSetZonePolicies
    const usedByZone = resolveUsedTokensByZone(input.ledger)
    const baseBudgets = resolveBaseZoneBudgets(usableContextWindow, policies)

    const zones = Object.fromEntries(
      ContextWorkingSetZoneIds.map((zone) => {
        const base = baseBudgets[zone]
        const usedTokens = usedByZone[zone]
        const effectiveLimitTokens = resolveZoneEffectiveLimit({
          zone,
          usableContextWindow,
          baseBudgets,
          usedByZone,
        })
        const snapshot: ContextWorkingSetZoneBudgetSnapshot = {
          ...base,
          effectiveLimitTokens,
          usedTokens,
          overBudgetTokens: Math.max(0, usedTokens - effectiveLimitTokens),
        }
        return [zone, snapshot]
      })
    ) as Record<ContextWorkingSetZoneId, ContextWorkingSetZoneBudgetSnapshot>

    return {
      ...envelope,
      usableContextWindow,
      totalUsedTokens: ContextWorkingSetZoneIds.reduce(
        (sum, zone) => sum + zones[zone].usedTokens,
        0
      ),
      totalOverBudgetTokens: ContextWorkingSetZoneIds.reduce(
        (sum, zone) => sum + zones[zone].overBudgetTokens,
        0
      ),
      zones,
    }
  }

  public static annotateLedger<TEntry extends ContextLedgerEntry>(
    ledger: readonly TEntry[],
    allocation: ContextWorkingSetBudgetAllocation
  ): TEntry[] {
    return ledger.map((entry) => {
      const budget = allocation.zones[entry.zone]
      return {
        ...entry,
        zoneReservedTokens: budget.reservedTokens,
        zoneLimitTokens: budget.limitTokens,
        zoneEffectiveLimitTokens: budget.effectiveLimitTokens,
        zoneUsedTokens: budget.usedTokens,
        zoneOverBudgetTokens: budget.overBudgetTokens,
      }
    })
  }

  public static resolveZoneCharBudget(
    allocation: ContextWorkingSetBudgetAllocation,
    zone: ContextWorkingSetZoneId
  ): number {
    return Math.max(0, allocation.zones[zone].effectiveLimitTokens) * 4
  }
}
