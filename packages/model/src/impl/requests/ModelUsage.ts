import type { ModelPricingRates, ModelRunUsage, ModelUsageSummary } from '../../types/model'
import { normalizePersistedUsage, normalizeRunUsage, summarizeUsage } from '../../utils/usage'

/** 把 AI SDK 各版本的 usage 形状归一成本包的账本，顺带按单价算钱。 */
export function normalizeModelRunUsage(
  value: unknown,
  pricing?: ModelPricingRates
): ModelRunUsage {
  return normalizeRunUsage(value, pricing)
}

/** 已落盘的稳定 usage envelope 归一化；非法或负数 token 一律闭合为 0。 */
export function normalizePersistedModelUsage(value: Record<string, unknown>): ModelRunUsage {
  return normalizePersistedUsage(value)
}

/** 把多次调用的账本合计起来，并记住最后一轮的上下文占用。 */
export function summarizeModelUsage(usages: readonly ModelRunUsage[]): ModelUsageSummary {
  return summarizeUsage(usages)
}
