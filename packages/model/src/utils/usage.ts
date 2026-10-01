import { isFiniteNumber, isNull, isPlainObject, isTrue, toNullable } from '@velaros-ai/core'

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
    cacheReadPerMillion: toNullable(entry.cacheReadUsdPerMillion),
    cacheWritePerMillion: toNullable(entry.cacheWriteUsdPerMillion),
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

/** 归一用量并逐个计费分项约价；缺失用量或单价不冒充零费用。 */
export function normalizeRunUsage(value: unknown, pricing?: ModelPricingRates): ModelRunUsage {
  const input = tokenValue(value, ['inputTokens', 'total']) ?? tokenValue(value, ['inputTokens'])
  const output = tokenValue(value, ['outputTokens', 'total']) ?? tokenValue(value, ['outputTokens'])
  const inputTokens = input ?? 0
  const outputTokens = output ?? 0
  const reasoningTokens =
    tokenValue(value, ['outputTokens', 'reasoning']) ??
    tokenValue(value, ['outputTokenDetails', 'reasoningTokens']) ??
    tokenValue(value, ['reasoningTokens']) ??
    0
  const cacheRead =
    tokenValue(value, ['inputTokens', 'cacheRead']) ??
    tokenValue(value, ['inputTokenDetails', 'cacheReadTokens']) ??
    tokenValue(value, ['cacheReadTokens']) ??
    tokenValue(value, ['cachedInputTokens'])
  const cacheWrite =
    tokenValue(value, ['inputTokens', 'cacheWrite']) ??
    tokenValue(value, ['inputTokenDetails', 'cacheWriteTokens']) ??
    tokenValue(value, ['cacheWriteTokens'])
  const cachedInputTokens = cacheRead ?? 0
  const cacheWriteTokens = cacheWrite ?? 0
  const tokenCoverage = {
    input: !isNull(input),
    output: !isNull(output),
    cacheRead: !isNull(cacheRead),
    cacheWrite: !isNull(cacheWrite),
  }
  const totalTokens = tokenValue(value, ['totalTokens']) ?? inputTokens + outputTokens
  const validInput =
    !isNull(input) &&
    !isNull(cacheRead) &&
    !isNull(cacheWrite) &&
    cachedInputTokens + cacheWriteTokens <= inputTokens
  const consistentBuckets = isNull(input) || cachedInputTokens + cacheWriteTokens <= inputTokens
  const parts = [
    price(
      validInput ? inputTokens - cachedInputTokens - cacheWriteTokens : null,
      pricing?.inputPerMillion
    ),
    price(consistentBuckets ? cacheRead : null, pricing?.cacheReadPerMillion),
    price(consistentBuckets ? cacheWrite : null, pricing?.cacheWritePerMillion),
    price(output, pricing?.outputPerMillion),
  ]
  const knownCost = parts.reduce<number>((sum, part) => sum + (part ?? 0), 0)
  const complete = parts.every((part) => !isNull(part))
  const costCoverage = complete
    ? 'complete'
    : parts.some((part) => !isNull(part))
      ? 'partial'
      : 'unknown'
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    cacheWriteTokens,
    totalTokens,
    cost: complete ? knownCost : null,
    knownCost,
    costCoverage,
    tokenCoverage,
  }
}

/** 缺席分项为未知；零 token 无需单价。单价必须非负有限。 */
function price(tokens: Nullable<number>, rate: LooseOptional<number>): Nullable<number> {
  if (isNull(tokens)) return null
  if (tokens === 0) return 0
  return isFiniteNumber(rate) && rate >= 0 ? (tokens * rate) / 1_000_000 : null
}

/** 旧账本可保留估计数，但只有明确的完整性证据才能恢复完整费用。 */
export function normalizePersistedUsage(value: Record<string, unknown>): ModelRunUsage {
  const cost = isFiniteNumber(value.cost) && value.cost >= 0 ? value.cost : null
  const knownCost =
    isFiniteNumber(value.knownCost) && value.knownCost >= 0 ? value.knownCost : (cost ?? 0)
  const costCoverage =
    value.costCoverage === 'complete' && !isNull(cost)
      ? 'complete'
      : value.costCoverage === 'partial' || !isNull(cost) || knownCost > 0
        ? 'partial'
        : 'unknown'
  const reported = isPlainObject(value.tokenCoverage) ? value.tokenCoverage : {}
  const tokenCoverage = {
    input: isTrue(reported.input),
    output: isTrue(reported.output),
    cacheRead: isTrue(reported.cacheRead),
    cacheWrite: isTrue(reported.cacheWrite),
  }
  return {
    tokenCoverage,
    inputTokens: positiveNumber(value.inputTokens),
    outputTokens: positiveNumber(value.outputTokens),
    reasoningTokens: positiveNumber(value.reasoningTokens),
    cachedInputTokens: positiveNumber(value.cachedInputTokens),
    cacheWriteTokens: positiveNumber(value.cacheWriteTokens),
    totalTokens: positiveNumber(value.totalTokens),
    cost: costCoverage === 'complete' ? cost : null,
    knownCost,
    costCoverage,
  }
}

/** 合计已知分项；只要有一次费用未知，完整总费用保持 null。 */
export function summarizeUsage(usages: readonly ModelRunUsage[]): ModelUsageSummary {
  let inputTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  let cachedInputTokens = 0
  let cacheWriteTokens = 0
  let totalTokens = 0
  let knownCost = 0
  let unknownCostRuns = 0
  for (const usage of usages) {
    inputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
    reasoningTokens += usage.reasoningTokens
    cachedInputTokens += usage.cachedInputTokens
    cacheWriteTokens += usage.cacheWriteTokens ?? 0
    totalTokens += usage.totalTokens
    knownCost += usage.knownCost ?? usage.cost ?? 0
    if (isNull(usage.cost) || usage.costCoverage !== 'complete') unknownCostRuns++
  }
  const complete = usages.length > 0 && unknownCostRuns === 0
  const tokenCoverage = {
    input: usages.length > 0 && usages.every((usage) => isTrue(usage.tokenCoverage?.input)),
    output: usages.length > 0 && usages.every((usage) => isTrue(usage.tokenCoverage?.output)),
    cacheRead: usages.length > 0 && usages.every((usage) => isTrue(usage.tokenCoverage?.cacheRead)),
    cacheWrite:
      usages.length > 0 && usages.every((usage) => isTrue(usage.tokenCoverage?.cacheWrite)),
  }
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    cacheWriteTokens,
    totalTokens,
    cost: complete ? knownCost : null,
    knownCost,
    costCoverage: complete
      ? 'complete'
      : usages.some(
            (usage) =>
              usage.costCoverage === 'complete' ||
              usage.costCoverage === 'partial' ||
              !isNull(usage.cost)
          )
        ? 'partial'
        : 'unknown',
    unknownCostRuns,
    tokenCoverage,
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
