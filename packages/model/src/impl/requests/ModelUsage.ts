import type {
  ModelPricingCatalog,
  ModelPricingRates,
  ModelRunUsage,
  ModelUsageSummary,
} from '../../types/model'
import {
  findPricingRates,
  normalizePersistedUsage,
  normalizeRunUsage,
  summarizeUsage,
} from '../../utils/usage'

/**
 * token 账本的归一与合计：把各家 SDK、各个版本的 usage 形状收成本包的一种，顺带按单价算钱。
 *
 * 归一一律闭合为非负整数：账本宁可少算也不能出现负数 token。实例是 `modelUsage`。
 */
export interface ModelUsageApi {
  /** 把 AI SDK 各版本的 usage 形状归一成本包的账本，顺带按单价算钱。 */
  normalizeRunUsage(value: unknown, pricing?: ModelPricingRates): ModelRunUsage
  /** 已落盘的稳定 usage envelope 归一化；非法或负数 token 一律闭合为 0。 */
  normalizePersistedUsage(value: Record<string, unknown>): ModelRunUsage
  /** 把多次调用的账本合计起来，并记住最后一轮的上下文占用。 */
  summarize(usages: readonly ModelRunUsage[]): ModelUsageSummary
  /** 在单价目录里查一个 provider / 模型的单价对；查不到返回 null，账本就如实不算钱。 */
  pricingRates(
    catalog: LooseOptional<ModelPricingCatalog>,
    provider: string,
    model: string
  ): Nullable<ModelPricingRates>
}

export class ModelUsage implements ModelUsageApi {
  public normalizeRunUsage(value: unknown, pricing?: ModelPricingRates): ModelRunUsage {
    return normalizeRunUsage(value, pricing)
  }

  public normalizePersistedUsage(value: Record<string, unknown>): ModelRunUsage {
    return normalizePersistedUsage(value)
  }

  public summarize(usages: readonly ModelRunUsage[]): ModelUsageSummary {
    return summarizeUsage(usages)
  }

  public pricingRates(
    catalog: LooseOptional<ModelPricingCatalog>,
    provider: string,
    model: string
  ): Nullable<ModelPricingRates> {
    return findPricingRates(catalog, provider, model)
  }
}

/** 整个进程共用的账本归一器：无状态。 */
export const modelUsage: ModelUsageApi = new ModelUsage()
