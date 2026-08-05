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

/**
 * 一个分区借用别人的空闲额度之后，本轮的有效上限。
 *
 * **借的是窗口的真实余量，不是别人账面上那份软上限之和**（考古 U30 的修复）。旧口径把可借额度
 * 算成"别人的软上限减去别人的保底或实占"，可十个分区的软上限占比之和是 1.62、保底之和只有
 * 0.43，于是空账本下随便哪个分区能借到的都已经超过整个窗口，外面那层钳制把每个分区都钳成
 * "能借到全窗口"。后果不是"预算偏松"，是**根本没有分区预算**：超额恒为零，超额诊断永远是空的，
 * 工具分区拿到的字符预算等于整个可用窗口，换页器形同虚设。
 *
 * 现在的口径：一个分区最多用到**窗口减去别人已经占住的部分**（别人占住的 = 保底与实占里的较大
 * 者），下界是它自己的软上限（那是它的保证份额，不因别人挤占而被剥夺）。三条性质：① 恒不超过
 * 可用窗口；② 随别人的实际占用单调收紧，账本填满时才真的产生超额，回收阶梯因此重新拿到信号；
 * ③ 空账本下退化为"窗口减去别人的保底之和"，仍然宽松但有界。
 *
 * **没有把分区预算降级成纯诊断**：工具分区的字符预算有两个活消费者（运行计划里的工具描述预算、
 * 溢出降级阶梯的收窄档）。改成"只报不约束"等于要另发明一个工具描述预算源，那比修借用语义的
 * 改动更大。另注意送核门不看分区预算，本修复不改变任何一次请求的可发性。
 */
function resolveZoneEffectiveLimit(input: {
  zone: ContextWorkingSetZoneId
  usableContextWindow: number
  baseBudgets: ReturnType<typeof resolveBaseZoneBudgets>
  usedByZone: Record<ContextWorkingSetZoneId, number>
}): number {
  const target = input.baseBudgets[input.zone]
  let committedByOthers = 0

  for (const otherZone of ContextWorkingSetZoneIds) {
    if (otherZone === input.zone) {
      continue
    }

    const budget = input.baseBudgets[otherZone]
    committedByOthers += Math.max(budget.reservedTokens, input.usedByZone[otherZone])
  }

  const globalRemainder = input.usableContextWindow - committedByOthers
  return Math.min(input.usableContextWindow, Math.max(target.limitTokens, globalRemainder))
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
