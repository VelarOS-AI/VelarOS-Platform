export interface ModelPricingRates {
  readonly inputPerMillion: number | null
  readonly outputPerMillion: number | null
}

export interface ModelRunUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  readonly cachedInputTokens: number
  readonly totalTokens: number
  readonly cost: number | null
}

export interface ModelUsageSummary extends ModelRunUsage {
  readonly runs: number
  readonly lastContextTokens: number
}

/** AI SDK/provider-neutral usage normalization and pricing. */
export function normalizeModelRunUsage(value: unknown, pricing?: ModelPricingRates): ModelRunUsage {
  const inputTokens = tokenValue(value, ['inputTokens', 'total'])
    ?? tokenValue(value, ['inputTokens'])
    ?? 0
  const outputTokens = tokenValue(value, ['outputTokens', 'total'])
    ?? tokenValue(value, ['outputTokens'])
    ?? 0
  const reasoningTokens = tokenValue(value, ['outputTokens', 'reasoning'])
    ?? tokenValue(value, ['reasoningTokens'])
    ?? 0
  const cachedInputTokens = tokenValue(value, ['inputTokens', 'cacheRead'])
    ?? tokenValue(value, ['cachedInputTokens'])
    ?? 0
  const totalTokens = tokenValue(value, ['totalTokens']) ?? inputTokens + outputTokens
  const inputRate = pricing?.inputPerMillion ?? null
  const outputRate = pricing?.outputPerMillion ?? null
  const cost = inputRate === null || outputRate === null
    ? null
    : ((inputTokens * inputRate) + (outputTokens * outputRate)) / 1_000_000
  return { inputTokens, outputTokens, reasoningTokens, cachedInputTokens, totalTokens, cost }
}

/** 已落盘的稳定 usage envelope 归一化；非法/负数 token 失败闭合为 0。 */
export function normalizePersistedModelUsage(value: Record<string, unknown>): ModelRunUsage {
  return {
    inputTokens: positiveNumber(value.inputTokens),
    outputTokens: positiveNumber(value.outputTokens),
    reasoningTokens: positiveNumber(value.reasoningTokens),
    cachedInputTokens: positiveNumber(value.cachedInputTokens),
    totalTokens: positiveNumber(value.totalTokens),
    cost: typeof value.cost === 'number' && Number.isFinite(value.cost) && value.cost >= 0
      ? value.cost
      : null,
  }
}

export function summarizeModelUsage(usages: readonly ModelRunUsage[]): ModelUsageSummary {
  let inputTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  let cachedInputTokens = 0
  let totalTokens = 0
  let cost: number | null = null
  for (const usage of usages) {
    inputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
    reasoningTokens += usage.reasoningTokens
    cachedInputTokens += usage.cachedInputTokens
    totalTokens += usage.totalTokens
    if (usage.cost !== null) cost = (cost ?? 0) + usage.cost
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

function tokenValue(value: unknown, path: readonly string[]): number | null {
  let current = value
  for (const key of path) {
    if (!isRecord(current)) return null
    current = current[key]
  }
  return typeof current === 'number' && Number.isFinite(current) && current >= 0
    ? Math.round(current)
    : null
}

function positiveNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
