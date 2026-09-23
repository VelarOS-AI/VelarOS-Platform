import { isFiniteNumber, isNull, isPlainObject, isPresent, toNullable } from '@velaros-ai/core'

import type {
  ModelPricingCatalog,
  ModelPricingEntry,
  ModelPricingRates,
  ModelRunUsage,
  ModelUsageSummary,
} from '../types/model'

/**
 * 在单价目录里查一个 provider / 模型的单价对。
 *
 * 先按精确的 provider + model 找，再按同一条目登记的别名找；都没有就返回 null——
 * 查不到单价时账本如实不算钱，绝不按别的模型的价估一个数糊上去。
 */
export function findPricingRates(
  catalog: LooseOptional<ModelPricingCatalog>,
  provider: string,
  model: string
): Nullable<ModelPricingRates> {
  const entry = matchPricingEntry(catalog, provider, model)
  if (!entry) return null

  return {
    inputPerMillion: entry.inputUsdPerMillion,
    outputPerMillion: entry.outputUsdPerMillion,
  }
}

/** 目录里与这个 provider / 模型对上的那一条：精确名优先，其次别名。 */
function matchPricingEntry(
  catalog: LooseOptional<ModelPricingCatalog>,
  provider: string,
  model: string
): Nullable<ModelPricingEntry> {
  const entries = catalog?.entries ?? []
  const sameProvider = entries.filter((entry) => entry.provider === provider)
  return toNullable(
    sameProvider.find((entry) => entry.model === model) ??
      sameProvider.find((entry) => entry.aliases.includes(model))
  )
}

/** 把 AI SDK 各版本的 usage 形状归一成本包的账本，顺带按单价算钱。 */
export function normalizeRunUsage(value: unknown, pricing?: ModelPricingRates): ModelRunUsage {
  const inputTokens =
    tokenValue(value, ['inputTokens', 'total']) ?? tokenValue(value, ['inputTokens']) ?? 0
  const outputTokens =
    tokenValue(value, ['outputTokens', 'total']) ?? tokenValue(value, ['outputTokens']) ?? 0
  const reasoningTokens =
    tokenValue(value, ['outputTokens', 'reasoning']) ?? tokenValue(value, ['reasoningTokens']) ?? 0
  const cachedInputTokens =
    tokenValue(value, ['inputTokens', 'cacheRead']) ?? tokenValue(value, ['cachedInputTokens']) ?? 0
  const totalTokens = tokenValue(value, ['totalTokens']) ?? inputTokens + outputTokens
  const inputRate = toNullable(pricing?.inputPerMillion)
  const outputRate = toNullable(pricing?.outputPerMillion)
  const cost =
    isNull(inputRate) || isNull(outputRate)
      ? null
      : (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000
  return { inputTokens, outputTokens, reasoningTokens, cachedInputTokens, totalTokens, cost }
}

/** 已落盘的稳定 usage envelope 归一化；非法/负数 token 失败闭合为 0。 */
export function normalizePersistedUsage(value: Record<string, unknown>): ModelRunUsage {
  return {
    inputTokens: positiveNumber(value.inputTokens),
    outputTokens: positiveNumber(value.outputTokens),
    reasoningTokens: positiveNumber(value.reasoningTokens),
    cachedInputTokens: positiveNumber(value.cachedInputTokens),
    totalTokens: positiveNumber(value.totalTokens),
    cost: isFiniteNumber(value.cost) && value.cost >= 0 ? value.cost : null,
  }
}

/** 把多次调用的账本合计起来，并记住最后一轮的上下文占用。 */
export function summarizeUsage(usages: readonly ModelRunUsage[]): ModelUsageSummary {
  let inputTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  let cachedInputTokens = 0
  let totalTokens = 0
  let cost: Nullable<number> = null
  for (const usage of usages) {
    inputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
    reasoningTokens += usage.reasoningTokens
    cachedInputTokens += usage.cachedInputTokens
    totalTokens += usage.totalTokens
    if (isPresent(usage.cost)) cost = (cost ?? 0) + usage.cost
  }
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    totalTokens,
    cost,
    runs: usages.length,
    lastContextTokens: usages.at(-1)?.inputTokens ?? 0,
  }
}

/** 按路径取一个非负 token 数；取不到或不合法时返回 null。 */
function tokenValue(value: unknown, path: readonly string[]): Nullable<number> {
  let current = value
  for (const key of path) {
    if (!isRecord(current)) return null
    current = current[key]
  }
  return isFiniteNumber(current) && current >= 0 ? Math.round(current) : null
}

/** 非负有限数原样返回，其余一律算 0。 */
function positiveNumber(value: unknown): number {
  return isFiniteNumber(value) && value >= 0 ? value : 0
}

/** 是不是一个普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value)
}
