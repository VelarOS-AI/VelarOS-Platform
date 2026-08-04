/**
 * 上下文分区预算分配器。
 *
 * 在 `contextBudget` 算出“可用窗口”（扣除输出预留 + 安全余量）之后，本模块把可用窗口
 * 当作一块物理内存，按用途切成若干分区（`zone`）并各自分配配额——类似操作系统把内存
 * 划成内核区 / 用户区 / 缓存区，各有保底与上限，压力来临时按优先级回收。
 *
 * 四个分区：
 *  - `system`：系统提示词（身份、规则、角色、编码信号）。几乎不回收。
 *  - `tools`：本轮暴露给模型的工具 `JSON Schema`。可“换页”（按预算淘汰冷工具）。
 *  - `recall`：外部检索与召回内容。压力下最先让位。
 *  - `history`：对话历史。通过压缩回收，而非整段丢弃。
 *
 * 每个分区有：
 *  - `reservedTokens`：保底配额（即使全局紧张也尽量保留）。
 *  - `limitTokens`：软上限（含可借用余量前的目标上限）。
 *  - `evictionPriority`：回收优先级，数字越小越先被回收。
 *
 * 借用语义：运行时某分区未用满的额度，可由调度器（`governor`）临时借给紧张分区，
 * 借用上限不超过其它分区的空闲额度之和；本模块只负责给出静态配额视图，借用决策在 `governor`。
 */

import { resolveContextWindowBudget } from './contextBudget'

export type ContextZoneId = 'system' | 'tools' | 'recall' | 'history'

export const ContextZoneIds: readonly ContextZoneId[] = [
  'system',
  'tools',
  'recall',
  'history',
]

export interface ContextZoneSpec {
  id: ContextZoneId
  /** 保底配额占可用窗口的比例。 */
  reservedRatio: number
  /** 软上限占可用窗口的比例。 */
  limitRatio: number
  /** 回收优先级，数字越小越先被回收/换出。 */
  evictionPriority: number
}

export interface ContextZoneBudget {
  id: ContextZoneId
  reservedTokens: number
  limitTokens: number
  evictionPriority: number
}

export interface ContextZoneAllocation {
  contextWindow: number
  usableContextWindow: number
  reservedOutputTokens: number
  safetyMarginPercent: number
  zones: Record<ContextZoneId, ContextZoneBudget>
}

/**
 * 默认分区规格。比例之和（reserved）刻意小于 1，留出全局缓冲；limit 之和可大于 1，
 * 因为分区之间允许在运行时借用彼此的空闲额度。
 */
export const DefaultContextZoneSpecs: Record<ContextZoneId, ContextZoneSpec> = {
  system: {
    id: 'system',
    reservedRatio: 0.06,
    limitRatio: 0.25,
    evictionPriority: 90,
  },
  tools: {
    id: 'tools',
    reservedRatio: 0.04,
    limitRatio: 0.3,
    evictionPriority: 40,
  },
  recall: {
    id: 'recall',
    reservedRatio: 0,
    limitRatio: 0.18,
    evictionPriority: 10,
  },
  history: {
    id: 'history',
    reservedRatio: 0.25,
    limitRatio: 0.7,
    evictionPriority: 70,
  },
}

function resolveZoneBudget(
  spec: ContextZoneSpec,
  usableContextWindow: number,
): ContextZoneBudget {
  const reservedTokens = Math.max(0, Math.floor(usableContextWindow * spec.reservedRatio))
  const limitTokens = Math.floor(usableContextWindow * spec.limitRatio)

  return {
    id: spec.id,
    reservedTokens,
    // 软上限至少不低于保底配额。
    limitTokens: Math.max(reservedTokens, limitTokens),
    evictionPriority: spec.evictionPriority,
  }
}

/** 由可用窗口推导四个分区的配额视图。 */
export function resolveContextZoneAllocation(input: {
  contextWindow: number
  usableContextWindow: number
  reservedOutputTokens: number
  safetyMarginPercent: number
  specs?: LooseOptional<Record<ContextZoneId, ContextZoneSpec>>
}): ContextZoneAllocation {
  const specs = input.specs ?? DefaultContextZoneSpecs
  const usable = Math.max(1, Math.floor(input.usableContextWindow))

  const zones = {
    system: resolveZoneBudget(specs.system, usable),
    tools: resolveZoneBudget(specs.tools, usable),
    recall: resolveZoneBudget(specs.recall, usable),
    history: resolveZoneBudget(specs.history, usable),
  } satisfies Record<ContextZoneId, ContextZoneBudget>

  return {
    contextWindow: input.contextWindow,
    usableContextWindow: usable,
    reservedOutputTokens: input.reservedOutputTokens,
    safetyMarginPercent: input.safetyMarginPercent,
    zones,
  }
}

/** 便捷入口：由上下文窗口一步得到“预算 + 分区配额”视图。 */
export function allocateContextZones(input: {
  contextWindow: number
  reservedOutputTokens?: LooseOptional<number>
  safetyMarginPercent?: LooseOptional<number>
  specs?: LooseOptional<Record<ContextZoneId, ContextZoneSpec>>
}): ContextZoneAllocation {
  const budget = resolveContextWindowBudget({
    contextWindow: input.contextWindow,
    reservedOutputTokens: input.reservedOutputTokens,
    safetyMarginPercent: input.safetyMarginPercent,
  })

  return resolveContextZoneAllocation({
    contextWindow: budget.contextWindow,
    usableContextWindow: budget.usableContextWindow,
    reservedOutputTokens: budget.reservedOutputTokens,
    safetyMarginPercent: budget.safetyMarginPercent,
    specs: input.specs,
  })
}

/**
 * 某分区在“借用其它分区空闲额度”后的有效上限。
 *
 * @param occupiedByZone 各分区当前实际占用（token）。
 * 借用额度 = 其它分区中（上限 − 占用）为正的部分之和，但被借出方需保住各自的保底配额。
 */
export function resolveZoneEffectiveLimit(
  allocation: ContextZoneAllocation,
  zoneId: ContextZoneId,
  occupiedByZone: Partial<Record<ContextZoneId, number>>,
): number {
  const target = allocation.zones[zoneId]
  let borrowable = 0
  for (const otherId of ContextZoneIds) {
    if (otherId === zoneId) {
      continue
    }

    const other = allocation.zones[otherId]
    const occupied = Math.max(0, occupiedByZone[otherId] ?? 0)
    // 被借出方至少保住 reserved 与当前占用中的较大者。
    const protectedFloor = Math.max(other.reservedTokens, occupied)
    const free = other.limitTokens - protectedFloor
    if (free > 0) {
      borrowable += free
    }
  }

  return target.limitTokens + borrowable
}

/** 工具分区的“有效字节预算”（token→字符按 4:1 折算），供工具换页器消费。 */
export function resolveToolSchemaCharBudget(
  allocation: ContextZoneAllocation,
  occupiedByZone: Partial<Record<ContextZoneId, number>> = {},
): number {
  const effectiveLimitTokens = resolveZoneEffectiveLimit(allocation, 'tools', occupiedByZone)
  return Math.max(0, effectiveLimitTokens) * 4
}
